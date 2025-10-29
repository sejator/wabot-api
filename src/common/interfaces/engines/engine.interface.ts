import { Session } from 'generated/prisma';
import { SessionPayload } from 'src/common/types/wabot-event.types';

export interface IEngine {
  readonly name: string;

  /**
   * Membuat koneksi baru.
   * @param session Session yang akan dihubungkan.
   */
  connect(session: Session): Promise<SessionPayload>;

  /**
   * Menghubungkan kembali sesi yang sudah ada.
   * @param session Session yang akan dihubungkan kembali.
   */
  reconnect?(session: Session): Promise<any>;

  /**
   * Menghentikan koneksi sesi.
   * @param sessionId ID sesi yang akan dihentikan.
   */
  stop(sessionId: string): Promise<void>;
}
