import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  MessageEvent,
  MessagePayload,
  SessionEvent,
  SessionPayload,
} from 'src/common/types/wabot-event.types';
import { SessionAttributes } from 'src/common/types/session.type';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

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
    if (!attributes?.webhook_status) {
      // this.logger.warn(`Webhook status not enabled for session ${sessionId}`);
      return;
    }

    const secret = attributes.webhook_secret ?? 'default_secret';
    const body = JSON.stringify({ data: payload });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          attributes.webhook_status,
          { data: payload },
          {
            headers: {
              'User-Agent': `SendNotif/1.0 (+${process.env.APP_URL || ''})`,
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
            },
          },
        ),
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!response.data.success)
        throw new BadRequestException(JSON.stringify(response.data));

      this.logger.log(
        `Webhook ${event} sent successfully for session ${sessionId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Webhook failed (${event}) for session ${sessionId}: ${error}`,
      );
    }
  }

  async incomingMessage(
    event: MessageEvent,
    sessionId: string,
    attributes: SessionAttributes | undefined,
    payload: any,
  ): Promise<void> {
    if (!attributes || !attributes.webhook_message) {
      // this.logger.warn(
      //   `Webhook message not enabled for session ${attributes?.webhook_message}`,
      // );
      return;
    }

    const secret = attributes.webhook_secret ?? 'default_secret';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = JSON.stringify({ data: payload });

    // Buat signature HMAC SHA256
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          attributes.webhook_message,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          { data: payload },
          {
            headers: {
              'User-Agent': `SendNotif/1.0 (+${process.env.APP_URL || ''})`,
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
            },
          },
        ),
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!response.data.success)
        throw new BadRequestException(JSON.stringify(response.data));

      this.logger.log(
        `Webhook ${event} sent successfully for session ${sessionId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Webhook failed (${event}) for session ${sessionId}: ${error}`,
      );
    }
  }

  async webhookServerAdmin(
    event: SessionEvent | MessageEvent,
    payload: SessionPayload | MessagePayload,
  ): Promise<void> {
    const secret = process.env.PRIVATE_KEY_SERVER_ADMIN || 'default_secret';
    const webhookUrl = process.env.WEBHOOK_URL_ADMIN;

    if (!webhookUrl) {
      this.logger.warn(
        `WEBHOOK_URL_ADMIN is not set, skipping webhook for ${event}`,
      );
      return;
    }

    const body = JSON.stringify({ data: payload });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    try {
      await firstValueFrom(
        this.httpService.post(
          webhookUrl,
          { data: payload },
          {
            headers: {
              'User-Agent': `SendNotif/1.0 (+${process.env.APP_URL || ''})`,
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
            },
          },
        ),
      );
      this.logger.log(
        `Webhook ${event} sent successfully for session ${payload.session_id}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Webhook failed (${event}) for session ${payload.session_id}: ${error}`,
      );
    }
  }
}
