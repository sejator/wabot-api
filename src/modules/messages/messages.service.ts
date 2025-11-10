import { Injectable } from '@nestjs/common';
import {
  CreateMessageDto,
  CreateMessageMultipleDto,
  CreateImageMessageDto,
  CreateVideoMessageDto,
  CreateDocumentMessageDto,
} from './dto';
import { BaileysMessageEngine } from 'src/common/interfaces/message/baileys-message.engine';
import { removeHtmlEntities } from 'src/common/utils/general.util';
import { Connector } from 'src/common/types/session.type';
import { ConnectorRegistry } from 'src/common/interfaces/engines/connector-registry.service';
import { WWebJSMessageEngine } from 'src/common/interfaces/message/wwebjs-message.engine';
import { WppConnectMessageEngine } from 'src/common/interfaces/message/wppconnect-message.engine';

@Injectable()
export class MessagesService {
  constructor(
    private readonly connectorRegistry: ConnectorRegistry<Connector>,
    private readonly baileysMessage: BaileysMessageEngine,
    private readonly wwebjsMessage: WWebJSMessageEngine,
    private readonly wppconnectMessage: WppConnectMessageEngine,
  ) {}

  /** Kirim pesan teks */
  async sendMessage(dto: CreateMessageDto) {
    const connector = this.connectorRegistry.get(dto.session_id);
    dto.message = removeHtmlEntities(dto.message);
    if (connector.engine === 'baileys') {
      const message = await this.baileysMessage.sendText(dto);
      return this.baileysMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wwebjs') {
      const message = await this.wwebjsMessage.sendText(dto);
      return this.wwebjsMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wppconnect') {
      const message = await this.wppconnectMessage.sendText(dto);
      return this.wppconnectMessage.getSanitizedMessage(message);
    }
  }

  /** Kirim ke banyak penerima */
  async sendMessageMultiple(dto: CreateMessageMultipleDto) {
    return Promise.all(dto.data.map((d) => this.sendMessage(d)));
  }

  async sendImage(dto: CreateImageMessageDto) {
    const connector = this.connectorRegistry.get(dto.session_id);
    if (connector.engine === 'baileys') {
      dto.caption = removeHtmlEntities(dto.caption);
      const message = await this.baileysMessage.sendImage(dto);
      return this.baileysMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wwebjs') {
      const message = await this.wwebjsMessage.sendImage(dto);
      return this.wwebjsMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wppconnect') {
      const message = await this.wppconnectMessage.sendImage(dto);
      return this.wppconnectMessage.getSanitizedMessage(message);
    }
  }

  async sendVideo(dto: CreateVideoMessageDto) {
    const connector = this.connectorRegistry.get(dto.session_id);
    if (connector.engine === 'baileys') {
      dto.caption = removeHtmlEntities(dto.caption);
      const message = await this.baileysMessage.sendVideo(dto);
      return this.baileysMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wwebjs') {
      const message = await this.wwebjsMessage.sendVideo(dto);
      return this.wwebjsMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wppconnect') {
      const message = await this.wppconnectMessage.sendVideo(dto);
      return this.wppconnectMessage.getSanitizedMessage(message);
    }
  }

  async sendDocument(dto: CreateDocumentMessageDto) {
    const connector = this.connectorRegistry.get(dto.session_id);
    if (connector.engine === 'baileys') {
      dto.caption = removeHtmlEntities(dto.caption);
      const message = await this.baileysMessage.sendDocument(dto);
      return this.baileysMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wwebjs') {
      const message = await this.wwebjsMessage.sendDocument(dto);
      return this.wwebjsMessage.getSanitizedMessage(message);
    } else if (connector.engine === 'wppconnect') {
      const message = await this.wppconnectMessage.sendDocument(dto);
      return this.wppconnectMessage.getSanitizedMessage(message);
    }
  }
}
