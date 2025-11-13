import Redlock from 'redlock';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
} from 'baileys';
import type { AnyBulkWriteOperation, Db, Filter, ObjectId } from 'mongodb';
import { Mutex } from 'async-mutex';

/**
 * Helper auth-state Baileys berbasis MongoDB
 *
 * Koleksi yang digunakan:
 * - sessions: { _id: session_id (string UUID atau ObjectId), id?: string, auth_state?: {...}, created_at?: Date, ... }
 * - auth_keys: { session_id: string, category: string, key_id: string, value: any, created_at?: Date }
 *
 * Catatan:
 * - Helper akan otomatis membuat dokumen session ketika session_id tidak ditemukan
 *   (berguna untuk multi-session ketika session_id adalah UUID).
 * - Pastikan index unik pada auth_keys: { session_id: 1, category: 1, key_id: 1 }.
 *   Helper ini mencoba membuat index tersebut (idempotent).
 */

interface SessionDoc {
  _id: string | ObjectId;
  id?: string;
  auth_state?: unknown;
  created_at?: Date;
  updated_at?: Date;
}

interface AuthKeyDoc {
  session_id: string;
  category: string;
  key_id: string;
  value: unknown;
  created_at?: Date;
}

type KeysStore = Partial<
  Record<keyof SignalDataTypeMap, Record<string, unknown>>
>;

const sessionMutexes = new Map<string, Mutex>();
const getSessionMutex = (session_id: string): Mutex => {
  let m = sessionMutexes.get(session_id);
  if (!m) {
    m = new Mutex();
    sessionMutexes.set(session_id, m);
  }
  return m;
};

