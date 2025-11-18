import { Injectable, NotFoundException } from '@nestjs/common';
import { AbstractMessageEngine } from './abstract-message-engine';
import { PrismaService } from 'src/prisma/prisma.service';
import { formatPhoneToJid } from 'src/common/utils/baileys.util';
import {
  delay,
  formatDateTime,
  stringifyError,
} from 'src/common/utils/general.util';
import {
  CreateDocumentMessageDto,
  CreateImageMessageDto,
  CreateMessageDto,
  CreateVideoMessageDto,
} from 'src/modules/messages/dto';
import { Message } from 'generated/prisma';
import { ConnectorRegistry } from '../engines/connector-registry.service';
import { WppConnectConnector } from 'src/common/types/session.type';
import { MessagePayload } from 'src/common/types/wabot-event.types';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import { isString } from 'class-validator';
import { Whatsapp } from '@wppconnect-team/wppconnect';

@Injectable()
export class WppConnectMessageEngine extends AbstractMessageEngine {
  constructor(
    readonly prisma: PrismaService,
    readonly webhook: WebhookService,
    connectorRegistry: ConnectorRegistry<WppConnectConnector>,
  ) {
    super(prisma, connectorRegistry, 'WppConnectMessageEngine');
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
  ): Promise<{ connector: WppConnectConnector | null; jid: string | null }> {
    const connector = this.getConnector(sessionId) as WppConnectConnector;
    if (!connector) return { connector: null, jid: null };

    const formatJid = formatPhoneToJid(phone, isGroup);
    if (isGroup) return { connector, jid: formatJid };

    const check = await connector.wabot.checkNumberStatus(formatJid);
    return { connector, jid: check?.numberExists ? formatJid : null };
  }

  private async sendTyping(
    wabot: Whatsapp,
    jid: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type?: 'text' | 'image' | 'video' | 'document',
  ) {
    await wabot.startTyping(jid);
    await delay(500);
    await wabot.setOnlinePresence(true);
    await delay(1000);
    await wabot.stopTyping(jid);
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
    connector: WppConnectConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'text');
      const result = await wabot.sendText(jid, dto.message);

      const remoteId = isString(result.chatId)
        ? result.chatId
        : result.chatId._serialized;

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: result.id,
          remote_id: remoteId,
          content_type: 'text',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wppconnect',
        status: 'sent',
        to: message.to,
        content_type: 'text',
        direction: 'outgoing',
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
        is_webhook_success: true,
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
        engine: session.engine || 'wppconnect',
        status: 'failed',
        to: message.to,
        content_type: 'text',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
    connector: WppConnectConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'image');

      const result = await wabot.sendImage(
        jid,
        dto.image,
        undefined,
        dto.caption ?? '',
      );

      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: result.id,
          remote_id: result.id,
          content_type: 'image',
          status: 'sent',
        },
      });
      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wppconnect',
        status: 'sent',
        to: message.to,
        content_type: 'image',
        direction: 'outgoing',
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
        is_webhook_success: true,
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
        engine: session.engine || 'wppconnect',
        status: 'failed',
        to: message.to,
        content_type: 'image',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
    connector: WppConnectConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      await this.sendTyping(wabot, jid, 'video');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const send = await wabot.sendFile(
        jid,
        dto.video,
        'video',
        dto.caption ?? '',
      );

      const result = send as { ack: number; id: string; sendMsgResult: any };
      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: result.id,
          remote_id: result.id,
          content_type: 'video',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wppconnect',
        status: 'sent',
        to: message.to,
        content_type: 'video',
        direction: 'outgoing',
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
        is_webhook_success: true,
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
        engine: session.engine || 'wppconnect',
        status: 'failed',
        to: message.to,
        content_type: 'video',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
    connector: WppConnectConnector,
  ): Promise<void> {
    const { sessionAttributes, wabot } = connector;
    const messageDelay = (sessionAttributes?.message_delay ?? 0) * 1000;

    try {
      if (messageDelay > 0) await delay(messageDelay);

      let filename = dto.filename?.trim() || 'document';
      if (!filename.includes('.')) {
        const extFromUrl = dto.document.split('.').pop();
        if (extFromUrl && extFromUrl.length <= 5) {
          filename += `.${extFromUrl}`;
        } else {
          filename += '.txt';
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const send = await wabot.sendFile(
        jid,
        dto.document,
        filename,
        dto.caption ?? '',
      );

      const result = send as { ack: number; id: string; sendMsgResult: any };
      const message = await this.prisma.message.update({
        where: { id: messageId },
        data: {
          message_id: result.id,
          remote_id: result.id,
          content_type: 'document',
          status: 'sent',
        },
      });

      const payload: MessagePayload = {
        id: message.id,
        session_id: connector.sessionId,
        name: connector.sessionName,
        engine: connector.engine || 'wppconnect',
        status: 'sent',
        to: message.to,
        content_type: 'document',
        direction: 'outgoing',
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
        is_webhook_success: true,
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
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
        engine: session.engine || 'wppconnect',
        status: 'failed',
        to: message.to,
        content_type: 'document',
        direction: 'outgoing',
        error_message: errorMsg,
        created_at: formatDateTime(message.created_at),
        updated_at: formatDateTime(message.updated_at),
      };

      this.webhook
        .statusMessage('message.updated', connector?.sessionAttributes, payload)
        .catch(() => {});
    }
  }
}
