export type MessageEvent = 'message.updated';

export interface MessagePayload {
  id: string;
  session_id: string;
  name: string;
  engine: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  to: string;
  from?: string;
  content_type?: string;
  direction?: 'outgoing' | 'incoming';
  error_message?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  delivered_at?: string | Date | null;
  read_at?: string | Date | null;
  is_webhook_success?: boolean;
}

export type SessionEvent =
  | 'session.created'
  | 'session.connected'
  | 'session.disconnected'
  | 'session.qr_timeout'
  | 'session.qr_generated'
  | 'session.synchronized'
  | 'session.restarted'
  | 'session.updated'
  | 'session.deleted'
  | 'session.error';

export interface SessionPayload {
  session_id: string;
  name: string;
  engine: string;
  status:
    | 'created'
    | 'connected'
    | 'disconnected'
    | 'qr_timeout'
    | 'qr_generated'
    | 'synchronized'
    | 'restarted'
    | 'updated'
    | 'deleted'
    | 'error';
  qrCodeUrl?: string | null;
  timeout?: number | null;
  timestamp?: string | Date;
  message?: string;
}

export type WebhookEvent = MessageEvent | SessionEvent;
export type WebhookPayload = MessagePayload | SessionPayload;
