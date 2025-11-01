/**
 * Perbaikan yang diusulkan untuk persistensi auth state Baileys dengan Postgres + Prisma
 * - Memperbaiki logika pruning pre-key (jangan bandingkan id pre-key dengan id session).
 * - Membuat validasi pre-key menerima Node Buffer (Buffer adalah subclass dari Uint8Array).
 * - Memperbaiki serialisasi / deserialisasi menggunakan BufferJSON.
 * - Menambahkan komentar dan penjelasan debugging untuk membantu diagnosa PreKeyError.
 *
 */

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
 * - Menyimpan/memuat state dari database via Prisma
 * - Mendukung distributed lock via Redlock (opsional)
 * - Fallback mutex lokal untuk menjaga update bersifat atomic
 */

type KeysStore = Partial<
  Record<keyof SignalDataTypeMap, Record<string, unknown>>
>;

const sessionMutexes = new Map<string, Mutex>();
const getSessionMutex = (sessionId: string): Mutex => {
  let m = sessionMutexes.get(sessionId);
  if (!m) {
    m = new Mutex();
    sessionMutexes.set(sessionId, m);
  }
  return m;
};

const MAX_PRE_KEYS = 500;
const MAX_SESSIONS = 500;
const MAX_SENDER_KEYS = 500;

