// import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
// import Redlock from 'redlock';
// import { BufferJSON, initAuthCreds, proto } from 'baileys';
// import type {
//   AuthenticationCreds,
//   AuthenticationState,
//   SignalDataTypeMap,
//   SignalDataSet,
// } from 'baileys';
// import type { Prisma } from 'generated/prisma';
// import { PrismaService } from 'src/prisma/prisma.service';
// import { Mutex } from 'async-mutex';

// /**
//  * Helper auth state Baileys yang terhubung ke database, dengan fitur:
//  * - Opsi penggunaan Redis Redlock untuk distributed locking
//  * - Opsi enkripsi AES-256-GCM pada authState sebelum disimpan ke database
//  *
//  * Konfigurasi melalui environment variable:
//  * - AUTH_STATE_ENCRYPTION_KEY: kunci sepanjang 32 byte yang dikodekan dalam base64 (opsional).
//  *   Jika diset, maka authState akan dienkripsi.
//  *
//  * Cara penggunaan:
//  *   const { state, saveCreds } = await useBaileysAuthState(prismaService, session_id, redlock)
//  *   const sock = makeWASocket({ auth: state, ... })
//  *   sock.ev.on('creds.update', saveCreds)
//  *
//  * Catatan keamanan:
//  * - Gunakan kunci yang aman dan dikelola (misalnya melalui KMS atau Vault). Jangan hardcode di kode.
//  * - Helper ini mengenkripsi snapshot hasil serialisasi yang dibuat dengan BufferJSON.replacer
//  *   untuk mempertahankan data buffer/proto.
//  * - Untuk keamanan di lingkungan multi-instance, gunakan Redlock jika tersedia;
//  *   jika akuisisi Redlock gagal, helper akan fallback ke mekanisme mutex lokal dalam proses.
//  */

// /** Types */
// type KeysStore = Partial<
//   Record<keyof SignalDataTypeMap, Record<string, unknown>>
// >;

// const sessionMutexes = new Map<string, Mutex>();
// const getSessionMutex = (session_id: string): Mutex => {
//   let m = sessionMutexes.get(session_id);
//   if (!m) {
//     m = new Mutex();
//     sessionMutexes.set(session_id, m);
//   }
//   return m;
// };

// /** Encryption helpers (AES-256-GCM). Key must be 32 bytes (base64-encoded in env). */
// const ENCRYPTION_KEY_B64 = process.env.AUTH_STATE_ENCRYPTION_KEY || '';
// const ENCRYPTION_KEY = ENCRYPTION_KEY_B64
//   ? Buffer.from(ENCRYPTION_KEY_B64, 'base64')
//   : null;
// const ALGO = 'aes-256-gcm';
// const IV_BYTES = 12; // recommended for GCM
// type EncryptedPayload = {
//   encrypted: true;
//   v: string; // iv base64
//   t: string; // tag base64
//   d: string; // ciphertext base64
// };

// const encryptSnapshot = (snapshot: unknown): EncryptedPayload => {
//   if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
//     throw new Error(
//       'AUTH_STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
//     );
//   }

//   const iv = randomBytes(IV_BYTES);
//   const cipher = createCipheriv(ALGO, ENCRYPTION_KEY, iv, {
//     authTagLength: 16,
//   });
//   const plaintext =
//     typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
//   const encrypted = Buffer.concat([
//     cipher.update(plaintext, 'utf8'),
//     cipher.final(),
//   ]);
//   const tag = cipher.getAuthTag();

//   return {
//     encrypted: true,
//     v: iv.toString('base64'),
//     t: tag.toString('base64'),
//     d: encrypted.toString('base64'),
//   };
// };

// const decryptPayload = (payload: EncryptedPayload): unknown => {
//   if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
//     throw new Error(
//       'AUTH_STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
//     );
//   }

//   const iv = Buffer.from(payload.v, 'base64');
//   const tag = Buffer.from(payload.t, 'base64');
//   const encrypted = Buffer.from(payload.d, 'base64');

