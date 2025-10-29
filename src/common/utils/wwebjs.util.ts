import { MessageAck } from 'whatsapp-web.js';

export type statusMessageWwebjs =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export function mapWwebjsStatusMessage(
  status: MessageAck,
): statusMessageWwebjs {
  switch (status) {
    case MessageAck.ACK_PENDING:
      return 'pending';
    case MessageAck.ACK_SERVER:
      return 'sent';
    case MessageAck.ACK_DEVICE:
      return 'delivered';
    case MessageAck.ACK_READ:
    case MessageAck.ACK_PLAYED:
      return 'read';
    default:
      return 'failed';
  }
}
