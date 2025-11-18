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
        // proses 5 item per batch
        for (let i = 0; i < 5; i++) {
          const item = await this.queue.dequeue();
          if (!item) break;
          await this.processWebhook(item);
        }
      } catch (err) {
        this.logger.error(`Worker error: ${(err as Error).message}`);
      } finally {
        setTimeout(() => void processQueue(), 1000);
      }
    };

    await processQueue();
  }

  private async processWebhook(item: WebhookQueueItem): Promise<void> {
    const { url, secret, event, payload, isAdmin } = item;
    const retryCount = item.retryCount ?? 0;

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
        `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook ${event} -> ${url} GAGAL | session ${
          payload.session_id
        } | percobaan ke-${retryCount} | error: ${err.response?.status || err.message}`,
      );

      // maksimal 3 percobaan
      if (retryCount >= 3) {
        this.logger.error(
          `[${isAdmin ? 'ADMIN' : 'DEVICE'}] Webhook ${event} -> ${url} gagal setelah 3x percobaan`,
        );
        return;
      }

      await this.requeueWithDelay(item);
    }
  }

  private async requeueWithDelay(item: WebhookQueueItem) {
    const retry = (item.retryCount ?? 0) + 1;

    const delay = Math.pow(2, retry) * 1000; // exponential backoff: 2s, 4s, 8s

    this.logger.warn(
      `Retry webhook ${item.event} -> ${item.url} dalam ${delay / 1000}s (percobaan ${retry})`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    await this.queue.enqueue({
      ...item,
      retryCount: retry,
    });
  }
}