//   const decipher = createDecipheriv(ALGO, ENCRYPTION_KEY, iv, {
//     authTagLength: 16,
//   });
//   decipher.setAuthTag(tag);
//   const decrypted = Buffer.concat([
//     decipher.update(encrypted),
//     decipher.final(),
//   ]);
//   const asString = decrypted.toString('utf8');
//   try {
//     return JSON.parse(asString);
//   } catch {
//     return asString;
//   }
// };

// /**
//  * Main exported helper
//  */
// export const useBaileysAuthState = async (
//   prisma: PrismaService,
//   session_id: string,
//   redlock?: Redlock, // optional distributed lock
// ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
//   // read from DB and normalize
//   const readAuthStateFromDb = async (): Promise<{
//     creds: AuthenticationCreds;
//     keys: KeysStore;
//   }> => {
//     const row = await prisma.session.findUnique({ where: { id: session_id } });
//     if (!row) throw new Error(`session ${session_id} not found`);

//     if (!row.auth_state) {
//       return { creds: initAuthCreds(), keys: {} };
//     }

//     // Detect encrypted payload marker
//     const maybe = row.auth_state as unknown;
//     let normalizedRaw: unknown;

//     const isEncryptedPayload = (obj: unknown): obj is EncryptedPayload => {
//       return (
//         typeof obj === 'object' &&
//         obj !== null &&
//         'encrypted' in obj &&
//         (obj as Record<string, unknown>).encrypted === true &&
//         'd' in obj &&
//         typeof (obj as Record<string, unknown>).d === 'string'
//       );
//     };

//     if (isEncryptedPayload(maybe)) {
//       // Encrypted payload: decrypt first
//       try {
//         const payload = maybe;
//         const decrypted = decryptPayload(payload);
//         // decrypted should be the JSON snapshot (string/object) produced with BufferJSON.replacer
//         normalizedRaw = JSON.parse(JSON.stringify(decrypted)); // ensure plain object for reviver below
//       } catch (err) {
//         throw new Error(
//           `failed to decrypt auth_state for session ${session_id}: ${String(err)}`,
//         );
//       }
//     } else {
//       // Plain JSON stored
//       normalizedRaw = row.auth_state;
//     }

//     // stringify+parse using BufferJSON.reviver to recover Buffers/Uint8Array/proto shapes
//     const normalized = JSON.parse(
//       JSON.stringify(normalizedRaw),
//       BufferJSON.reviver,
//     ) as {
//       creds?: AuthenticationCreds;
//       keys?: KeysStore;
//     };

//     const creds = (normalized?.creds as AuthenticationCreds) ?? initAuthCreds();
//     const keys = (normalized?.keys as KeysStore) ?? {};

//     return { creds, keys };
//   };

//   /**
//    * persistAuthStateToDb:
//    * - tries to acquire distributed lock (Redlock) if provided
//    * - if succeed: updates DB then releases lock
//    * - if fails to acquire Redlock (quorum / ExecutionError), falls back to in-process mutex
//    * - in-process mutex (async-mutex) ensures atomic write within this process
//    * - encrypts snapshot if AUTH_STATE_ENCRYPTION_KEY is provided
//    */
//   const persistAuthStateToDb = async (auth_state: {
//     creds: AuthenticationCreds;
//     keys: KeysStore;
//   }) => {
//     // snapshot for Prisma JSON column (use BufferJSON.replacer to preserve buffers)
//     const serializable = JSON.parse(
//       JSON.stringify(auth_state, BufferJSON.replacer),
//     ) as unknown;

//     // optionally encrypt snapshot
//     const toWrite: Prisma.InputJsonValue = ENCRYPTION_KEY
//       ? (encryptSnapshot(serializable) as unknown as Prisma.InputJsonValue)
//       : (serializable as Prisma.InputJsonValue);

//     // If no redlock provided, just use local mutex
//     if (!redlock) {
//       const m = getSessionMutex(session_id);
//       return m.acquire().then(async (release) => {
//         try {
//           await prisma.session.update({
//             where: { id: session_id },
//             data: { auth_state: toWrite },
//           });
//         } finally {
//           release();
//         }
//       });
//     }

//     // Try acquiring distributed lock first
//     const resource = `locks:session:${session_id}`;
//     // TTL: must be larger than expected DB write time; choose 8s (tune as needed)
//     const ttl = 8000;

