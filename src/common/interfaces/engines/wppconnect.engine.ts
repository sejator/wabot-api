import { Injectable, Inject, Optional } from '@nestjs/common';
import { AbstractEngine } from './abstract-engine';
import { IEngine } from './engine.interface';
import { Session } from 'generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConnectorRegistry } from './connector-registry.service';
import {
  SessionAttributes,
  WppConnectConnector,
} from 'src/common/types/session.type';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import type Redlock from 'redlock';
import { REDLOCK } from 'src/modules/redis/redis.module';
import {
  Ack,
  AckType,
  create,
  StatusFind,
  SocketState,
  Message as WppMessage,
  Whatsapp as WppClient,
} from '@wppconnect-team/wppconnect';
import {
  delay,
  formatDateTime,
  stringifyError,
} from 'src/common/utils/general.util';
import { wabot } from 'src/common/events/wabot.events';
import {
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';

type WppStatusFind =
  | StatusFind
  | SocketState
  | 'autocloseCalled'
  | 'browserClose'
  | 'desconnectedMobile'
  | 'inChat'
  | 'isLogged'
  | 'notLogged'
  | 'phoneNotConnected'
  | 'qrReadError'
  | 'qrReadFail'
  | 'qrReadSuccess'
  | 'serverClose';

@Injectable()
export class WppConnectEngine extends AbstractEngine implements IEngine {
  readonly name = 'wppconnect';

  private readonly qrTimeout = 60 * 1000;

  constructor(
    readonly prisma: PrismaService,
    private readonly connectorRegistry: ConnectorRegistry<WppConnectConnector>,
    private readonly webhook: WebhookService,
    @Inject(REDLOCK) @Optional() readonly redlock?: Redlock,
  ) {
    super(prisma, 'WppConnectEngine');
  }

  private async handleStateChange(
    state: WppStatusFind,
    session: Session,
    client?: WppClient,
  ) {
    if (state === 'qrReadSuccess') {
      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        status: 'synchronized',
        timestamp: formatDateTime(new Date()),
      } as SessionPayload;

      wabot.emit('session.synchronized', payload);
      this.webhook
        .webhookServerAdmin('session.synchronized', payload)
        .catch(() => {});
    }

    if (['isLogged', 'inChat'].includes(state) && client) {
      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        status: 'connected',
        timestamp: formatDateTime(new Date()),
      } as SessionPayload;

      wabot.emit('session.connected', payload);
      this.webhook
        .webhookServerAdmin('session.connected', payload)
        .catch(() => {});
    }

    if (
      ['desconnectedMobile', 'serverClose'].includes(state) &&
      session.connected
    ) {
      this.connectorRegistry.unregister(session.id);
      this.logger.warn(`Session logged out: ${session.id}`);

      await this.updateSessionConnectedState(session.id, false);

      const payload: SessionPayload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        status: 'disconnected',
        timestamp: formatDateTime(new Date()),
      };

      wabot.emit('session.disconnected', payload);
      this.webhook
        .webhookServerAdmin('session.disconnected', payload)
        .catch(() => {});
    }

    if (['qrReadError', 'autocloseCalled', 'browserClose'].includes(state)) {
      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        status: 'qr_timeout',
        timestamp: formatDateTime(new Date()),
      } as SessionPayload;

      wabot.emit('session.qr_timeout', payload);
      this.webhook
        .webhookServerAdmin('session.qr_timeout', payload)
        .catch(() => {});
    }
  }

  private async handleAckMessage(session: Session, ack: Ack) {
    let newStatus: 'sent' | 'delivered' | 'read' | 'failed' = 'sent';
    switch (ack.ack) {
      case AckType.SENT:
        newStatus = 'sent';
        break;
      case AckType.RECEIVED:
        newStatus = 'delivered';
        break;
      case AckType.READ:
      case AckType.PLAYED:
        newStatus = 'read';
        break;
      default:
        newStatus = 'failed';
    }

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
          message_id: ack.id._serialized,
        },
        data,
      });

      const message = await this.prisma.message.findFirst({
        where: {
          session_id: session.id,
          message_id: ack.id._serialized,
        },
      });

      if (!message) return;

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        status: newStatus,
        to: message.to,
        content_type: message.content_type,
        direction: 'outgoing',
        error_message: message.error_message,
        read_at: formatDateTime(message.read_at),
        delivered_at: formatDateTime(message.delivered_at),
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
      };

      const connector = this.connectorRegistry.get(session.id);

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
    } catch (err) {
      this.logger.error(
        `Gagal memperbarui status pesan ${session.id} : ${stringifyError(err)}`,
      );
    }
  }

  private async handleIncomingMessage(
    session: Session,
    message: WppMessage,
    client: WppClient,
  ) {
    if (message.body && !message.isGroupMsg) {
      // siapkan payload untuk webhook
      const messageTimestamp = new Date();

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wppconnect',
        from: message.from,
        body: message.body,
        content_type: 'chat',
        direction: 'incoming',
        created_at: formatDateTime(messageTimestamp),
        updated_at: formatDateTime(messageTimestamp),
      };

      const response = await this.webhook.incomingMessage(
        'message.incoming',
        session.id,
        payload,
      );

      if (response === undefined) return;

      // Kirim balasan otomatis
      await client.startTyping(message.from);
      await delay(500);
      await client.setOnlinePresence(true);
      await delay(1000);
      await client.stopTyping(message.from);

      await client.sendText(message.from, response, {
        quotedMsg: message.id,
      });
      await client.sendSeen(message.from);

      // untuk update quota di dashboard admin
      const payloadSent = {
        ...payload,
        to: payload.from,
        is_webhook_success: true,
      };

      this.webhook
        .webhookServerAdmin('message.updated', payloadSent)
        .catch(() => {});
    }
  }

  async connect(session: Session): Promise<SessionPayload> {
    const sessionId = session.id;
    const sessionName = session.name;
    const folderNameToken = process.env.WWEBJS_SESSION_PATH || './.wabot_auth';

    const initializeClient = async (
      session: Session,
      folderNameToken: string,
      resolve: (value: string) => void,
      reject: (reason?: any) => void,
    ) => {
      try {
        let client: WppClient | null = null;
        const configOptions = {
          session: session.id,
          headless: true,
          useChrome: true,
          debug: process.env.NODE_ENV !== 'production',
          folderNameToken: `${folderNameToken}/wppconnect`,
          autoClose: this.qrTimeout,
          statusFind: (statusSession: WppStatusFind) => {
            void this.handleStateChange(
              statusSession,
              session,
              client || undefined,
            );
          },
          browserArgs: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--disable-infobars',
          ],
          puppeteerOptions: {
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--no-zygote',
              '--single-process',
            ],
          },
        };

        if (session.connected) {
          client = await create({
            ...configOptions,
          });
        } else {
          client = await create({
            ...configOptions,
            catchQR: (base64Qrimg: string) => {
              resolve(base64Qrimg);
            },
          });
        }

        const version = await client.getWAVersion();
        this.logger.log(
          `Starting WPPConnect session ${session.id} (version: ${version})`,
        );

        client.onAck((ack) => {
          void this.handleAckMessage(session, ack);
        });

        client.onMessage((message) => {
          void this.handleIncomingMessage(session, message, client);
        });

        const isConnected = await client.isConnected();
        if (isConnected) {
          // sudah terhubung
          this.updateSessionConnectedState(session.id, true).catch(() => {});
          const connector: WppConnectConnector = {
            engine: 'wppconnect',
            wabot: client,
            sessionId: session.id,
            sessionName: session.name,
            sessionAttributes: session.attributes as SessionAttributes,
            isConnected: () => isConnected,
          };

          this.connectorRegistry.register(connector);
          this.logger.log(
            `Session ${session.id} registered in connector registry.`,
          );

          const payload = {
            session_id: session.id,
            name: session.name,
            engine: session.engine || 'wppconnect',
            status: 'connected',
            timestamp: formatDateTime(new Date()),
          } as SessionPayload;

          wabot.emit('session.connected', payload);
          this.webhook
            .webhookServerAdmin('session.connected', payload)
            .catch(() => {});

          resolve('');
        }
      } catch (err) {
        this.logger.error(
          `Error initializing WPPConnect client: ${stringifyError(err)}`,
        );
        reject(err);
      }
    };

    const qrPromise = new Promise<string>((resolve, reject) => {
      void initializeClient(session, folderNameToken, resolve, reject);
    });

    const qrCodeUrl = await qrPromise;

    if (session.connected) {
      return {
        session_id: session.id,
        name: session.name,
        engine: 'wppconnect',
        status: 'connected',
        timestamp: formatDateTime(new Date()),
      };
    }
    const payload: SessionPayload = {
      session_id: sessionId,
      name: sessionName,
      engine: 'wppconnect',
      status: 'qr_generated',
      qrCodeUrl,
      timeout: this.qrTimeout / 1000 - 2,
      timestamp: formatDateTime(new Date()),
    };

    wabot.emit('session.qr_generated', payload);
    this.webhook
      .webhookServerAdmin('session.qr_generated', payload)
      .catch(() => {});

    return payload;
  }

  async stop(sessionId: string) {
    const connector = this.connectorRegistry.get(sessionId);
    if (!connector) return;

    try {
      await connector.wabot.logout();
    } catch (err) {
      this.logger.error(`Error stopping session ${sessionId}: ${err}`);
    }

    this.connectorRegistry.unregister(sessionId);
    await this.updateSessionConnectedState(sessionId, false);

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) return;

    const payload = {
      session_id: session.id,
      name: session.name,
      engine: session.engine || 'wppconnect',
      status: 'disconnected',
      timestamp: formatDateTime(new Date()),
    } as SessionPayload;

    wabot.emit('session.disconnected', payload);
    this.webhook
      .webhookServerAdmin('session.disconnected', payload)
      .catch(() => {});
  }
}
