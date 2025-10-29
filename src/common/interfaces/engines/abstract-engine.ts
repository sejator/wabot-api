import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma, Session } from 'generated/prisma';
import { IEngine } from './engine.interface';
import { SessionPayload } from 'src/common/types/wabot-event.types';

/**
 * AbstractEngine
 *
 * Base class untuk semua engine (misal: BaileysEngine, WWebJSEngine, dll).
 * Tidak lagi menyimpan registry global.
 * Setiap instance engine dikelola lewat dependency injection
 * dan diambil via EngineRegistryService.
 */
export abstract class AbstractEngine implements IEngine {
  protected readonly logger: FileLoggerService;

  constructor(
    protected readonly prisma: PrismaService,
    public readonly name: string,
  ) {
    this.logger = new FileLoggerService(name);
  }

  /**
   * Membuat koneksi baru dan menyimpan connector aktif.
   */
  abstract connect(session: Session): Promise<SessionPayload>;

  /**
   * Menghentikan koneksi dan menghapus connector aktif.
   */
  abstract stop(sessionId: string): Promise<void>;

  /**
   * Opsional: Reconnect ke sesi lama tanpa login ulang.
   */
  reconnect?(session: Session): Promise<any>;

  /**
   * Update status koneksi di database.
   */
  protected async updateSessionConnectedState(
    sessionId: string,
    connected: boolean,
  ) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: connected
        ? { connected: true }
        : { connected: false, auth_state: Prisma.DbNull },
    });
  }

  /**
   * Menghapus field `auth_state` sebelum dikirim ke client.
   */
  protected omitAuthState<T extends { auth_state?: unknown }>(
    session: T,
  ): Omit<T, 'auth_state'> {
    const { auth_state, ...safe } = session;
    void auth_state;
    return safe;
  }
}