//     let lock: Redlock.Lock | undefined;
//     try {
//       lock = await redlock.acquire([resource], ttl);
//     } catch (err) {
//       // Acquire failed (likely ExecutionError / quorum not reached).
//       // Don't crash the app — fallback to local mutex and log warning.
//       console.warn(
//         `Redlock.acquire failed for session ${session_id}, falling back to local mutex. error=${String(err)}`,
//       );

//       const m = getSessionMutex(session_id);
//       return m.acquire().then(async (release) => {
//         try {
//           await prisma.session.update({
//             where: { id: session_id },
//             data: { auth_state: toWrite },
//           });
//         } finally {
//           release();
//         }
//       });
//     }

//     // If we acquired the redlock, perform DB update then release it
//     try {
//       await prisma.session.update({
//         where: { id: session_id },
//         data: { auth_state: toWrite },
//       });
//     } finally {
//       if (lock) {
//         try {
//           await redlock.release(lock);
//         } catch (releaseErr) {
//           console.warn(
//             `Failed to release redlock for session ${session_id}: ${String(releaseErr)}`,
//           );
//         }
//       }
//     }
//   };

//   const initial = await readAuthStateFromDb();

//   // mutable object Baileys will mutate in-place
//   const authState: { creds: AuthenticationCreds; keys: KeysStore } = {
//     creds: initial.creds,
//     keys: initial.keys ?? {},
//   };

//   // ensure container exists
//   if (!authState.keys) authState.keys = {};

//   // Build AuthenticationState expected by Baileys
//   const state: AuthenticationState = {
//     creds: authState.creds,
//     keys: {
//       get: async <T extends keyof SignalDataTypeMap>(
//         type: T,
//         ids: string[],
//       ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
//         const out = {} as { [id: string]: SignalDataTypeMap[T] };
//         const category = type;
//         const storeForType = authState.keys?.[category] ?? {};

//         for (const id of ids) {
//           let value = (storeForType[id] as SignalDataTypeMap[T]) ?? null;

//           // special-case for app-state-sync-key proto structure
//           if (type === 'app-state-sync-key' && value) {
//             try {
//               // restore proto object if saved as plain object
//               value = proto.Message.AppStateSyncKeyData.fromObject(
//                 value as { [k: string]: any },
//               ) as unknown as SignalDataTypeMap[T];
//             } catch {
//               // fallback to stored value
//             }
//           }
//           out[id] = value;
//         }

//         return Promise.resolve(out);
//       },

//       set: async (data: SignalDataSet): Promise<void> => {
//         // Merge/replace keys in authState.keys
//         for (const category of Object.keys(data) as Array<
//           keyof SignalDataTypeMap
//         >) {
//           if (!authState.keys[category]) authState.keys[category] = {};
//           const items = data[category] as Record<string, any> | undefined;
//           if (!items) continue;

//           for (const id of Object.keys(items)) {
//             const val = items[id] as SignalDataTypeMap[keyof SignalDataTypeMap];
//             if (val == null) {
//               delete authState.keys[category][id];
//             } else {
//               // Try to convert protobuf instances to plain objects
//               if (typeof val === 'object' && val !== null) {
//                 const objWithToJSON = val as Record<string, unknown>;
//                 if (
//                   'toJSON' in objWithToJSON &&
//                   typeof objWithToJSON.toJSON === 'function'
//                 ) {
//                   try {
//                     const jsonResult = (
//                       objWithToJSON.toJSON as () => unknown
//                     )();
//                     authState.keys[category][id] = jsonResult;
//                     continue;
//                   } catch {
//                     // fallthrough
//                   }
//                 }
//                 if (
//                   'toObject' in objWithToJSON &&
//                   typeof objWithToJSON.toObject === 'function'
//                 ) {
//                   try {
//                     const objectResult = (
//                       objWithToJSON.toObject as () => unknown
//                     )();
//                     authState.keys[category][id] = objectResult;
//                     continue;
//                   } catch {
//                     // fallthrough
//                   }
//                 }
//               }
//               authState.keys[category][id] = val;
//             }
//           }
//         }

//         // persist
//         await persistAuthStateToDb(authState);
//       },
//     },
//   };

