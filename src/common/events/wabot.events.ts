import { EventEmitter } from 'events';
import {
  WebhookEvent,
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';

type EventPayloadMap = {
  'session.created': SessionPayload;
  'session.connected': SessionPayload;
  'session.disconnected': SessionPayload;
  'session.qr_timeout': SessionPayload;
  'session.qr_generated': SessionPayload;
  'session.synchronized': SessionPayload;
  'session.restarted': SessionPayload;
  'session.updated': SessionPayload;
  'session.deleted': SessionPayload;
  'session.error': SessionPayload;
  'message.updated': MessagePayload;
  'message.incoming': MessagePayload;
};

export interface TypedWabot {
  on<E extends WebhookEvent>(
    event: E,
    listener: (payload: EventPayloadMap[E]) => void,
  ): this;
  once<E extends WebhookEvent>(
    event: E,
    listener: (payload: EventPayloadMap[E]) => void,
  ): this;
  off<E extends WebhookEvent>(
    event: E,
    listener: (payload: EventPayloadMap[E]) => void,
  ): this;
  emit<E extends WebhookEvent>(event: E, payload: EventPayloadMap[E]): boolean;
}

/**
 * Global event emitter untuk wabot — gunakan ini di mana saja dalam proses
 */
export const wabot = new EventEmitter() as unknown as TypedWabot;

/**
 * Daftar event yang akan didaftarkan oleh Gateway.
 * Pastikan ini berisi semua event yang kamu expect.
 */
export const WABOT_EVENTS: WebhookEvent[] = [
  'session.created',
  'session.connected',
  'session.disconnected',
  'session.qr_timeout',
  'session.qr_generated',
  'session.synchronized',
  'session.restarted',
  'session.updated',
  'session.deleted',
  'session.error',
  'message.updated',
  'message.incoming',
];
