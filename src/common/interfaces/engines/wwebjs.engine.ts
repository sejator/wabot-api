import { Injectable, Inject, Optional } from '@nestjs/common';
import { AbstractEngine } from './abstract-engine';
import { IEngine } from './engine.interface';
import { Prisma, Session } from 'generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConnectorRegistry } from './connector-registry.service';
import {
  SessionAttributes,
  WWebJSConnector,
} from 'src/common/types/session.type';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import type Redlock from 'redlock';
import { REDLOCK } from 'src/modules/redis/redis.module';
import { Client, LocalAuth, Message, MessageAck } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import {
  delay,
  formatDateTime,
  getAppVersion,
  stringifyError,
} from 'src/common/utils/general.util';
import * as path from 'path';
import {
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';
import { mapWwebjsStatusMessage } from 'src/common/utils/wwebjs.util';
import { wabot } from 'src/common/events/wabot.events';

@Injectable()
export class WWebJSEngine extends AbstractEngine implements IEngine {
  readonly name = 'wwebjs';

  private readonly qrTimeout =
    parseInt(process.env.QRCODE_TIME_OUT || '60', 10) * 1000;
  private readonly maxQrRetry = parseInt(
    process.env.QRCODE_MAX_RETRY || '1',
    10,
  );

  // safety: ensure global handlers installed only once across instances
  private static globalHandlersInstalled = false;

  constructor(
    readonly prisma: PrismaService,
    private readonly connectorRegistry: ConnectorRegistry<WWebJSConnector>,
    private readonly webhook: WebhookService,
    @Inject(REDLOCK) @Optional() readonly redlock?: Redlock,
  ) {
    super(prisma, 'WWebJSEngine');

    // Install global process handlers once to avoid process exit on uncaught errors.
    // This is a safety-net — prefer local try/catch handling for specific operations.
    if (!WWebJSEngine.globalHandlersInstalled) {
      process.on('uncaughtException', (err: any) => {
        try {
          this.logger.error(
            `UncaughtException caught by WWebJSEngine global handler: ${stringifyError(
              err,
            )}`,
          );
        } catch {
          // swallow if logger fails
          this.logger.error(`UncaughtException: ${err}`);
        }
        // Do not rethrow to avoid process exit here; let external supervisor handle restarts if needed.
      });

      process.on('unhandledRejection', (reason: any) => {
        try {
          this.logger.error(
            `UnhandledRejection caught by WWebJSEngine global handler: ${stringifyError(
              reason,
            )}`,
          );
        } catch {
          this.logger.error(`UnhandledRejection: ${reason}`);
        }
      });

      WWebJSEngine.globalHandlersInstalled = true;
    }
  }

  private async handleClientReady(session: Session, client: Client) {
    this.logger.log(`Session ${session.id} connected.`);
    const debugWWebVersion = await client.getWWebVersion();
    this.logger.log(`Versi WhatsApp v${debugWWebVersion}`);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { connected: true },
    });

    const connector: WWebJSConnector = {
      engine: 'wwebjs',
      wabot: client,
      sessionId: session.id,
      sessionName: session.name,
      sessionAttributes: session.attributes as SessionAttributes,
      isConnected: () => client.info?.platform !== undefined,
    };

    this.connectorRegistry.register(connector);
    this.logger.log(`Session ${session.id} registered in connector registry.`);
  }

  /**
   * Menangani event disconnect dari WWebJS Client.
   *
   * - Menutup semua resource (page & browser).
   * - Menghapus auth state hanya jika logout manual.
   * - Menandai session sebagai disconnected di DB.
   * - Membersihkan registry.
   */
  private async handleClientDisconnected(
    sessionId: string,
    reason: string,
    client: Client,
  ) {
    this.logger.warn(`Session ${sessionId} disconnected: ${reason}`);

    try {
      // Tutup page & browser jika masih hidup
      if (client.pupPage && !client.pupPage.isClosed()) {
        await client.pupPage.close().catch(() => null);
      }

      if (client.pupBrowser && client.pupBrowser.isConnected()) {
        await client.pupBrowser.close().catch(() => null);
      }

      await client.destroy().catch(() => null);

      // Hapus folder auth kalau logout manual ATAU gagal login QR
      if (
        reason?.toUpperCase().includes('LOGOUT') ||
        reason?.toUpperCase().includes('QRCODE') ||
        reason?.toUpperCase().includes('RETRIES')
      ) {
        // await this.removeAuthState(sessionId);
        this.logger.warn(
          `Auth state for ${sessionId} removed due to ${reason}.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Error during client cleanup for ${sessionId}: ${stringifyError(err)}`,
      );
    } finally {
      // Update status session di database
      await this.prisma.session
        .update({
          where: { id: sessionId },
          data: { connected: false, auth_state: Prisma.DbNull },
        })
        .catch((dbErr) =>
          this.logger.warn(
            `Failed updating session state for ${sessionId}: ${stringifyError(dbErr)}`,
          ),
        );

      // Unregister dari registry internal
      if (this.connectorRegistry.has(sessionId)) {
        this.connectorRegistry.unregister(sessionId);
        this.logger.warn(`Session ${sessionId} cleaned up from registry.`);
      }
    }
  }

  private handleClientError(sessionId: string, error: any) {
    try {
      if (String(error).includes('TimeoutError')) {
        this.logger.warn(
          `Ignoring Puppeteer TimeoutError for session ${sessionId}`,
        );
        return;
      }

      this.logger.error(`Session ${sessionId} error: ${stringifyError(error)}`);
    } catch (err) {
      this.logger.error(
        `Failed to handle client error for session ${sessionId}: ${stringifyError(err)}`,
      );
    }
  }

  private async handleMessageReceived(sessionId: string, msg: Message) {
    if (!msg.fromMe && msg.body) {
      const connector = this.connectorRegistry.get(sessionId);

      const payload: MessagePayload = {
        id: msg.id.id,
        session_id: sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wwebjs',
        from: msg.from,
        body: msg.body,
        content_type: msg.type,
        direction: 'incoming',
        created_at: formatDateTime(
          msg.timestamp ? new Date(msg.timestamp * 1000) : null,
        ),
        updated_at: formatDateTime(
          msg.timestamp ? new Date(msg.timestamp * 1000) : null,
        ),
      };

      const response = await this.webhook.incomingMessage(
        'message.incoming',
        sessionId,
        payload,
      );

      if (response === undefined) return;

      const chat = await msg.getChat();
      await chat.sendStateTyping();
      await delay(2000);
      await chat.clearState();

      // Kirim balasan otomatis
      await msg.reply(response);
      await connector.wabot.sendSeen(msg.from);

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

  private async handleMessageAck(
    sessionId: string,
    msg: Message,
    ack: MessageAck,
  ) {
    if (msg.fromMe) {
      const messageId = msg.id.id;
      try {
        const newStatus = mapWwebjsStatusMessage(ack);

        const data: Record<string, any> = {
          status: newStatus,
        };

        if (newStatus === 'delivered') {
          data.delivered_at = new Date();
        } else if (newStatus === 'read') {
          data.read_at = new Date();
        }

        await this.prisma.message.updateMany({
          where: {
            session_id: sessionId,
            message_id: messageId,
          },
          data,
        });
        const message = await this.prisma.message.findFirst({
          where: {
            session_id: sessionId,
            message_id: messageId,
          },
        });
        if (!message) return;

        const session = await this.prisma.session.findUnique({
          where: { id: sessionId },
        });
        if (!session) return;

        const payload = {
          id: message.id,
          session_id: sessionId,
          name: session.name,
          engine: session.engine || 'wwebjs',
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

        const connector = this.connectorRegistry.get(sessionId);

        this.webhook
          .statusMessage(
            'message.updated',
            sessionId,
            connector.sessionAttributes,
            payload,
          )
          .catch(() => {});
      } catch (error) {
        this.logger.error(
          `Gagal memperbarui status pesan ${messageId} : ${error}`,
        );
      }
    }
  }

  async connect(session: Session): Promise<SessionPayload> {
    const sessionId = session.id;
    const sessionName = session.name;
    const versionInfo = await getAppVersion();

    const client = new Client({
      authTimeoutMs: this.qrTimeout,
      qrMaxRetries: this.maxQrRetry,
      deviceName: `SendNotif v${versionInfo}`,
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: process.env.WWEBJS_SESSION_PATH || './.wabot_auth',
      }),
      puppeteer: {
        headless: process.env.WWEBJS_PUPPETEER_HEADLESS !== 'false',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    // Setup event listeners
    client.on('ready', () => {
      void this.handleClientReady(session, client);
    });

    client.on('disconnected', (reason) => {
      void this.handleClientDisconnected(sessionId, reason, client);
      // console.log(`Client disconnected:`, { reason });

      try {
        if (reason && reason.toLowerCase().includes('max qr')) {
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
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        // swallow errors here
      }

      try {
        if (reason === 'LOGOUT') {
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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        // swallow errors here
      }
    });

    client.on(
      'error',
      (error) => void this.handleClientError(sessionId, error),
    );

    client.on(
      'message',
      (msg) => void this.handleMessageReceived(sessionId, msg),
    );

    client.on(
      'message_ack',
      (msg, ack) => void this.handleMessageAck(sessionId, msg, ack),
    );

    client.on('authenticated', () => {
      this.logger.log(`Session ${sessionName} authenticated`);
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

    client.on('loading_screen', (percent: number, message: string) => {
      this.logger.log(
        `Session ${sessionName} loading screen: ${percent}% - ${message}`,
      );
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

    client.on('auth_failure', (msg) =>
      this.logger.warn(`Auth failed for ${sessionName}: ${msg}`),
    );

    let qrCodeUrl = '';
    const handleQrCode = async (qr: string) => {
      try {
        this.logger.log(`QR code generated for session ${sessionName}`);
        qrCodeUrl = await QRCode.toDataURL(qr);
        if (
          process.env.QRCODE_TERMINAL === 'true' &&
          process.env.NODE_ENV !== 'production'
        ) {
          const qrcodeTerminal = (await import('qrcode-terminal')).default;
          qrcodeTerminal.generate(qr, { small: true });
        }
      } catch (err) {
        this.logger.error(`Failed to generate QR: ${err}`);
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
      }
    };

    const waitForReadyOrQr = new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      client.once('qr', async (qr: string) => {
        await handleQrCode(qr);
        resolve();
      });

      client.once('ready', () => {
        this.logger.log(`Session ${sessionName} is ready`);
        qrCodeUrl = '';

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
        resolve();
      });
    });

    // Initialize the client and guard against Puppeteer TimeoutError or hanging waits.
    try {
      // await initialize and wait for either qr/ready - make sure to catch timeout for waitForReadyOrQr
      await client.initialize();

      // Defensive timeout: wait either for event or for a configured timeout + small buffer
      await Promise.race([
        waitForReadyOrQr,
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `WWebJS waitForReadyOrQr exceeded ${this.qrTimeout + 5000}ms`,
                ),
              ),
            this.qrTimeout + 5000,
          ),
        ),
      ]);
    } catch (err) {
      // Handle known Puppeteer TimeoutError or other init errors gracefully so server doesn't crash
      const errStr = stringifyError(err);
      if (
        String(err).includes('TimeoutError') ||
        errStr.includes('waitForReadyOrQr')
      ) {
        this.logger.warn(
          `Puppeteer init/wait timeout for session ${sessionName}: ${errStr}`,
        );

        // Emit a session.error or qr_timeout depending on context
        const payload = {
          session_id: session.id,
          name: session.name,
          engine: session.engine || 'baileys',
          status: 'error',
          timestamp: formatDateTime(new Date()),
          message: 'Initialization timed out (Puppeteer Timeout).',
        } as SessionPayload;

        wabot.emit('session.error', payload);
        this.webhook
          .webhookServerAdmin('session.error', payload)
          .catch(() => {});

        // Do not rethrow - return a payload to caller so server flow continues
        return payload;
      }

      // Other errors: log and emit but don't rethrow
      this.logger.error(`Failed to initialize WWebJS client: ${errStr}`);
      const payload = {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'baileys',
        status: 'error',
        timestamp: formatDateTime(new Date()),
        message: `Initialization failed: ${errStr}`,
      } as SessionPayload;

      wabot.emit('session.error', payload);
      this.webhook.webhookServerAdmin('session.error', payload).catch(() => {});

      return payload;
    }

    // Tunggu hingga event 'ready' atau 'qr' diterima — sudah selesai succesfully
    if (session.connected && qrCodeUrl === '') {
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
      timeout: 60 - 3, // ini sudah fix untuk wwebjs default timeout 60s dikurangi proses generate qr
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
    await connector.wabot.destroy();
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
      engine: session.engine || 'wwebjs',
      status: 'disconnected',
      timestamp: formatDateTime(new Date()),
    } as SessionPayload;

    wabot.emit('session.disconnected', payload);
    this.webhook
      .webhookServerAdmin('session.disconnected', payload)
      .catch(() => {});
  }

  /**
   * Menghapus status autentikasi untuk sebuah sesi dengan cara menghapus folder session-nya.
   * @param sessionId ID sesi yang ingin dihapus status autentikasinya.
   */
  private async removeAuthState(sessionId: string) {
    const fs = await import('fs/promises');

    const sessionPath = path.join(
      process.env.WWEBJS_SESSION_PATH || './.wabot_auth',
      `session-${sessionId}`,
    );
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
      this.logger.log(`Session folder deleted: ${sessionPath}`);
    } catch (err) {
      this.logger.warn(
        `Failed to delete session folder for ${sessionId}: ${stringifyError(err)}`,
      );
    }
  }
}
