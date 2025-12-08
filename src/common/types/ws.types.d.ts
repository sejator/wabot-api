import 'ws';

declare module 'ws' {
  interface WebSocket {
    id: string;
    channels: Set<string>;
    isAlive: boolean;
  }
}
