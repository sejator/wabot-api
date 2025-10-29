import { PrismaService } from 'src/prisma/prisma.service';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import { Message } from 'generated/prisma';
import { Connector } from 'src/common/types/session.type';
import { ConnectorRegistry } from '../engines/connector-registry.service';

export abstract class AbstractMessageEngine {
  protected readonly logger: FileLoggerService;

  constructor(
    protected readonly prisma: PrismaService,
    private readonly connectorRegistry: ConnectorRegistry<Connector>,
    public readonly name: string,
  ) {
    this.logger = new FileLoggerService(name);
  }

  abstract sendText(dto: any): Promise<Message>;
  abstract sendImage(dto: any): Promise<Message>;
  abstract sendVideo(dto: any): Promise<Message>;
  abstract sendDocument(dto: any): Promise<Message>;

  /**
   * Verifikasi JID untuk nomor WhatsApp atau grup.
   * @param sessionId ID sesi
   * @param phone Nomor telepon
   * @param isGroup Apakah ini grup
   */
  abstract verifyJid(
    sessionId: string,
    phone: string,
    isGroup?: boolean,
  ): Promise<{ connector: Connector | null; jid: string | null }>;

  /**
   * Ambil connector aktif
   * @param sessionId ID sesi
   * @returns Connector yang terhubung
   */
  protected getConnector(sessionId: string): Connector {
    const connector = this.connectorRegistry.get(sessionId);
    if (!connector)
      throw new Error(`Connector not found for session ${sessionId}`);

    return connector;
  }

  /**
   * Hapus field sensitif dari message sebelum dikembalikan ke API response
   */
  protected sanitizeMessage(message: Message) {
    const { id, session_id, to, direction, status, created_at, updated_at } =
      message;
    return { id, session_id, to, direction, status, created_at, updated_at };
  }
}