export const useBaileysAuthState = async (
  prisma: PrismaService,
  sessionId: string,
  redlock?: Redlock,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  /** Membaca state dari database */
  const readAuthStateFromDb = async (): Promise<{
    creds: AuthenticationCreds;
    keys: KeysStore;
  }> => {
    const row = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!row) throw new Error(`Session ${sessionId} not found`);

    // Jika auth_state kosong, kembalikan creds baru
    if (!row.auth_state) {
      return { creds: initAuthCreds(), keys: {} };
    }

    // PENTING:
    // row.auth_state disimpan sebagai JSONB oleh Prisma. Kita perlu mereviver objek-objek yang
    // sebelumnya diserialisasi oleh BufferJSON.replacer. Menggunakan JSON.stringify pada objek
    // yang disimpan di DB lalu JSON.parse dengan BufferJSON.reviver akan mengembalikan Uint8Array / Buffer.
    // (Ini mencerminkan bagaimana kita serialise sebelum menyimpan.)
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

  /** Menyimpan state ke database */
  const persistAuthStateToDb = async (authState: {
    creds: AuthenticationCreds;
    keys: KeysStore;
  }): Promise<void> => {
    // Konversi ke struktur yang dapat diserialisasi JSON menggunakan BufferJSON.replacer
    const serializable = JSON.parse(
      JSON.stringify(authState, BufferJSON.replacer),
    ) as unknown as Prisma.InputJsonValue;

    const updateToDb = async (): Promise<void> => {
      await prisma.session.update({
        where: { id: sessionId },
        data: { auth_state: serializable },
      });
    };

    if (!redlock) {
      // Fallback ke mutex lokal
      const m = getSessionMutex(sessionId);
      const release = await m.acquire();
      try {
        await updateToDb();
      } finally {
        release();
      }
      return;
    }

    // Gunakan distributed lock via Redlock
    const resource = `locks:session:${sessionId}`;
    const ttl = 8000;
    let lock: Redlock.Lock | undefined;
    try {
      lock = await redlock.acquire([resource], ttl);
      await updateToDb();
    } catch (err) {
      console.warn(
        `[AuthState] Redlock.acquire gagal untuk session ${sessionId}, fallback ke local mutex: ${String(
          err,
        )}`,
      );
      const m = getSessionMutex(sessionId);
      const release = await m.acquire();
      try {
        await updateToDb();
      } finally {
        release();
      }
    } finally {
      if (lock) {
        try {
          await redlock.release(lock);
        } catch (releaseErr) {
          console.warn(
            `[AuthState] Gagal release redlock session ${sessionId}: ${String(
              releaseErr,
            )}`,
          );
        }
      }
    }
  };

  // Muat state awal
  const initial = await readAuthStateFromDb();
  const authState: { creds: AuthenticationCreds; keys: KeysStore } = {
    creds: initial.creds,
    keys: initial.keys ?? {},
  };

  /**
   * Type guard aman untuk validasi pre-key
   *
   * CATATAN: Node Buffer adalah subclass dari Uint8Array, jadi pengecekan instanceof Uint8Array
   * juga akan mengembalikan true untuk Buffer. Kita menerima Buffer atau Uint8Array.
   */
  const isValidPreKey = (
    value: unknown,
  ): value is {
    public: { data: Uint8Array | Buffer };
    private: { data: Uint8Array | Buffer };
  } => {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    const publicVal = obj.public as Record<string, unknown> | undefined;
    const privateVal = obj.private as Record<string, unknown> | undefined;
    return (
      (publicVal?.data instanceof Uint8Array ||
        (typeof Buffer !== 'undefined' && Buffer.isBuffer(publicVal?.data))) &&
      (privateVal?.data instanceof Uint8Array ||
        (typeof Buffer !== 'undefined' && Buffer.isBuffer(privateVal?.data)))
    );
  };

  /**
   * Implementasi AuthenticationState Baileys
   */
  const state: AuthenticationState = {
    creds: authState.creds,

    keys: {
      /** Mendapatkan key dari kategori tertentu */
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        const store = authState.keys?.[type] ?? {};

        for (const id of ids) {
          let value = (store[id] as SignalDataTypeMap[T]) ?? null;

          // khusus untuk proto app-state-sync-key, rehydrate menjadi objek protobuf yang
          // diharapkan oleh Baileys
          if (type === 'app-state-sync-key' && value) {
            try {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Record<string, unknown>,
              ) as unknown as SignalDataTypeMap[T];
            } catch {
              // fallback ke value mentah jika fromObject gagal
            }
          }

          out[id] = value;
        }

        return Promise.resolve(out);
      },

      /** Menyimpan key ke database dengan auto cleanup */
      set: async (data: SignalDataSet): Promise<void> => {
        const validCategories: (keyof SignalDataTypeMap)[] = [
          'pre-key',
          'session',
          'sender-key',
          'app-state-sync-key',
        ];

        for (const category of validCategories) {
          const items = data[category];
          if (!items) continue;
          if (!authState.keys[category]) authState.keys[category] = {};

          for (const [id, val] of Object.entries(items)) {
            if (!val || id === 'undefined' || id === 'null') continue;

            // Jika pre-key, validasi bentuk sebelum menyimpan
            if (category === 'pre-key' && !isValidPreKey(val)) {
              // Jika tidak valid, hapus entri yang ada dengan id yang sama untuk menghindari korupsi
              delete authState.keys['pre-key']?.[id];
              continue;
            }

            authState.keys[category][id] = val;
          }

          // Logika pembersihan.
          // FIX PENTING:
          // Sebelumnya kita membandingkan id pre-key dengan id session (dua namespace berbeda)
          // sehingga pre-key yang valid bisa terhapus dan menghasilkan error "Invalid PreKey ID".
          //
          // Sebagai gantinya:
          // - Untuk pre-key: kita mempertahankan MAX_PRE_KEYS entri terbaru dengan mengurutkan id numerik
          //   (id pre-key biasanya string numerik).
          // - Untuk kategori lain: gunakan pemangkasan berbasis urutan insertion (mirip LRU sederhana).
          const keys = Object.keys(authState.keys[category] ?? {});
          const limit =
            category === 'pre-key'
              ? MAX_PRE_KEYS
              : category === 'session'
                ? MAX_SESSIONS
                : category === 'sender-key'
                  ? MAX_SENDER_KEYS
                  : 20;

          if (keys.length > limit) {
            if (category === 'pre-key') {
              // Coba urutkan id numerik naik, lalu hapus yang terlama untuk mempertahankan yang terbaru.
              // Jika id tidak numerik, fallback ke penghapusan berdasarkan urutan insertion.
              const numericKeys = keys.filter((k) => /^\d+$/.test(k));
              if (numericKeys.length >= Math.floor(limit / 2)) {
                const sorted = numericKeys
                  .map((k) => ({ k, n: Number(k) }))
                  .sort((a, b) => a.n - b.n)
                  .map((x) => x.k);

                const toDelete = sorted.slice(0, keys.length - limit);
                for (const delId of toDelete) {
                  delete authState.keys['pre-key']?.[delId];
                }
              } else {
                // fallback: hapus terlama berdasarkan urutan insertion
                const toDelete = keys.slice(0, keys.length - limit);
                for (const delId of toDelete) {
                  delete authState.keys['pre-key']?.[delId];
                }
              }
            } else {
              const toDelete = keys.slice(0, keys.length - limit);
              for (const delId of toDelete) {
                delete authState.keys[category]?.[delId];
              }
            }
          }
        }

        // Persist setelah setiap set agar proses lain cepat melihat pembaruan
        await persistAuthStateToDb({
          creds: authState.creds,
          keys: {
            'pre-key': authState.keys['pre-key'],
            session: authState.keys['session'],
            'app-state-sync-key': authState.keys['app-state-sync-key'],
            'sender-key': authState.keys['sender-key'],
          },
        });
      },
    },
  };

  /** Fungsi untuk menyimpan creds */
  const saveCreds = async (): Promise<void> => {
    await persistAuthStateToDb(authState);
  };

  return { state, saveCreds };
};
