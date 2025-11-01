import {
  Injectable,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { delay } from 'src/common/utils/general.util';
import { Prisma } from 'generated/prisma';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import { UpdateSessionDto } from './dto/update-session.dto';
import { Connector } from 'src/common/types/session.type';
import { ConnectorRegistry } from 'src/common/interfaces/engines/connector-registry.service';
import { EngineManager } from 'src/common/interfaces/engines/engine-manager';
import { CreateSessionDto } from './dto/create-session.dto';

/**
 * SessionsService (authState berbasis database) yang mendukung engine:
 * - "baileys"
 * - "wwebjs"
 *
 * Catatan penting:
 * - authState disimpan di database (pada kolom JSON: session.authState).
 *   Untuk lingkungan produksi, sangat disarankan agar data ini dienkripsi.
 * - Pastikan hanya satu proses yang melakukan koneksi ke sebuah sesi
 *   pada waktu yang sama (gunakan Redis lock atau DB advisory lock
 *   jika aplikasi berjalan di beberapa instance).
 */

@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new FileLoggerService(SessionsService.name);
  private readonly reconnectDelayMs =
    parseInt(process.env.DELAY_RESTART || '10', 10) * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectorRegistry: ConnectorRegistry<Connector>,
    private readonly engineRegistry: EngineManager,
  ) {}

  onModuleInit() {
    void this.reconnectOnStartup();
  }

  async find(name: string) {
    const session = await this.prisma.session.findFirst({ where: { name } });
    if (!session) throw new NotFoundException('Session not found');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { auth_state, ...sessionWithoutAuth } = session;
    return sessionWithoutAuth;
  }

  async create(dto: CreateSessionDto) {
    if (!['baileys', 'wwebjs'].includes(dto.engine)) {
      throw new BadRequestException(`Unsupported engine type: ${dto.engine}`);
    }

    try {
      const attributes = dto.attributes
        ? (dto.attributes as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull;

      const session = await this.prisma.session.upsert({
        where: { name: dto.name },
        update: {
          engine: dto.engine,
          attributes,
        },
        create: {
          name: dto.name,
          engine: dto.engine,
          attributes,
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { auth_state, ...sessionWithoutAuth } = session;
      return sessionWithoutAuth;
    } catch (error) {
      console.error('Error saat create/update session:', error);
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async update(id: string, dto: UpdateSessionDto) {
    if (dto.engine && !['baileys', 'wwebjs'].includes(dto.engine)) {
      throw new BadRequestException(`Unsupported engine type: ${dto.engine}`);
    }
    try {
      const attributes = dto.attributes
        ? (dto.attributes as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull;

      const updatedSession = await this.prisma.session.update({
        where: { id },
        data: {
          engine: dto.engine,
          attributes: attributes,
        },
      });

      try {
        // Jika ada konektor aktif, sinkronkan attributes
        const connector = this.connectorRegistry.get(id);
        if (connector) {
          connector.sessionAttributes = updatedSession.attributes as Record<
            string,
            any
          >;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        // ignore
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { auth_state, ...sessionWithoutAuth } = updatedSession;
      return sessionWithoutAuth;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      throw new InternalServerErrorException('Internal server error');
    }
  }

  async connect(session_id: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: session_id },
    });

    if (!session) throw new NotFoundException('Session not found');

    const hashConnectorExists = this.connectorRegistry.has(session_id);
    if (hashConnectorExists) {
      // Jika connector sudah ada di registry, kembalikan langsung
      const connector = this.connectorRegistry.get(session_id);
      if (!connector.isConnected())
        throw new NotFoundException('Session not connected');

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { auth_state, ...sessionWithoutAuth } = session;
      return sessionWithoutAuth;
    } else {
      const engine = this.engineRegistry.get(session.engine ?? 'baileys');
      return engine.connect(session);
    }
  }

  async reconnect(session_id: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: session_id },
    });

    if (!session) throw new NotFoundException('Session not found');

    const connector = this.connectorRegistry.get(session_id);

    if (connector.isConnected()) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { auth_state, ...sessionWithoutAuth } = session;
      return sessionWithoutAuth;
    } else {
      const engine = this.engineRegistry.get(session.engine ?? 'baileys');
      return engine.connect(session);
    }
  }

  async stop(session_id: string) {
    const connector = this.connectorRegistry.get(session_id);
    if (!connector.isConnected())
      throw new BadRequestException('Session is not connected');

    const engine = this.engineRegistry.get(connector.engine);
    return await engine.stop(session_id);
  }

  private async reconnectOnStartup() {
    // on startup, auto-connect all sessions
    await delay(this.reconnectDelayMs);
    const sessions = await this.prisma.session.findMany({
      where: { connected: true },
    });

    for (const s of sessions) {
      const engine = this.engineRegistry.get(s.engine ?? 'baileys');

      if (!engine) {
        continue;
      }

      try {
        this.logger.log(
          `Connecting session [${s.name}] using ${engine.name}...`,
        );
        void engine.connect(s);
      } catch (err) {
        this.logger.error(`Failed to connect session [${s.name}]: ${err}`);
      }

      // Random delay between 1–3 seconds
      const minDelay = 1000;
      const maxDelay = 3000;
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      await delay(randomDelay);
    }
  }
}
