import { Injectable, NotFoundException } from '@nestjs/common';
import { AbstractMessageEngine } from './abstract-message-engine';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  extractMessageBaileys,
  formatPhoneToJid,
  mapBaileysStatusMessage,
} from 'src/common/utils/baileys.util';
import { delay, stringifyError } from 'src/common/utils/general.util';
import { proto, WASocket } from 'baileys';
import {
  CreateDocumentMessageDto,
  CreateImageMessageDto,
  CreateMessageDto,
  CreateVideoMessageDto,
} from 'src/modules/messages/dto';
import { Message } from 'generated/prisma';
import mime from 'mime';
import { ConnectorRegistry } from '../engines/connector-registry.service';
import { BaileysConnector } from 'src/common/types/session.type';
import { MessagePayload } from 'src/common/types/wabot-event.types';
import { WebhookService } from 'src/modules/webhook/webhook.service';

@Injectable()
export class BaileysMessageEngine extends AbstractMessageEngine {
  constructor(
    readonly prisma: PrismaService,
    readonly webhook: WebhookService,
    connectorRegistry: ConnectorRegistry<BaileysConnector>,
  ) {
    super(prisma, connectorRegistry, 'BaileysMessageEngine');
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
  ): Promise<{ connector: BaileysConnector | null; jid: string | null }> {
    const connector = this.getConnector(sessionId) as BaileysConnector;
    if (!connector) return { connector: null, jid: null };

    const formatJid = formatPhoneToJid(phone, isGroup);
    if (isGroup) return { connector, jid: formatJid };

    const check = await connector.wabot.onWhatsApp(formatJid);
    return { connector, jid: check?.[0]?.jid || null };
  }

  private async sendTyping(
    wabot: WASocket,
    jid: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type?: 'text' | 'image' | 'video' | 'document',
  ) {
    await wabot.presenceSubscribe(jid);
    await delay(500);
    await wabot.sendPresenceUpdate('composing', jid);
    await delay(1000);
    await wabot.sendPresenceUpdate('paused', jid);
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
    if (!jid)
      throw new NotFoundException(
        `Nomor tidak terdaftar di WhatsApp : ${dto.phone}`,
      );

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
    connector: BaileysConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'text');
      const result = await wabot.sendMessage(jid, { text: dto.message });

      const extract = extractMessageBaileys(result);
      const status = mapBaileysStatusMessage(
        result?.status as proto.WebMessageInfo.Status,
      );

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: extract?.id,
          remote_id: extract?.remoteJid,
          content_type: 'text',
          status,
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'baileys',
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
      this.logger.error(`Gagal kirim teks: ${errorMsg}`);

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
        engine: session.engine || 'baileys',
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
    if (!jid)
      throw new NotFoundException(
        `Nomor tidak terdaftar di WhatsApp : ${dto.phone}`,
      );

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
    connector: BaileysConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'image');
      const result = await wabot.sendMessage(jid, {
        image: { url: dto.image },
        caption: dto.caption ?? '',
      });

      const extract = extractMessageBaileys(result);
      const status = mapBaileysStatusMessage(
        result?.status as proto.WebMessageInfo.Status,
      );

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: extract?.id,
          remote_id: extract?.remoteJid,
          content_type: 'image',
          status,
        },
      });
      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'baileys',
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
      this.logger.error(`Gagal kirim gambar: ${errorMsg}`);

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
        engine: session.engine || 'baileys',
        status: 'failed',
        to: message.to,
        content_type: 'image',
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
    if (!jid)
      throw new NotFoundException(
        `Nomor tidak terdaftar di WhatsApp : ${dto.phone}`,
      );

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
    connector: BaileysConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'video');
      const result = await wabot.sendMessage(jid, {
        video: { url: dto.video },
        caption: dto.caption ?? '',
      });

      const extract = extractMessageBaileys(result);
      const status = mapBaileysStatusMessage(
        result?.status as proto.WebMessageInfo.Status,
      );

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: extract?.id,
          remote_id: extract?.remoteJid,
          content_type: 'video',
          status,
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'baileys',
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
      this.logger.error(`Gagal kirim video: ${errorMsg}`);

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
        engine: session.engine || 'baileys',
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
    if (!jid)
      throw new NotFoundException(
        `Nomor tidak terdaftar di WhatsApp : ${dto.phone}`,
      );

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
    connector: BaileysConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      let filename = dto.filename ?? 'document.pdf';
      if (!filename.includes('.')) filename += '.pdf';
      const mimetype = mime.getType(filename) ?? 'application/pdf';

      await this.sendTyping(wabot, jid, 'document');
      const result = await wabot.sendMessage(jid, {
        document: { url: dto.document },
        mimetype,
        fileName: filename,
        caption: dto.caption ?? '',
      });

      const extract = extractMessageBaileys(result);
      const status = mapBaileysStatusMessage(
        result?.status as proto.WebMessageInfo.Status,
      );

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: extract?.id,
          remote_id: extract?.remoteJid,
          content_type: 'document',
          status,
        },
      });
      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'baileys',
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
        engine: session.engine || 'baileys',
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
