import Redlock from 'redlock';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
} from 'baileys';
import type { Prisma } from 'generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { Mutex } from 'async-mutex';

/**
 * Refactored Baileys auth state helper using PrismaClient typed.
 *
 * - creds remain in sessions.auth_state
 * - keys persisted per-row in auth_keys using unique (session_id, category, key_id)
 * - persistKeysToDb uses upsert now that unique constraint exists
 *
 * Catatan (ID):
 * - File ini menyediakan helper untuk menyimpan dan memuat state autentikasi Baileys
 *   ke/dari database menggunakan Prisma. Kredensial (creds) disimpan sebagai JSON
 *   di kolom sessions.auth_state, sementara setiap entri kunci disimpan per-baris
 *   di tabel auth_keys (model AuthKey).
 * - Locking untuk penulisan cred menggunakan Redlock jika tersedia, dengan fallback
 *   ke mutex lokal untuk menghindari race condition antar-proses.
 */

type KeysStore = Partial<
  Record<keyof SignalDataTypeMap, Record<string, unknown>>
>;

// Map untuk menyimpan mutex per session agar akses ke sessions.auth_state aman di-proses
const sessionMutexes = new Map<string, Mutex>();
const getSessionMutex = (session_id: string): Mutex => {
  let m = sessionMutexes.get(session_id);
  if (!m) {
    m = new Mutex();
    sessionMutexes.set(session_id, m);
  }
  return m;
};

