import { Injectable, NotFoundException } from '@nestjs/common';
import { AbstractMessageEngine } from './abstract-message-engine';
import { PrismaService } from 'src/prisma/prisma.service';
import { delay, stringifyError } from 'src/common/utils/general.util';
import {
  CreateDocumentMessageDto,
  CreateImageMessageDto,
  CreateMessageDto,
  CreateVideoMessageDto,
} from 'src/modules/messages/dto';
import { Message } from 'generated/prisma';
import mime from 'mime';
import { ConnectorRegistry } from '../engines/connector-registry.service';
import { WWebJSConnector } from 'src/common/types/session.type';
import { MessageMedia } from 'whatsapp-web.js';
import axios from 'axios';
import { MessagePayload } from 'src/common/types/wabot-event.types';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import { formatPhoneToJid } from 'src/common/utils/baileys.util';

@Injectable()
export class WWebJSMessageEngine extends AbstractMessageEngine {
  constructor(
    readonly prisma: PrismaService,
    readonly webhook: WebhookService,
    connectorRegistry: ConnectorRegistry<WWebJSConnector>,
  ) {
    super(prisma, connectorRegistry, 'WWebJSMessageEngine');
  }

  getSanitizedMessage(message: Message) {
    return this.sanitizeMessage(message);
  }

  /**
   * Verifikasi JID untuk nomor WhatsApp atau grup.
   * @param sessionId ID sesi
   * @param phone Nomor telepon
   * @param isGroup Apakah ini grup
   * @returns JID yang terverifikasi atau null
   */
  async verifyJid(
    sessionId: string,
    phone: string,
    isGroup = false,
  ): Promise<{ connector: WWebJSConnector | null; jid: string | null }> {
    const connector = this.getConnector(sessionId) as WWebJSConnector;
    if (!connector) return { connector: null, jid: null };

    try {
      if (!connector) return { connector: null, jid: null };

      const formatJid = formatPhoneToJid(phone, isGroup);
      if (isGroup) return { connector, jid: formatJid };

      // ini masih bermasalah kalo nomor gak terdaftar
      // const isRegistered = await connector.wabot.isRegisteredUser(formatJid);
      // if (isRegistered) return { connector, jid: formatJid };

      return Promise.resolve({ connector, jid: formatJid });
    } catch (err) {
      this.logger.error(`VerifyJid error: ${stringifyError(err)}`);
    }

    return { connector, jid: null };
  }

  /**
   * Mengirim pesan teks.
   * @param dto Data pesan
   * @returns Pesan yang berhasil dikirim
   */
  async sendText(dto: CreateMessageDto) {
    const { connector, jid } = await this.verifyJid(
      dto.session_id,
      dto.phone,
      dto.isGroup,
    );
    if (!connector) throw new NotFoundException('Session not connected');
    if (!jid) throw new NotFoundException('Nomor tidak terdaftar di WhatsApp');

    const message = await this.prisma.message.create({
      data: {
        session_id: dto.session_id,
        to: jid.replace(/@.*/, ''),
        body: dto.message,
        direction: 'outgoing',
        status: 'pending',
        content_type: 'text',
      },
    });

    this.sendTextAsync(dto, message.id, jid, connector).catch(() => {});
    return message;
  }

