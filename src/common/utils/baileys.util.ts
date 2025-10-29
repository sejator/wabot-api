import { proto, WAMessage, WASocket } from 'baileys';

/**
 * Format nomor telepon menjadi JID WhatsApp.
 *
 * Aturan format:
 * - Jika isGroup = true: jika string sudah mengandung "@g.us" dikembalikan apa adanya, jika tidak tambahkan "@g.us".
 * - Jika isGroup = false:
 *   - Hapus semua karakter non-digit.
 *   - Jika nomor diawali dengan "0", ganti "0" dengan defaultCountryCode.
 *   - Jika nomor sudah diawali dengan kode negara (defaultCountryCode), gunakan sebagaimana adanya.
 *   - Tambahkan suffix "@s.whatsapp.net" untuk hasil akhir.
 *
 * @param phone - Nomor telepon atau identifier grup.
 * @param defaultCountryCode - Kode negara default yang digunakan saat nomor dimulai dengan "0" (default: "62").
 * @param isGroup - Jika true, format akan menghasilkan JID grup (menggunakan "@g.us"). Default: false.
 * @returns JID WhatsApp yang sudah diformat (mis. "6281234567890@s.whatsapp.net" atau "12345@g.us").
 *
 * @example
 * formatPhoneToJid('08123456789') // -> "628123456789@s.whatsapp.net"
 * formatPhoneToJid('628123456789') // -> "628123456789@s.whatsapp.net"
 * formatPhoneToJid('12345', '62', true) // -> "12345@g.us"
 */
export function formatPhoneToJid(
  phone: string,
  isGroup = false,
  defaultCountryCode = '62',
): string {
  if (isGroup) {
    return phone.includes('@g.us') ? phone : `${phone}@g.us`;
  }
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    return `${defaultCountryCode}${cleaned.slice(1)}@s.whatsapp.net`;
  } else if (cleaned.startsWith(defaultCountryCode)) {
    return `${cleaned}@s.whatsapp.net`;
  } else {
    return `${cleaned}@s.whatsapp.net`;
  }
}

/**
 * Ekstrak informasi pesan dari respon Baileys.
 * @param res - Respon pesan dari Baileys.
 * @returns Kunci pesan (message key) jika ditemukan, atau undefined jika tidak ada.
 */
export function extractMessageBaileys(
  res: WAMessage | undefined,
): proto.IMessageKey | undefined {
  if (!res) return undefined;
  if (res?.key?.id) return res.key;

  const messages = res.message;
  if (!messages) return undefined;

  // older shape: res.message?.conversation
  if (messages?.conversation && res.key) return res.key;
  // older shape: res.message?.extendedTextMessage?.text
  if (messages?.extendedTextMessage?.text && res.key) return res.key;
  // older shape: res.message?.imageMessage?.caption
  if (messages?.imageMessage?.caption && res.key) return res.key;
  // older shape: res.message?.videoMessage?.caption
  if (messages?.videoMessage?.caption && res.key) return res.key;
  // older shape: res.message?.documentMessage?.caption
  if (messages?.documentMessage?.caption && res.key) return res.key;
}

/**
 * Tentukan tipe pesan berdasarkan remoteJid.
 * @param remoteJid - JID tujuan pesan.
 * @returns Tipe pesan: 'individu', 'group', 'broadcast', 'newsletter', atau 'unknown'.
 */
export function getMessageType(
  remoteJid: string,
): 'individu' | 'group' | 'broadcast' | 'newsletter' | 'unknown' {
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return 'individu';
  }

  if (remoteJid.includes('@g.us')) {
    return 'group';
  }

  if (remoteJid.includes('@broadcast') || remoteJid.includes('@status')) {
    return 'broadcast';
  }

  if (remoteJid.includes('@newsletter')) {
    return 'newsletter';
  }

  return 'unknown';
}

export type statusMessageBaileys =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export function mapBaileysStatusMessage(
  status: proto.WebMessageInfo.Status,
): statusMessageBaileys {
  switch (status) {
    case proto.WebMessageInfo.Status.PENDING:
      return 'pending';
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return 'sent';
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return 'delivered';
    case proto.WebMessageInfo.Status.READ:
      return 'read';
    default:
      return 'failed';
  }
}

/**
 * Hapus semua event listener pada socket Baileys
 * @param sock - instance WASocket
 */
export function destroyAllListeners(sock: WASocket) {
  if (!sock?.ev) return;
  sock.ev.removeAllListeners('connection.update');
  sock.ev.removeAllListeners('connection.update');
  sock.ev.removeAllListeners('messages.upsert');
  sock.ev.removeAllListeners('messages.update');

  // Tutup koneksi WebSocket
  void sock.ws.close();
}