export const useBaileysAuthState = async (
  prisma: PrismaService,
  session_id: string,
  redlock?: Redlock,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  /** Read creds from Session.auth_state (creds remain here) */
  // Baca kredensial dari kolom sessions.auth_state. Jika tidak ada, inisialisasi default.
  const readCredsFromDb = async (): Promise<AuthenticationCreds> => {
    const row = await prisma.session.findUnique({ where: { id: session_id } });
    if (!row) throw new Error(`session ${session_id} not found`);

    if (!row.auth_state) {
      return initAuthCreds();
    }

    const normalized = JSON.parse(
      JSON.stringify(row.auth_state),
      BufferJSON.reviver,
    ) as { creds?: AuthenticationCreds } | null;

    return normalized?.creds ?? initAuthCreds();
  };

  /** Read keys from auth_keys table for this session */
  // Muat semua baris auth_keys untuk session ini dan bangun struktur keys in-memory.
  const readKeysFromDb = async (): Promise<KeysStore> => {
    const rows = await prisma.authKey.findMany({
      where: { session_id },
    });

    const keys: KeysStore = {};

    for (const r of rows) {
      const category = r.category as keyof SignalDataTypeMap;
      if (!keys[category]) keys[category] = {};
      const revived = JSON.parse(
        JSON.stringify(r.value),
        BufferJSON.reviver,
      ) as unknown;
      // Khusus untuk app-state-sync-key kita coba restore ke proto.Message jika memungkinkan
      if (category === 'app-state-sync-key' && revived) {
        try {
          keys[category][r.key_id] =
            proto.Message.AppStateSyncKeyData.fromObject(
              revived as { [k: string]: any },
            ) as unknown as SignalDataTypeMap[typeof category];
          continue;
        } catch {
          // fallback: biarkan berupa object biasa
        }
      }
      keys[category][r.key_id] = revived;
    }

    return keys;
  };

  /** Persist only creds part into sessions.auth_state */
  // Simpan hanya bagian creds ke kolom sessions.auth_state.
  // Menggunakan Redlock (distributed lock) jika tersedia; jika tidak gunakan mutex lokal.
  const persistCredsToDb = async (creds: AuthenticationCreds) => {
    const serializable = JSON.parse(
      JSON.stringify({ creds }, BufferJSON.replacer),
    ) as unknown as Prisma.InputJsonValue;

    if (!redlock) {
      const m = getSessionMutex(session_id);
      return m.acquire().then(async (release) => {
        try {
          await prisma.session.update({
            where: { id: session_id },
            data: { auth_state: serializable },
          });
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
      console.warn(
        `Redlock.acquire failed for session ${session_id}, fallback ke local mutex: ${String(
          err,
        )}`,
      );
      const m = getSessionMutex(session_id);
      return m.acquire().then(async (release) => {
        try {
          await prisma.session.update({
            where: { id: session_id },
            data: { auth_state: serializable },
          });
        } finally {
          release();
        }
      });
    }

    try {
      await prisma.session.update({
        where: { id: session_id },
        data: { auth_state: serializable },
      });
    } finally {
      if (lock) {
        try {
          await redlock.release(lock);
        } catch (releaseErr) {
          console.warn(
            `Failed to release redlock for session ${session_id}: ${String(
              releaseErr,
            )}`,
          );
        }
      }
    }
  };

  /** Persist individual keys to auth_keys table using upsert (requires unique constraint) */
  // Simpan setiap entri kunci ke tabel auth_keys menggunakan upsert dalam transaksi.
  // Untuk nilai null -> hapus; untuk nilai non-null -> upsert (create/update).
  const persistKeysToDb = async (data: SignalDataSet) => {
    // No-op jika tidak ada data
    if (!data || Object.keys(data).length === 0) return;

    // Jalankan semua upsert/delete dalam satu transaksi untuk konsistensi
    await prisma.$transaction(async (tx) => {
      for (const category of Object.keys(data) as Array<
        keyof SignalDataTypeMap
      >) {
        const items = data[category] as Record<string, any> | undefined;
        if (!items) continue;

        for (const id of Object.keys(items)) {
          const val = items[id] as SignalDataTypeMap[keyof SignalDataTypeMap];

          if (val == null) {
            // Jika null -> hapus entri yang relevan
            await tx.authKey.deleteMany({
              where: { session_id, category: String(category), key_id: id },
            });
            continue;
          }

          // Konversi instance protobuf menjadi objek yang aman untuk JSON jika memungkinkan
          let storeValue: unknown = val;
          if (typeof val === 'object' && val !== null) {
            const obj = val as Record<string, unknown>;
            if ('toJSON' in obj && typeof obj.toJSON === 'function') {
              try {
                storeValue = (obj.toJSON as () => unknown)();
              } catch {
                // fallback: lanjutkan ke pemeriksaan berikutnya
              }
            } else if (
              'toObject' in obj &&
              typeof obj.toObject === 'function'
            ) {
              try {
                storeValue = (obj.toObject as () => unknown)();
              } catch {
                // fallback
              }
            } else {
              try {
                // Coba serialisasi dengan replacer BufferJSON untuk menjaga Buffer/proto
                storeValue = JSON.parse(
                  JSON.stringify(obj, BufferJSON.replacer),
                );
              } catch {
                storeValue = obj;
              }
            }
          }

          const jsonValue = JSON.parse(
            JSON.stringify(storeValue, BufferJSON.replacer),
          ) as Prisma.InputJsonValue;

          // Gunakan upsert berkat adanya unique(session_id, category, key_id)
          const whereUnique: Prisma.AuthKeyWhereUniqueInput = {
            session_id_category_key_id: {
              session_id,
              category: String(category),
              key_id: id,
            },
          };

          await tx.authKey.upsert({
            where: whereUnique,
            create: {
              session_id,
              category: String(category),
              key_id: id,
              value: jsonValue,
            },
            update: {
              value: jsonValue,
              created_at: new Date(),
            },
          });
        }
      }
    });
  };

  // Load initial state
  // Muat creds dan keys saat inisialisasi; ini menjadi state in-memory untuk runtime proses.
  const creds = await readCredsFromDb();
  const keys = await readKeysFromDb();

  // Mutable in-memory store used by Baileys
  const authState: { creds: AuthenticationCreds; keys: KeysStore } = {
    creds,
    keys: keys ?? {},
  };

  // Prepare AuthenticationState for Baileys
  // Membuat objek state yang sesuai ekspektasi Baileys (dengan methods keys.get dan keys.set).
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
        // Update in-memory first
        // Perbarui store in-memory terlebih dahulu agar runtime menggunakan data terbaru
        for (const category of Object.keys(data) as Array<
          keyof SignalDataTypeMap
        >) {
          if (!authState.keys[category]) authState.keys[category] = {};
          const items = data[category] as Record<string, any> | undefined;
          if (!items) continue;

          for (const id of Object.keys(items)) {
            const val = items[id] as SignalDataTypeMap[keyof SignalDataTypeMap];
            if (val == null) {
              // Jika null -> hapus dari store in-memory
              delete authState.keys[category][id];
            } else {
              // Jika object proto, coba convert via toJSON/toObject agar disimpan dalam bentuk plain object
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
                    // jika gagal, lanjut ke cara lain
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
              // Default: simpan apa adanya ke store in-memory
              authState.keys[category][id] = val;
            }
          }
        }

        // Persist keys & creds
        // Setelah memperbarui store in-memory, tulis perubahan ke DB:
        // - keys disimpan per-entri ke tabel auth_keys
        // - creds disimpan ke sessions.auth_state
        await persistKeysToDb(data);
        await persistCredsToDb(authState.creds);
      },
    },
  };

  // saveCreds: helper untuk menyimpan creds saat diperlukan (dipanggil oleh Baileys)
  const saveCreds = async () => {
    await persistCredsToDb(authState.creds);
  };

  return { state, saveCreds };
};
