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

@Injectable()
export class WebhookService {
  private readonly logger = new FileLoggerService(WebhookService.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Kirim webhook status pesan (sent, delivered, failed)
   * @param sessionId ID session aktif
   * @param event Jenis event (message_update)
   * @param payload Data pesan (id, to, from, body, status, timestamp, dll)
   */
  async statusMessage(
    event: MessageEvent,
    sessionId: string,
    attributes: SessionAttributes | undefined,
    payload: MessagePayload,
  ): Promise<void> {
    // kirim ke server admin
    this.webhookServerAdmin(event, payload).catch(() => {});

    // kirim ke webhook device (jika url webhook diisi)
    if (!attributes?.webhook_status) return;

    await this.sendWebhook(
      attributes.webhook_status,
      attributes.webhook_secret,
      event,
      payload,
      sessionId,
    );
  }

  async incomingMessage(
    event: MessageEvent,
    sessionId: string,
    attributes: SessionAttributes | undefined,
    payload: SessionPayload | MessagePayload,
  ): Promise<void> {
    if (!attributes?.webhook_message) return;

    await this.sendWebhook(
      attributes.webhook_message,
      attributes.webhook_secret,
      event,
      payload,
      sessionId,
    );
  }

  async webhookServerAdmin(
    event: SessionEvent | MessageEvent,
    payload: SessionPayload | MessagePayload,
  ): Promise<void> {
    const secret = process.env.PRIVATE_KEY_SERVER_ADMIN || 'default_secret';
    const webhookUrl = process.env.WEBHOOK_URL_ADMIN;
    if (!webhookUrl) return;

    await this.sendWebhook(
      webhookUrl,
      secret,
      event,
      payload,
      payload.session_id,
      true,
    );
  }

  /**
   * Fungsi util umum untuk kirim webhook
   */
  private async sendWebhook(
    url: string,
    secret = 'default_secret',
    event: string,
    payload: SessionPayload | MessagePayload,
    sessionId: string,
    isAdmin = false,
  ): Promise<void> {
    const body = JSON.stringify({ data: payload });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          url,
          { data: payload },
          {
            headers: {
              'User-Agent': `SendNotif/1.0 (+${process.env.APP_URL || ''})`,
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
            },
            timeout: 10000, // fail-safe, 10 detik (timeout cepat untuk webhook)
          },
        ),
      );

      this.logger.debug(
        `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook ${event} -> ${url} [${response.status}]`,
      );
    } catch (error) {
      const err = error as AxiosError;
      this.logger.error(
        `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook ${event} gagal untuk session ${sessionId}: ${
          err.response?.status || err.message
        }`,
      );
    }
  }
}
