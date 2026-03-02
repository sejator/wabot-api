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
import { DisconnectReason } from 'baileys';
import { Boom } from '@hapi/boom';
import { SessionsService } from 'src/modules/sessions/sessions.service';

@Injectable()
export class MessagesService {
  constructor(
    private readonly connectorRegistry: ConnectorRegistry<Connector>,
    private readonly baileysMessage: BaileysMessageEngine,
    private readonly wwebjsMessage: WWebJSMessageEngine,
    private readonly wppconnectMessage: WppConnectMessageEngine,
    private readonly sessions: SessionsService,
  ) {}

  /** Kirim pesan teks */
  async sendMessage(dto: CreateMessageDto) {
    try {
      const connector = this.getConnectorOrThrow(dto.session_id);
      dto.message = removeHtmlEntities(dto.message);

      return this.executeWithEngine(connector, dto, {
        baileys: async (d) => {
          const msg = await this.baileysMessage.sendText(d);
          return this.baileysMessage.getSanitizedMessage(msg);
        },
        wwebjs: async (d) => {
          const msg = await this.wwebjsMessage.sendText(d);
          return this.wwebjsMessage.getSanitizedMessage(msg);
        },
        wppconnect: async (d) => {
          const msg = await this.wppconnectMessage.sendText(d);
          return this.wppconnectMessage.getSanitizedMessage(msg);
        },
      });
    } catch (error: unknown) {
      return this.handleError(error, dto.session_id, 'message');
    }
  }

  async sendImage(dto: CreateImageMessageDto) {
    try {
      const connector = this.getConnectorOrThrow(dto.session_id);
      dto.caption = removeHtmlEntities(dto.caption);

      return this.executeWithEngine(connector, dto, {
        baileys: async (d) => {
          const msg = await this.baileysMessage.sendImage(d);
          return this.baileysMessage.getSanitizedMessage(msg);
        },
        wwebjs: async (d) => {
          const msg = await this.wwebjsMessage.sendImage(d);
          return this.wwebjsMessage.getSanitizedMessage(msg);
        },
        wppconnect: async (d) => {
          const msg = await this.wppconnectMessage.sendImage(d);
          return this.wppconnectMessage.getSanitizedMessage(msg);
        },
      });
    } catch (error: unknown) {
      return this.handleError(error, dto.session_id, 'image');
    }
  }

  async sendVideo(dto: CreateVideoMessageDto) {
    try {
      const connector = this.getConnectorOrThrow(dto.session_id);
      dto.caption = removeHtmlEntities(dto.caption);

      return this.executeWithEngine(connector, dto, {
        baileys: async (d) => {
          const msg = await this.baileysMessage.sendVideo(d);
          return this.baileysMessage.getSanitizedMessage(msg);
        },
        wwebjs: async (d) => {
          const msg = await this.wwebjsMessage.sendVideo(d);
          return this.wwebjsMessage.getSanitizedMessage(msg);
        },
        wppconnect: async (d) => {
          const msg = await this.wppconnectMessage.sendVideo(d);
          return this.wppconnectMessage.getSanitizedMessage(msg);
        },
      });
    } catch (error: unknown) {
      return this.handleError(error, dto.session_id, 'video');
    }
  }

  async sendDocument(dto: CreateDocumentMessageDto) {
    try {
      const connector = this.getConnectorOrThrow(dto.session_id);
      dto.caption = removeHtmlEntities(dto.caption);

      return this.executeWithEngine(connector, dto, {
        baileys: async (d) => {
          const msg = await this.baileysMessage.sendDocument(d);
          return this.baileysMessage.getSanitizedMessage(msg);
        },
        wwebjs: async (d) => {
          const msg = await this.wwebjsMessage.sendDocument(d);
          return this.wwebjsMessage.getSanitizedMessage(msg);
        },
        wppconnect: async (d) => {
          const msg = await this.wppconnectMessage.sendDocument(d);
          return this.wppconnectMessage.getSanitizedMessage(msg);
        },
      });
    } catch (error: unknown) {
      return this.handleError(error, dto.session_id, 'document');
    }
  }

  /** Kirim ke banyak penerima */
  async sendMessageMultiple(dto: CreateMessageMultipleDto) {
    return Promise.all(dto.data.map((d) => this.sendMessage(d)));
  }

  private async executeWithEngine<TDto, TResult>(
    connector: Connector,
    dto: TDto,
    executor: {
      baileys: (dto: TDto) => Promise<TResult>;
      wwebjs: (dto: TDto) => Promise<TResult>;
      wppconnect: (dto: TDto) => Promise<TResult>;
    },
  ): Promise<TResult> {
    switch (connector.engine) {
      case 'baileys':
        return executor.baileys(dto);

      case 'wwebjs':
        return executor.wwebjs(dto);

      case 'wppconnect':
        return executor.wppconnect(dto);

      default:
        throw new Error('Engine tidak dikenali');
    }
  }

  private async handleError(
    error: unknown,
    sessionId: string,
    type: string,
  ): Promise<never> {
    if (this.isLoggedOutError(error)) {
      await this.sessions.forceDelete(sessionId);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Unknown error occurred while sending ${type}`);
  }

  private getConnectorOrThrow(sessionId: string): Connector {
    const connector = this.connectorRegistry.get(sessionId);

    if (!connector) {
      throw new Error('Session tidak ditemukan');
    }

    return connector;
  }

  private isLoggedOutError(error: unknown): boolean {
    return (
      error instanceof Boom &&
      error.output.statusCode === Number(DisconnectReason.loggedOut)
    );
  }
}
