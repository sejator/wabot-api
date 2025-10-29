import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionsModule } from 'src/modules/sessions/sessions.module';
import { BaileysMessageEngine } from 'src/common/interfaces/message/baileys-message.engine';
import { WWebJSMessageEngine } from 'src/common/interfaces/message/wwebjs-message.engine';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [SessionsModule, WebhookModule],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    PrismaService,
    BaileysMessageEngine,
    WWebJSMessageEngine,
  ],
})
export class MessagesModule {}
