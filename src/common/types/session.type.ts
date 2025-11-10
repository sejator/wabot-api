import type { WASocket } from 'baileys';
import type { Client as WWebJSClient } from 'whatsapp-web.js';
import type { Whatsapp as WppClient } from '@wppconnect-team/wppconnect';

export const EngineTypes = ['baileys', 'wwebjs', 'wppconnect'] as const;

export type EngineType = (typeof EngineTypes)[number];

export interface SessionAttributes {
  message_delay?: number;
  webhook_incoming?: string;
  webhook_status?: string;
  webhook_secret?: string;
  quota?: number | null; // null = unlimited
}

/**
 * Connector untuk Baileys
 */
export interface BaileysConnector {
  engine: 'baileys';
  wabot: WASocket;
  sessionId: string;
  sessionName: string;
  sessionAttributes?: SessionAttributes;
  isConnected(): boolean;
}

/**
 * Connector untuk whatsapp-web.js
 */
export interface WWebJSConnector {
  engine: 'wwebjs';
  wabot: WWebJSClient;
  sessionId: string;
  sessionName: string;
  sessionAttributes?: SessionAttributes;
  isConnected(): boolean;
}

/**
 * Connector untuk WPPConnect
 */
export interface WppConnectConnector {
  engine: 'wppconnect';
  wabot: WppClient;
  sessionId: string;
  sessionName: string;
  sessionAttributes?: SessionAttributes;
  isConnected(): boolean;
}

/**
 * Untuk semua jenis connector
 */
export type Connector =
  | BaileysConnector
  | WWebJSConnector
  | WppConnectConnector;

export interface FormatJid {
  jid: string;
  exists: boolean;
}

export type VerifyContact = FormatJid | undefined;
