import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  MessageEvent,
  MessagePayload,
  SessionEvent,
  SessionPayload,
} from 'src/common/types/wabot-event.types';
import { SessionAttributes } from 'src/common/types/session.type';
import { AxiosError } from 'axios';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { WebhookQueueService } from './webhook-queue.service';

@Injectable()
export class WebhookService {
  private readonly logger = new FileLoggerService(WebhookService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly queue: WebhookQueueService,
  ) {}

  /**
   * Kirim webhook status pesan (sent, delivered, failed)
   * @param event Jenis event (message_update)
   * @param payload Data pesan (id, to, from, body, status, timestamp, dll)
   */
  async statusMessage(
    event: MessageEvent,
    attributes: SessionAttributes | undefined,
    payload: MessagePayload,
  ): Promise<void> {
    // kirim ke server admin
    this.webhookServerAdmin(event, payload).catch(() => {});

    // kirim ke webhook device (jika url webhook diisi)
    if (!attributes?.webhook_status) return;

    // masukkan ke antrian webhook
    await this.queue.enqueue({
      url: attributes.webhook_status,
      secret: attributes.webhook_secret || 'default_secret',
      event,
      payload,
      isAdmin: false,
      createdAt: Date.now(),
    });
  }

  async incomingMessage(
    event: MessageEvent,
    sessionId: string,
    payload: SessionPayload | MessagePayload,
  ): Promise<string | undefined> {
    // ambil session attributes
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { attributes: true },
    });
    const attributes = session?.attributes as SessionAttributes;
    // kalau url webhook kosong, langsung return
    if (!attributes?.webhook_incoming) return;

    // cek kuota sebelum kirim webhook
    if (attributes.quota === 0) {
      this.logger.warn(`[QUOTA] Session ${sessionId} kuota habis`);
      return undefined;
    }

    const body = JSON.stringify({ data: payload });
    const signature = crypto
      .createHmac('sha256', attributes.webhook_secret || 'default_secret')
      .update(body)
      .digest('hex');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          attributes.webhook_incoming,
          { data: payload },
          {
            headers: {
              'User-Agent': `SendNotif/1.0 (+${process.env.APP_URL || ''})`,
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            timeout: 10000,
          },
        ),
      );

      const body = response.data as { success: boolean; message: string };
      if (!body.success) {
        this.logger.error(
          `[DEVICE] Incoming -> ${attributes.webhook_incoming} gagal untuk session ${sessionId}: ${response.data}`,
        );
        return undefined;
      }

      // Berhasil, kembalikan pesan dari webhook
      return body.message;
    } catch (error) {
      const err = error as AxiosError;
      this.logger.error(
        `[DEVICE] Incoming -> ${attributes.webhook_incoming} gagal untuk session ${sessionId}: ${
          err.response?.status || err.message
        }`,
      );
      return undefined;
    }
  }

  async webhookServerAdmin(
    event: SessionEvent | MessageEvent,
    payload: SessionPayload | MessagePayload,
  ): Promise<void> {
    const secret = process.env.PRIVATE_KEY_SERVER_ADMIN || 'default_secret';
    const webhookUrl = process.env.WEBHOOK_URL_ADMIN;
    if (!webhookUrl) return;

    // masukkan ke antrian webhook
    await this.queue.enqueue({
      url: webhookUrl,
      secret,
      event,
      payload,
      isAdmin: true,
      createdAt: Date.now(),
    });
  }
}