export const useBaileysAuthStateMongo = async (
  db: Db,
  session_id: string,
  redlock?: Redlock,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const sessionsCol = db.collection<SessionDoc>('sessions');
  const authKeysCol = db.collection<AuthKeyDoc>('auth_keys');

  try {
    await authKeysCol.createIndex(
      { session_id: 1, category: 1, key_id: 1 },
      { unique: true },
    );
  } catch (err) {
    console.warn(
      'createIndex(auth_keys) warning:',
      String((err as Error).message ?? err),
    );
  }

  const sessionFilter: Filter<SessionDoc> = {
    $or: [{ _id: session_id }, { id: session_id }],
  };

  const readCredsFromDb = async (): Promise<AuthenticationCreds> => {
    const row = await sessionsCol.findOne(sessionFilter);

    if (!row) {
      const newSession: SessionDoc = {
        _id: session_id,
        id: session_id,
        created_at: new Date(),
      };
      try {
        await sessionsCol.insertOne(newSession);
      } catch (err) {
        console.warn(
          `sessions.insertOne warning for ${session_id}: ${String(err)}`,
        );
      }
      return initAuthCreds();
    }

    if (!row.auth_state) {
      return initAuthCreds();
    }

    const normalized = JSON.parse(
      JSON.stringify(row.auth_state),
      BufferJSON.reviver,
    ) as { creds?: AuthenticationCreds } | null;

    return normalized?.creds ?? initAuthCreds();
  };

  const readKeysFromDb = async (): Promise<KeysStore> => {
    const rows = await authKeysCol.find({ session_id }).toArray();
    const keys: KeysStore = {};

    for (const r of rows) {
      const category = r.category as keyof SignalDataTypeMap;
      if (!keys[category]) keys[category] = {};
      const revived = JSON.parse(
        JSON.stringify(r.value),
        BufferJSON.reviver,
      ) as unknown;

      // Penanganan khusus untuk app-state-sync-key: coba restore ke proto.Message.AppStateSyncKeyData
      if (category === 'app-state-sync-key' && revived) {
        try {
          const converted = proto.Message.AppStateSyncKeyData.fromObject(
            revived as { [k: string]: any },
          );
          keys[category][r.key_id] =
            converted as unknown as SignalDataTypeMap[typeof category];
          continue;
        } catch {
          // Jika gagal, fallback simpan sebagai object biasa
        }
      }

      keys[category][r.key_id] = revived as any;
    }

    return keys;
  };

  const persistCredsToDb = async (
    creds: AuthenticationCreds,
  ): Promise<void> => {
    const serializable = JSON.parse(
      JSON.stringify({ creds }),
      BufferJSON.replacer,
    ) as { creds?: AuthenticationCreds } | null;

    if (!redlock) {
      const m = getSessionMutex(session_id);
      return m.acquire().then(async (release) => {
        try {
          await sessionsCol.updateOne(
            sessionFilter,
            { $set: { auth_state: serializable, updated_at: new Date() } },
            { upsert: true },
          );
        } finally {
          release();
        }
      });
    }

    const resource = `locks:session:${session_id}`;
    const ttl = 8000;
    let lock: Redlock.Lock | undefined;
    try {
      lock = await redlock.acquire([resource], ttl);
    } catch (err) {
      // Jika redlock gagal, fallback ke mutex lokal
      console.warn(
        `Redlock.acquire failed for session ${session_id}, fallback to local mutex: ${String(err)}`,
      );
      const m = getSessionMutex(session_id);
      return m.acquire().then(async (release) => {
        try {
          await sessionsCol.updateOne(
            sessionFilter,
            { $set: { auth_state: serializable, updated_at: new Date() } },
            { upsert: true },
          );
        } finally {
          release();
        }
      });
    }

    try {
      await sessionsCol.updateOne(
        sessionFilter,
        { $set: { auth_state: serializable, updated_at: new Date() } },
        { upsert: true },
      );
    } finally {
      if (lock) {
        try {
          await redlock.release(lock);
        } catch (releaseErr) {
          console.warn(
            `Failed to release redlock for session ${session_id}: ${String((releaseErr as Error).message ?? releaseErr)}`,
          );
        }
      }
    }
  };

  const persistKeysToDb = async (data: SignalDataSet): Promise<void> => {
    if (!data || Object.keys(data).length === 0) return;

    const ops: Array<AnyBulkWriteOperation<AuthKeyDoc>> = [];

    for (const category of Object.keys(data) as Array<
      keyof SignalDataTypeMap
    >) {
      const items = data[category] as Record<string, any> | undefined;
      if (!items) continue;

      for (const id of Object.keys(items)) {
        const val = items[id] as SignalDataTypeMap[keyof SignalDataTypeMap];

        if (val == null) {
          ops.push({
            deleteOne: {
              filter: { session_id, category: String(category), key_id: id },
            },
          } as AnyBulkWriteOperation<AuthKeyDoc>);
          continue;
        }

        let storeValue: unknown = val;
        if (typeof val === 'object' && val !== null) {
          const obj = val as Record<string, unknown>;
          if ('toJSON' in obj && typeof obj.toJSON === 'function') {
            try {
              storeValue = (obj.toJSON as () => unknown)();
            } catch {
              // fallback
            }
          } else if ('toObject' in obj && typeof obj.toObject === 'function') {
            try {
              storeValue = (obj.toObject as () => unknown)();
            } catch {
              // fallback
            }
          } else {
            try {
              storeValue = JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
            } catch {
              storeValue = obj;
            }
          }
        }

        const jsonValue = JSON.parse(
          JSON.stringify(storeValue),
          BufferJSON.replacer,
        ) as { creds?: AuthenticationCreds } | null;

        ops.push({
          replaceOne: {
            filter: { session_id, category: String(category), key_id: id },
            replacement: {
              session_id,
              category: String(category),
              key_id: id,
              value: jsonValue,
              created_at: new Date(),
            },
            upsert: true,
          },
        } as AnyBulkWriteOperation<AuthKeyDoc>);
      }
    }

    if (ops.length === 0) return;

    // Lakukan bulkWrite; bukan transaksi multi-dokumen kecuali menggunakan session/transaction MongoDB
    await authKeysCol.bulkWrite(ops, { ordered: false });
  };

  const creds = await readCredsFromDb();
  const keys = await readKeysFromDb();

  const authState: { creds: AuthenticationCreds; keys: KeysStore } = {
    creds,
    keys: keys ?? {},
  };

  const state: AuthenticationState = {
    creds: authState.creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const out = {} as { [id: string]: SignalDataTypeMap[T] };
        const category = type;
        const storeForType = authState.keys?.[category] ?? {};

        for (const id of ids) {
          let value = (storeForType[id] as SignalDataTypeMap[T]) ?? null;

          if (type === 'app-state-sync-key' && value) {
            try {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as { [k: string]: any },
              ) as unknown as SignalDataTypeMap[T];
            } catch {
              // fallback: biarkan value apa adanya
            }
          }
          out[id] = value;
        }

        return Promise.resolve(out);
      },

      set: async (data: SignalDataSet): Promise<void> => {
        for (const category of Object.keys(data) as Array<
          keyof SignalDataTypeMap
        >) {
          if (!authState.keys[category]) authState.keys[category] = {};
          const items = data[category] as Record<string, any> | undefined;
          if (!items) continue;

          for (const id of Object.keys(items)) {
            const val = items[id] as SignalDataTypeMap[keyof SignalDataTypeMap];
            if (val == null) {
              delete authState.keys[category][id];
            } else {
              if (typeof val === 'object' && val !== null) {
                const objWithToJSON = val as Record<string, unknown>;
                if (
                  'toJSON' in objWithToJSON &&
                  typeof objWithToJSON.toJSON === 'function'
                ) {
                  try {
                    authState.keys[category][id] = (
                      objWithToJSON.toJSON as () => unknown
                    )();
                    continue;
                  } catch {
                    // fallback
                  }
                }
                if (
                  'toObject' in objWithToJSON &&
                  typeof objWithToJSON.toObject === 'function'
                ) {
                  try {
                    authState.keys[category][id] = (
                      objWithToJSON.toObject as () => unknown
                    )();
                    continue;
                  } catch {
                    // fallback
                  }
                }
              }
              authState.keys[category][id] = val as unknown as object;
            }
          }
        }

        await persistKeysToDb(data);
        await persistCredsToDb(authState.creds);
      },
    },
  };

  const saveCreds = async (): Promise<void> => {
    await persistCredsToDb(authState.creds);
  };

  return { state, saveCreds };
};