  /**
   * Mengirim pesan teks secara asinkron.
   * @param dto Data pesan
   * @param messageId ID pesan
   * @param jid JID penerima
   * @param connector Konektor yang digunakan
   * @returns Promise<void>
   */
  private async sendTextAsync(
    dto: CreateMessageDto,
    messageId: string,
    jid: string,
    connector: WWebJSConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot: client } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      const sent = await client.sendMessage(jid, dto.message);

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: sent.id.id,
          remote_id: sent.id._serialized,
          content_type: 'text',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wwebjs',
        status: 'sent',
        to: message.to,
        content_type: 'text',
        direction: 'outgoing',
        created_at: message.created_at,
        updated_at: message.updated_at,
        is_webhook_success: true,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    } catch (error) {
      const errorMsg = stringifyError(error);
      this.logger.error(`Gagal kirim dokumen: ${errorMsg}`);

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'failed', error_message: errorMsg },
        include: { session: true },
      });

      const session = message.session;
      if (!session) return;

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wwebjs',
        status: 'failed',
        to: message.to,
        content_type: 'text',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: message.created_at,
        updated_at: message.updated_at,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    }
  }

  /**
   * Mengirim gambar.
   * @param dto Data pesan
   * @returns Pesan yang berhasil dikirim
   */
  async sendImage(dto: CreateImageMessageDto) {
    const { connector, jid } = await this.verifyJid(
      dto.session_id,
      dto.phone,
      dto.isGroup,
    );
    if (!connector) throw new NotFoundException('Session not connected');
    if (!jid) throw new NotFoundException('Nomor tidak terdaftar di WhatsApp');

    const message = await this.prisma.message.create({
      data: {
        session_id: dto.session_id,
        to: jid.replace(/@.*/, ''),
        body: dto.caption ?? '',
        direction: 'outgoing',
        status: 'pending',
        content_type: 'image',
      },
    });

    this.sendImageAsync(dto, message.id, jid, connector).catch(() => {});
    return message;
  }

  /**
   * Mengirim gambar secara asinkron.
   * @param dto Data pesan
   * @param messageId ID pesan
   * @param jid JID penerima
   * @param connector Konektor yang digunakan
   * @returns Promise<void>
   */
  private async sendImageAsync(
    dto: CreateImageMessageDto,
    messageId: string,
    jid: string,
    connector: WWebJSConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot: client } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      const media = await MessageMedia.fromUrl(dto.image);
      const sent = await client.sendMessage(jid, media, {
        caption: dto.caption ?? '',
      });

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: sent.id.id,
          remote_id: sent.id._serialized,
          content_type: 'image',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wwebjs',
        status: 'sent',
        to: message.to,
        content_type: 'image',
        direction: 'outgoing',
        created_at: message.created_at,
        updated_at: message.updated_at,
        is_webhook_success: true,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    } catch (error) {
      const errorMsg = stringifyError(error);
      this.logger.error(`Gagal kirim dokumen: ${errorMsg}`);

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'failed', error_message: errorMsg },
        include: { session: true },
      });

      const session = message.session;
      if (!session) return;

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wwebjs',
        status: 'failed',
        to: message.to,
        content_type: 'video',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: message.created_at,
        updated_at: message.updated_at,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    }
  }

  /**
   * Mengirim video.
   * @param dto Data pesan
   * @returns Pesan yang berhasil dikirim
   */
  async sendVideo(dto: CreateVideoMessageDto) {
    const { connector, jid } = await this.verifyJid(
      dto.session_id,
      dto.phone,
      dto.isGroup,
    );
    if (!connector) throw new NotFoundException('Session not connected');
    if (!jid) throw new NotFoundException('Nomor tidak terdaftar di WhatsApp');

    const message = await this.prisma.message.create({
      data: {
        session_id: dto.session_id,
        to: jid.replace(/@.*/, ''),
        body: dto.caption ?? '',
        direction: 'outgoing',
        status: 'pending',
        content_type: 'video',
      },
    });

    this.sendVideoAsync(dto, message.id, jid, connector).catch(() => {});
    return message;
  }

  /**
   * Mengirim video secara asinkron.
   * @param dto Data pesan
   * @param messageId ID pesan
   * @param jid JID penerima
   * @param connector Konektor yang digunakan
   * @returns Promise<void>
   */
  private async sendVideoAsync(
    dto: CreateVideoMessageDto,
    messageId: string,
    jid: string,
    connector: WWebJSConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot: client } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      const response = await axios.get(dto.video, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const base64Video = Buffer.from(response.data).toString('base64');
      const media = new MessageMedia('video/mp4', base64Video, 'video.mp4');

      const sent = await client.sendMessage(jid, media, {
        caption: dto.caption ?? '',
        sendMediaAsDocument: true,
      });

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: sent.id.id,
          remote_id: sent.id._serialized,
          content_type: 'video',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wwebjs',
        status: 'sent',
        to: message.to,
        content_type: 'video',
        direction: 'outgoing',
        created_at: message.created_at,
        updated_at: message.updated_at,
        is_webhook_success: true,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    } catch (error) {
      const errorMsg = stringifyError(error);
      this.logger.error(`Gagal kirim dokumen: ${errorMsg}`);

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'failed', error_message: errorMsg },
        include: { session: true },
      });

      const session = message.session;
      if (!session) return;

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wwebjs',
        status: 'failed',
        to: message.to,
        content_type: 'video',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: message.created_at,
        updated_at: message.updated_at,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    }
  }

  /**
   * Mengirim dokumen secara asinkron.
   * @param dto Data pesan
   * @returns Pesan yang berhasil dikirim
   */
  async sendDocument(dto: CreateDocumentMessageDto) {
    const { connector, jid } = await this.verifyJid(
      dto.session_id,
      dto.phone,
      dto.isGroup,
    );
    if (!connector) throw new NotFoundException('Session not connected');
    if (!jid) throw new NotFoundException('Nomor tidak terdaftar di WhatsApp');

    const message = await this.prisma.message.create({
      data: {
        session_id: dto.session_id,
        to: jid.replace(/@.*/, ''),
        body: dto.caption ?? '',
        direction: 'outgoing',
        status: 'pending',
        content_type: 'document',
      },
    });

    this.sendDocumentAsync(dto, message.id, jid, connector).catch(() => {});
    return message;
  }

  /**
   * Mengirim dokumen secara asinkron.
   * @param dto Data pesan
   * @param messageId ID pesan
   * @param jid JID penerima
   * @param connector Konektor yang digunakan
   * @returns Promise<void>
   */
  private async sendDocumentAsync(
    dto: CreateDocumentMessageDto,
    messageId: string,
    jid: string,
    connector: WWebJSConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot: client } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      let filename = dto.filename ?? 'document.pdf';
      if (!filename.includes('.')) filename += '.pdf';
      const mimetype = mime.getType(filename) ?? 'application/pdf';

      const media = await MessageMedia.fromUrl(dto.document);
      media.mimetype = mimetype;
      media.filename = filename;

      const sent = await client.sendMessage(jid, media, {
        caption: dto.caption ?? '',
        sendMediaAsDocument: true,
      });

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: sent.id.id,
          remote_id: sent.id._serialized,
          content_type: 'document',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wwebjs',
        status: 'sent',
        to: message.to,
        content_type: 'document',
        direction: 'outgoing',
        created_at: message.created_at,
        updated_at: message.updated_at,
        is_webhook_success: true,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    } catch (error) {
      const errorMsg = stringifyError(error);
      this.logger.error(`Gagal kirim dokumen: ${errorMsg}`);

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'failed', error_message: errorMsg },
        include: { session: true },
      });

      const session = message.session;
      if (!session) return;

      const payload: MessagePayload = {
        id: message.id,
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'wwebjs',
        status: 'failed',
        to: message.to,
        content_type: 'document',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: message.created_at,
        updated_at: message.updated_at,
      };

      void this.webhook.websocketEvent('message.updated', payload);
    }
  }
}
