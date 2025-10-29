import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Mengonversi nilai string atau Date menjadi objek Date yang valid.
 *
 * - Mengembalikan null jika nilai tidak diberikan, null, atau tidak dapat di-parse menjadi tanggal yang valid.
 * - Jika input sudah merupakan objek Date, akan mengembalikannya apa adanya.
 *
 * @param value - Nilai yang akan dikonversi (string | Date | null | undefined).
 * @returns Date jika nilai valid, atau null jika tidak valid/undefined/null.
 *
 * @example
 * toDate('2025-10-21') // -> Date object
 * toDate(new Date())   // -> same Date object
 * toDate('invalid')    // -> null
 */
export function toDate(value?: string | Date | null): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Membaca versi aplikasi dari berkas package.json di direktori kerja saat ini (process.cwd()).
 *
 * Fungsi ini adalah utilitas internal yang mencoba membaca dan mem-parse package.json.
 * Jika terjadi kesalahan (mis. berkas tidak ditemukan atau JSON tidak valid), fungsi
 * akan mengembalikan undefined.
 *
 * @internal
 * @returns Promise yang menyelesaikan ke string versi jika berhasil, atau undefined jika gagal.
 *
 * @example
 * // Jika package.json berisi { "version": "1.2.3" }
 * await readPackageJsonVersion() // -> "1.2.3"
 */
async function readPackageJsonVersion(): Promise<string | undefined> {
  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageData = JSON.parse(packageJsonContent) as { version?: string };
    return packageData.version;
  } catch {
    return undefined;
  }
}

/**
 * Mendapatkan versi aplikasi saat ini dari package.json.
 *
 * Fungsi ini menggunakan readPackageJsonVersion() dan mengembalikan nilai default "0.0.0"
 * jika versi tidak ditemukan atau terjadi kesalahan saat membaca package.json.
 *
 * @returns Promise yang menyelesaikan ke string versi aplikasi (mis. "1.2.3" atau "0.0.0").
 *
 * @example
 * await getAppVersion() // -> "1.2.3" atau "0.0.0" jika tidak tersedia
 */
export async function getAppVersion(): Promise<string> {
  return (await readPackageJsonVersion()) || '0.0.0';
}

/**
 * Menunda eksekusi selama jumlah milidetik yang diberikan.
 *
 * @param ms - Jumlah milidetik untuk menunggu.
 * @returns Promise<void> yang selesai setelah jeda berakhir.
 *
 * @example
 * await delay(1000) // menunggu 1 detik
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mengubah objek error menjadi string yang dapat dibaca.
 * @param err - Objek error yang akan diubah.
 * @returns String yang mewakili error.
 */
export function stringifyError(err: unknown): string {
  if (!err) return 'Unknown error';

  if (typeof err === 'string') return err;

  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }

  if (typeof err === 'object' && err !== null) {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }

    try {
      return JSON.stringify(err);
    } catch {
      return 'Unserializable error object';
    }
  }

  if (
    typeof err === 'number' ||
    typeof err === 'boolean' ||
    typeof err === 'bigint' ||
    typeof err === 'symbol'
  ) {
    return String(err);
  }

  return 'Unknown error format';
}

/**
 * Menghapus entitas HTML dari teks.
 * @param text Teks yang mungkin mengandung entitas HTML
 * @returns Teks tanpa entitas HTML
 */
export function removeHtmlEntities(text: string | null | undefined): string {
  // Jika text adalah null, undefined, atau string kosong, kembalikan string kosong
  if (!text) {
    return '';
  }

  // Menghapus semua entitas HTML (nama, angka, dan hex)
  return text.replace(/&[#a-zA-Z0-9]+;/g, '');
}
