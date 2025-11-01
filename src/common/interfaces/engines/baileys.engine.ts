import { IEngine } from './engine.interface';
import { AbstractEngine } from './abstract-engine';
import { Prisma, Session } from 'generated/prisma';
import { Inject, Optional } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type Redlock from 'redlock';
import { REDLOCK } from 'src/modules/redis/redis.module';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidNewsletter,
} from 'baileys';
import type { BaileysEventMap, proto, WAVersion } from 'baileys';
import {
  BaileysConnector,
  SessionAttributes,
} from 'src/common/types/session.type';
import { useBaileysAuthState } from 'src/common/utils/use-baileys-auth-state';
import { formatDateTime, getAppVersion } from 'src/common/utils/general.util';
import {
  destroyAllListeners,
  mapBaileysStatusMessage,
} from 'src/common/utils/baileys.util';
import { ConnectorRegistry } from './connector-registry.service';
import { pino } from 'pino';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import {
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';
import { wabot } from 'src/common/events/wabot.events';

const transportLog =
  process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          levelFirst: true,
          translateTime: 'yyyy-mm-dd HH:MM:ss',
        },
      };
const baileysLogger = pino({
  level: process.env.NODE_ENV === 'production' ? 'error' : 'debug',
  transport: transportLog,
});

export class BaileysEngine extends AbstractEngine implements IEngine {
  readonly name = 'baileys';

  private qrRetryCounter = new Map<string, number>();
  private readonly qrTimeout =
    parseInt(process.env.QRCODE_TIME_OUT || '60', 10) * 1000;
  private readonly maxQrRetry = parseInt(
    process.env.QRCODE_MAX_RETRY || '1',
    10,
  );

  constructor(
    readonly prisma: PrismaService,
    private readonly connectorRegistry: ConnectorRegistry<BaileysConnector>,
    readonly webhook: WebhookService,
    @Inject(REDLOCK) @Optional() readonly redlock?: Redlock,
  ) {
    super(prisma, 'BaileysEngine');
  }

