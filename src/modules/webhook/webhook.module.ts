import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WebhookService } from './webhook.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { WebhookQueueService } from './webhook-queue.service';
import { WebhookWorkerService } from './webhook-worker.service';

@Module({
  imports: [HttpModule],
  providers: [
    WebhookService,
    PrismaService,
    WebhookQueueService,
    WebhookWorkerService,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