//   const saveCreds = async () => {
//     await persistAuthStateToDb(authState);
//   };

//   return { state, saveCreds };
// };

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
 * Helper auth state Baileys tanpa enkripsi.
 * - Menyimpan dan memuat state dari database menggunakan Prisma
 * - Mendukung distributed lock via Redlock (opsional)
 * - Menggunakan async-mutex untuk fallback lokal
 */

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

export const useBaileysAuthState = async (
  prisma: PrismaService,
  session_id: string,
  redlock?: Redlock,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  /** Baca state dari DB */
  const readAuthStateFromDb = async (): Promise<{
    creds: AuthenticationCreds;
    keys: KeysStore;
  }> => {
    const row = await prisma.session.findUnique({ where: { id: session_id } });
    if (!row) throw new Error(`session ${session_id} not found`);

    if (!row.auth_state) {
      return { creds: initAuthCreds(), keys: {} };
    }

    // parse dari JSON dengan BufferJSON.reviver agar Buffers/proto tetap utuh
    const normalized = JSON.parse(
      JSON.stringify(row.auth_state),
      BufferJSON.reviver,
    ) as {
      creds?: AuthenticationCreds;
      keys?: KeysStore;
    };

    return {
      creds: normalized?.creds ?? initAuthCreds(),
      keys: normalized?.keys ?? {},
    };
  };

  /** Simpan state ke DB */
  const persistAuthStateToDb = async (auth_state: {
    creds: AuthenticationCreds;
    keys: KeysStore;
  }) => {
    const serializable = JSON.parse(
      JSON.stringify(auth_state, BufferJSON.replacer),
    ) as unknown as Prisma.InputJsonValue;

    // Fallback ke mutex lokal jika tidak ada redlock
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

    // Jika Redlock tersedia
    const resource = `locks:session:${session_id}`;
    const ttl = 8000;
    let lock: Redlock.Lock | undefined;

    try {
      lock = await redlock.acquire([resource], ttl);
    } catch (err) {
      console.warn(
        `Redlock.acquire failed for session ${session_id}, fallback ke local mutex: ${String(err)}`,
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
            `Failed to release redlock for session ${session_id}: ${String(releaseErr)}`,
          );
        }
      }
    }
  };

  // Muat state awal
  const initial = await readAuthStateFromDb();

  // mutable object
  const authState: { creds: AuthenticationCreds; keys: KeysStore } = {
    creds: initial.creds,
    keys: initial.keys ?? {},
  };

  // Siapkan AuthenticationState untuk Baileys
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

          // special-case for app-state-sync-key proto structure
          if (type === 'app-state-sync-key' && value) {
            try {
              // restore proto object if saved as plain object
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as { [k: string]: any },
              ) as unknown as SignalDataTypeMap[T];
            } catch {
              // fallback to stored value
            }
          }
          out[id] = value;
        }

        return Promise.resolve(out);
      },

      // Menyimpan dengan auto cleanup untuk kategori besar
      set: async (data: SignalDataSet): Promise<void> => {
        const MAX_SESSION_KEYS = 50; // batas jumlah sesi yang disimpan

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
              authState.keys[category][id] = val;
            }
          }

          // Auto cleanup: hapus entry lama pada kategori besar
          const keysCount = Object.keys(authState.keys[category] ?? {}).length;
          if (
            ['session', 'app-state-sync-key', 'sender-key'].includes(
              category,
            ) &&
            keysCount > MAX_SESSION_KEYS
          ) {
            const allKeys = Object.keys(authState.keys[category]);
            const toDelete = allKeys.slice(0, keysCount - MAX_SESSION_KEYS);
            for (const keyId of toDelete)
              delete authState.keys[category][keyId];
          }
        }

        const minimalAuthState = {
          creds: authState.creds,
          keys: {
            // hanya simpan kategori penting
            'pre-key': authState.keys['pre-key'],
            session: authState.keys['session'],
            'app-state-sync-key': authState.keys['app-state-sync-key'],
          },
        };

        await persistAuthStateToDb(minimalAuthState);
      },
    },
  };

  const saveCreds = async () => {
    await persistAuthStateToDb(authState);
  };

  return { state, saveCreds };
};