  async connect(session: Session): Promise<SessionPayload> {
    const { state, saveCreds } = await useBaileysAuthState(
      this.prisma,
      session.id,
      this.redlock,
    );

    // Bersihkan listener lama jika ada
    try {
      const hasConnector = this.connectorRegistry.has(session.id);
      if (hasConnector) {
        const existingConnector = this.connectorRegistry.get(session.id);
        this.logger.warn(
          `Removing old event listeners for session ${session.id}`,
        );
        destroyAllListeners(existingConnector.wabot);
      }
    } catch (error) {
      this.logger.error(
        `Error while removing old event listeners for session ${session.id}: ${error}`,
      );
    }

    // default version whatsapp
    let versionWhatsapp: WAVersion = [2, 3000, 1027934701];
    try {
      const { version, isLatest } = await fetchLatestBaileysVersion();
      versionWhatsapp = version;
      this.logger.log(
        `Versi WhatsApp v${version.join('.')}, isLatest: ${isLatest}`,
      );
    } catch (error) {
      this.logger.error(`failed to fetch latest Baileys version: ${error}`);
    }

    const versionInfo = await getAppVersion();
    const browser: [string, string, string] = [
      `SendNotif v${versionInfo}`,
      'Chrome',
      versionInfo,
    ];

    // Reset counter setiap kali mencoba connect baru
    this.qrRetryCounter.set(session.id, 0);

    const sock = makeWASocket({
      version: versionWhatsapp,
      generateHighQualityLinkPreview: true,
      qrTimeout: this.qrTimeout,
      printQRInTerminal:
        (process.env.QRCODE_TERMINAL || 'false').toLowerCase() === 'true' &&
        process.env.NODE_ENV !== 'production',
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys),
      },
      browser,
      logger: baileysLogger,
    });

    // Save credentials
    sock.ev.on('creds.update', () => {
      this.logger.debug(`creds.update for session ${session.id}`);
      void saveCreds();

      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'baileys',
        status: 'synchronized',
        timestamp: formatDateTime(new Date()),
      } as SessionPayload;

      wabot.emit('session.synchronized', payload);
      this.webhook
        .webhookServerAdmin('session.synchronized', payload)
        .catch(() => {});
    });

    const qrCodePromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`QR code timeout for session ${session.id}`);
        resolve(null);
      }, this.qrTimeout);

      // Fungsi untuk menangani pembaruan koneksi
      const handleConnectionUpdate = async (
        update: BaileysEventMap['connection.update'],
      ) => {
        const { connection, lastDisconnect, qr } = update;

        // Jika ada QR baru yang dihasilkan
        if (qr) {
          // Update counter
          const currentRetry = this.qrRetryCounter.get(session.id) ?? 0;
          this.qrRetryCounter.set(session.id, currentRetry + 1);

          this.logger.log(
            `QR generated for session ${session.id}, attempt ${currentRetry + 1}`,
          );

          // Cek jika sudah melebihi max retry
          if (currentRetry + 1 > this.maxQrRetry) {
            this.logger.warn(
              `Destroying listeners... Max QR retries exceeded for session ${session.id}`,
            );
            destroyAllListeners(sock);
            this.qrRetryCounter.delete(session.id);
            // Emit session.qr_timeout event
            const payload = {
              session_id: session.id,
              name: session.name,
              engine: session.engine || 'baileys',
              status: 'qr_timeout',
              timestamp: formatDateTime(new Date()),
            } as SessionPayload;

            wabot.emit('session.qr_timeout', payload);
            this.webhook
              .webhookServerAdmin('session.qr_timeout', payload)
              .catch(() => {});

            clearTimeout(timeout);
            resolve(null);
            return;
          }

          try {
            const url = await QRCode.toDataURL(qr);
            if (
              process.env.QRCODE_TERMINAL === 'true' &&
              process.env.NODE_ENV !== 'production'
            ) {
              const qrcodeTerminal = (await import('qrcode-terminal')).default;
              console.log('Scan the QR code below:');
              qrcodeTerminal.generate(qr, { small: true });
            }
            clearTimeout(timeout);
            resolve(url);
          } catch (error) {
            this.logger.error(`Failed to generate QR code: ${error}`);
            // event QR error
            const payload = {
              session_id: session.id,
              name: session.name,
              engine: session.engine || 'baileys',
              status: 'error',
              timestamp: formatDateTime(new Date()),
              message: 'Failed to generate QR code',
            } as SessionPayload;

            wabot.emit('session.error', payload);
            this.webhook
              .webhookServerAdmin('session.error', payload)
              .catch(() => {});

            clearTimeout(timeout);
            resolve(null);
          }
        }

        // Jika koneksi terbuka -> tandai sebagai connected
        if (connection === 'open') {
          await this.prisma.session.update({
            where: { id: session.id },
            data: { connected: true },
          });
          this.logger.log(`Session connected: ${session.id}`);
          this.qrRetryCounter.delete(session.id);

          // event session.connected
          const payload = {
            session_id: session.id,
            name: session.name,
            engine: session.engine || 'baileys',
            status: 'connected',
            timestamp: formatDateTime(new Date()),
          } as SessionPayload;

          wabot.emit('session.connected', payload);
          this.webhook
            .webhookServerAdmin('session.connected', payload)
            .catch(() => {});

          clearTimeout(timeout);
          resolve(null);
        }

        // Jika koneksi ditutup -> bersihkan
        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as Boom)?.output?.statusCode !==
            (DisconnectReason.loggedOut as number);

          if (shouldReconnect) {
            this.logger.warn(`Reconnecting session ${session.id} after 5s...`);
            setTimeout(() => void this.connect(session), 5000);
          } else {
            await this.prisma.session.update({
              where: { id: session.id },
              data: { connected: false, auth_state: Prisma.DbNull },
            });

            this.connectorRegistry.unregister(session.id);
            this.logger.warn(`Session logged out: ${session.id}`);

            // event session.disconnected
            const payload = {
              session_id: session.id,
              name: session.name,
              engine: session.engine || 'baileys',
              status: 'disconnected',
              timestamp: formatDateTime(new Date()),
            } as SessionPayload;

            wabot.emit('session.disconnected', payload);
            this.webhook
              .webhookServerAdmin('session.disconnected', payload)
              .catch(() => {});
          }

          clearTimeout(timeout);
          resolve(null);
        }
      };

      // Fungsi untuk menangani incoming messages (bisa digunakan untuk auto-reply, chatbot, dll)
      const handleMessagesUpsert = async (
        events: BaileysEventMap['messages.upsert'],
      ) => {
        // console.log('recv messages ', JSON.stringify(upsert, undefined, 2));

        for (const msg of events.messages) {
          if (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text
          ) {
            if (
              !msg.key.fromMe &&
              !isJidNewsletter(msg.key?.remoteJid || undefined)
            ) {
              // TODO: implement auto-reply or chatbot logic here
              // console.log('replying to', msg.key.remoteJid);
              // await sock.readMessages([msg.key]);
              // await sendMessageWTyping(
              //   { text: 'Hello there!' },
              //   msg.key.remoteJid!,
              // );
            }
          }
        }
        return Promise.resolve();
      };

      // Fungsi untuk update message status (delivered, read)
      const handleMessageUpdate = async (
        events: BaileysEventMap['messages.update'],
      ) => {
        for (const { key, update } of events) {
          // Lewatkan jika tidak ada status atau ini adalah update polling (bukan status message biasa)
          if (update.status === undefined || update.pollUpdates) continue;

          const newStatus = mapBaileysStatusMessage(
            update.status as proto.WebMessageInfo.Status,
          );

          const data: Record<string, any> = {
            status: newStatus,
          };

          if (newStatus === 'delivered') {
            data.delivered_at = new Date();
          } else if (newStatus === 'read') {
            data.read_at = new Date();
          }

          try {
            await this.prisma.message.updateMany({
              where: {
                session_id: session.id,
                message_id: key.id,
              },
              data,
            });

            const message = await this.prisma.message.findFirst({
              where: {
                session_id: session.id,
                message_id: key.id!,
              },
            });
            if (!message) continue;

            const payload = {
              id: message.id,
              session_id: session.id,
              name: session.name,
              engine: session.engine || 'baileys',
              status: message.status,
              to: message.to,
              content_type: message.content_type,
              direction: message.direction,
              error_message: message.error_message,
              read_at: formatDateTime(message.read_at),
              delivered_at: formatDateTime(message.delivered_at),
              created_at: formatDateTime(message.created_at),
              updated_at: formatDateTime(message.updated_at),
            } as MessagePayload;

            const connector = this.connectorRegistry.get(session.id);

            this.webhook
              .statusMessage(
                'message.updated',
                session.id,
                connector.sessionAttributes,
                payload,
              )
              .catch(() => {});
          } catch (err) {
            this.logger.error(
              `Gagal memperbarui status pesan ${key.id} : ${err}`,
            );
          }
        }
      };

      // Event listeners
      sock.ev.on('connection.update', (update) => {
        void handleConnectionUpdate(update);
      });

      sock.ev.on('messages.upsert', (messages) => {
        void handleMessagesUpsert(messages);
      });

      sock.ev.on('messages.update', (messages) => {
        void handleMessageUpdate(messages);
      });
    });

    const qrCodeUrl = await qrCodePromise;

    if (sock.user || !qrCodeUrl) {
      // Sudah terhubung
      const connector: BaileysConnector = {
        engine: 'baileys',
        wabot: sock,
        sessionId: session.id,
        sessionName: session.name,
        sessionAttributes: session.attributes as SessionAttributes,
        isConnected: () => !!sock?.user,
      };

      this.connectorRegistry.register(connector);
      this.logger.log(
        `Session ${session.id} registered in connector registry.`,
      );

      // event session.connected
      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'baileys',
        status: 'connected',
        timestamp: formatDateTime(new Date()),
      } as SessionPayload;

      // emit ke websocket dan webhook
      wabot.emit('session.connected', payload);
      this.webhook
        .webhookServerAdmin('session.connected', payload)
        .catch(() => {});

      return payload;
    }

    // event QR generated
    const payload = {
      session_id: session.id,
      name: session.name,
      engine: session.engine || 'baileys',
      status: 'qr_generated',
      qrCodeUrl: qrCodeUrl,
      timeout: parseInt(process.env.QRCODE_TIME_OUT || '60', 10) - 3, // untuk sinyal ke client
      timestamp: formatDateTime(new Date()),
    } as SessionPayload;

    // emit ke websocket dan webhook
    wabot.emit('session.qr_generated', payload);
    this.webhook
      .webhookServerAdmin('session.qr_generated', payload)
      .catch(() => {});

    return payload;
  }

  async stop(sessionId: string) {
    const connector = this.connectorRegistry.get(sessionId);
    await connector.wabot.logout();
    this.connectorRegistry.unregister(sessionId);
    await this.updateSessionConnectedState(sessionId, false);

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) return;

    // event session.disconnected
    const payload = {
      session_id: session.id,
      name: session.name,
      engine: session.engine || 'baileys',
      status: 'disconnected',
      timestamp: formatDateTime(new Date()),
    } as SessionPayload;

    wabot.emit('session.disconnected', payload);
    this.webhook
      .webhookServerAdmin('session.disconnected', payload)
      .catch(() => {});
  }
}
