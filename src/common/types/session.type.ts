import type { WASocket } from 'baileys';
import type { Client as WWebJSClient } from 'whatsapp-web.js';

export type EngineType = 'baileys' | 'wwebjs';

export interface SessionAttributes {
  message_delay?: number;
  webhook_message?: string;
  webhook_status?: string;
  webhook_secret?: string;
}
export interface BaileysConnector {
  engine: 'baileys';
  wabot: WASocket;
  sessionId: string;
  sessionName: string;
  sessionAttributes?: SessionAttributes;
  isConnected(): boolean;
}

export interface WWebJSConnector {
  engine: 'wwebjs';
  wabot: WWebJSClient;
  sessionId: string;
  sessionName: string;
  sessionAttributes?: SessionAttributes;
  isConnected(): boolean;
}

export type Connector = BaileysConnector | WWebJSConnector;

export interface FormatJid {
  jid: string;
  exists: boolean;
}

export type VerifyContact = FormatJid | undefined;
