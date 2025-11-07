import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { WebhookQueueItem, WebhookQueueService } from './webhook-queue.service';
import * as crypto from 'crypto';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import { AxiosError } from 'axios';

@Injectable()
export class WebhookWorkerService implements OnModuleInit {
  private readonly logger = new FileLoggerService(WebhookWorkerService.name);

  constructor(
    private readonly http: HttpService,
    private readonly queue: WebhookQueueService,
  ) {}

  onModuleInit() {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    const processQueue = async (): Promise<void> => {
      try {
        // Ambil dan proses beberapa item per batch (misal 5)
        for (let i = 0; i < 5; i++) {
          const item = await this.queue.dequeue();
          if (!item) break;
          await this.processWebhook(item);
        }
      } catch (err) {
        this.logger.error(`Worker error: ${(err as Error).message}`);
      } finally {
        // Jadwalkan lagi setelah 1 detik
        setTimeout(() => {
          void processQueue();
        }, 1000);
      }
    };

    await processQueue();
  }

  private async processWebhook(item: WebhookQueueItem): Promise<void> {
    if (!item) return;

    const { url, secret, event, payload, isAdmin } = item;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify({ data: payload }))
      .digest('hex');

    try {
      const response = await firstValueFrom(
        this.http.post(
          url,
          { data: payload },
          {
            headers: {
              'X-Webhook-Event': event,
              'X-Webhook-Signature': signature,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          },
        ),
      );

      this.logger.debug(
        `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook OK ${event} -> ${url} (${response.status})`,
      );
    } catch (error) {
      const err = error as AxiosError;
      this.logger.error(
        `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook ${event} -> ${url} gagal untuk session ${payload.session_id}: ${
          err.response?.status || err.message
        }`,
      );
    }
  }
}
