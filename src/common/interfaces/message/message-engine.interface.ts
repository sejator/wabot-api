import { Message, Session } from 'generated/prisma';
import { Connector } from 'src/common/types/session.type';
import {
  CreateMessageDto,
  CreateImageMessageDto,
  CreateVideoMessageDto,
  CreateDocumentMessageDto,
} from 'src/modules/messages/dto';

export interface IMessageEngine {
  /**
   * Mengirim pesan teks.
   */
  sendText(dto: CreateMessageDto): Promise<Message>;

  /**
   * Mengirim pesan gambar.
   */
  sendImage(dto: CreateImageMessageDto): Promise<Message>;

  /**
   * Mengirim pesan video.
   */
  sendVideo(dto: CreateVideoMessageDto): Promise<Message>;

  /**
   * Mengirim dokumen.
   */
  sendDocument(dto: CreateDocumentMessageDto): Promise<Message>;

  /**
   * Memverifikasi nomor WhatsApp atau group JID.
   */
  verifyJid(
    sessionId: string,
    phone: string,
    isGroup?: boolean,
  ): Promise<{ connector: Connector | null; jid: string | null }>;

  getConnector(
    sessionId: string,
  ): Promise<{ session: Session; connector: Connector }>;
}
