import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { wabot, WABOT_EVENTS } from 'src/common/events/wabot.events';
import { FileLoggerService } from 'src/common/logger/file-logger/file-logger.service';
import {
  WebhookEvent,
  WebhookPayload,
  MessagePayload,
  SessionPayload,
} from 'src/common/types/wabot-event.types';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { Request } from 'express';
import { EngineType } from 'src/common/types/session.type';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class SessionsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly clients = new Map<
    string,
    { socket: WebSocket; sessions: Set<string>; isAlive: boolean }
  >();

  private readonly logger = new FileLoggerService(SessionsGateway.name);

  private readonly HEARTBEAT_INTERVAL = 30000; // 30 detik

  constructor(private readonly sessions: SessionsService) {
    this.registerGlobalListeners();
    this.startHeartbeat();
  }

  handleConnection(client: WebSocket, req: Request) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientId = url.searchParams.get('id') || this.generateClientId();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (client as any).id = clientId;

    this.clients.set(clientId, {
      socket: client,
      sessions: new Set(),
      isAlive: true,
    });

    this.logger.log(`Client connected: ${clientId}`);

    // untuk heartbeat dari client
    client.on('pong', () => {
      const clientData = this.clients.get(clientId);
      if (clientData) clientData.isAlive = true;
    });

    client.on('message', (raw: string) => {
      // abaikan pesan ping/pong (heartbeat, sudah di handle websocket)
      if (raw === 'ping' || raw === 'pong') return;

      try {
        const parsed = JSON.parse(raw) as {
          event: string;
          data: Record<string, any>;
        };
        const { event, data } = parsed;

        if (event === 'session.create') {
          void this.handleCreateSession(client, data);
        }
      } catch (err) {
        this.logger.error(`Invalid message from ${clientId}: ${err}`);
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const clientId = (client as any).id;
    if (clientId) {
      this.clients.delete(clientId as string);
      this.logger.log(`Client disconnected: ${clientId}`);
    }
  }

  /**
   * Handle session creation
   */
  private async handleCreateSession(
    client: WebSocket,
    data: CreateSessionDto | Record<string, any>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const clientId = (client as any).id;
    const { name, engine } = data as CreateSessionDto;

    if (!name) {
      this.sendToClient(client, 'session.error', {
        message: 'Missing session name',
      });
      return;
    }
    const listEngine: EngineType[] = ['baileys', 'wwebjs'];
    if (engine && !listEngine.includes(engine)) {
      this.sendToClient(client, 'session.error', {
        message: 'Invalid engine type',
      });
      return;
    }

    if (engine) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const clientData = this.clients.get(clientId);
      if (!clientData) return;

      let session: {
        id: string;
        name: string;
        engine: string | null;
        connected: boolean;
        created_at: Date;
        updated_at: Date;
      };

      try {
        session = await this.sessions.find(name);
      } catch {
        session = await this.sessions.create({
          name: name,
          engine: engine,
        });
      }

      clientData.sessions.add(session.name);

      this.broadcastToSession(session.name, 'session.created', {
        session_id: session.id,
        name: session.name,
        engine: session.engine || 'unknown',
        status: 'created',
        timestamp: new Date(),
      } as SessionPayload);

      try {
        const connect = await this.sessions.connect(session.id);
        if ('connected' in connect && connect.connected) {
          this.broadcastToSession(session.name, 'session.connected', {
            session_id: session.id,
            name: session.name,
            engine: session.engine || 'unknown',
            status: 'connected',
            timestamp: new Date(),
          } as SessionPayload);
        }
      } catch (error) {
        this.logger.error(`Failed to connect session ${session.id}: ${error}`);
        this.broadcastToSession(session.name, 'session.error', {
          session_id: Math.random().toString(36).substring(2, 15),
          name: name,
          engine: engine,
          status: 'error',
          timestamp: new Date(),
          message: 'Failed to connect session',
        });
      }
    }
  }

  /**
   * Kirim data ke client
   */
  private sendToClient(
    client: WebSocket,
    event: string,
    data: Record<string, any>,
  ) {
    try {
      client.send(JSON.stringify({ event, data }));
    } catch (err) {
      this.logger.error(`Failed to send event ${event}: ${err}`);
    }
  }

  /**
   * Broadcast ke semua client yang join session tertentu
   */
  private broadcastToSession(
    sessionName: string,
    event: string,
    payload: Record<string, any>,
  ) {
    for (const [clientId, { socket, sessions }] of this.clients.entries()) {
      console.log('Checking client sessions:', clientId, Array.from(sessions));
      if (sessions.has(sessionName)) {
        this.sendToClient(socket, event, payload);
      }
    }
  }

  /**
   * Broadcast global event (webhook)
   */
  private registerGlobalListeners() {
    WABOT_EVENTS.forEach((event) => {
      wabot.on(event, (payload: WebhookPayload) => {
        this.broadcastEvent(event, payload);
      });
    });
  }

  private broadcastEvent(event: WebhookEvent, payload: WebhookPayload) {
    const sessionName =
      (payload as SessionPayload).name || (payload as MessagePayload).name;

    if (!sessionName) return;

    for (const [clientId, { socket, sessions }] of this.clients.entries()) {
      if (sessions.has(sessionName)) {
        this.sendToClient(socket, event, payload);
        this.logger.log(`Event ${event} sent to ${clientId}`);
      }
    }
  }

  /**
   * Jalankan heartbeat bawaan WebSocket
   */
  private startHeartbeat() {
    setInterval(() => {
      for (const [clientId, clientData] of this.clients.entries()) {
        if (!clientData.isAlive) {
          this.logger.log(`Terminating inactive client: ${clientId}`);
          clientData.socket.terminate();
          this.clients.delete(clientId);
          continue;
        }

        clientData.isAlive = false;
        try {
          clientData.socket.ping();
        } catch (err) {
          this.logger.error(`Ping failed for ${clientId}: ${err}`);
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private generateClientId(): string {
    return Math.random().toString(36).substring(2, 15);
  }
}
