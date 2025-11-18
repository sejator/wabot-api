import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  SessionEvent,
  MessageEvent,
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';

export interface WebhookQueueItem {
  url: string;
  secret: string;
  event: SessionEvent | MessageEvent;
  payload: SessionPayload | MessagePayload;
  isAdmin: boolean;
  createdAt: number;
  retryCount?: number;
}

@Injectable()
export class WebhookQueueService {
  private readonly QUEUE_KEY = 'webhook:queue';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(data: WebhookQueueItem): Promise<void> {
    const payload: WebhookQueueItem = {
      ...data,
      retryCount: data.retryCount ?? 0,
    };

    await this.redis.lpush(this.QUEUE_KEY, JSON.stringify(payload));
  }

  async dequeue(): Promise<WebhookQueueItem | null> {
    const data = await this.redis.rpop(this.QUEUE_KEY);
    return data ? (JSON.parse(data) as WebhookQueueItem) : null;
  }

  async getQueueLength(): Promise<number> {
    return await this.redis.llen(this.QUEUE_KEY);
  }
}
