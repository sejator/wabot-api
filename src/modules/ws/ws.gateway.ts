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
import { Request } from 'express';
import { EngineType } from 'src/common/types/session.type';
import { SessionsService } from '../sessions/sessions.service';
import { CreateSessionDto } from '../sessions/dto/create-session.dto';
import { formatDateTime } from 'src/common/utils/general.util';

@WebSocketGateway({
  path: '/ws',
  cors: { origin: '*' },
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly clients = new Map<
    string,
    { socket: WebSocket; sessions: Set<string>; isAlive: boolean }
  >();

  private readonly logger = new FileLoggerService(WsGateway.name);
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 detik

  constructor(private readonly sessions: SessionsService) {
    this.registerGlobalListeners();
    this.startHeartbeat();
  }

  async handleConnection(client: WebSocket, req: Request) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientId =
      url.searchParams.get('clientId') || this.generateClientId();

    let device: {
      name: string;
      id: string;
      engine: string | null;
      connected: boolean;
      created_at: Date;
      updated_at: Date;
    };

    try {
      // verify clientId exists
      device = await this.sessions.find(clientId);
    } catch {
      client.close(1008, 'Unauthorized');
      return;
    }

    client.id = clientId;

    this.clients.set(clientId, {
      socket: client,
      sessions: new Set(),
      isAlive: true,
    });

    this.logger.log(`Client connected: ${clientId}`);

    client.on('pong', () => {
      const clientData = this.clients.get(clientId);
      if (clientData) clientData.isAlive = true;
    });

    client.on('message', (raw: string) => {
      if (raw === 'ping' || raw === 'pong') return;

      try {
        const parsed = JSON.parse(raw) as {
          event: WebhookEvent;
          data: Record<string, any>;
        };

        if (parsed.event === 'session.created') {
          void this.handleCreateSession(client, parsed.data);
        }

        if (parsed.event === 'session.connected') {
          if (device && device.connected) {
            const payload: SessionPayload = {
              session_id: device.id,
              name: device.name,
              engine: device.engine || 'baileys',
              status: 'connected',
              timestamp: formatDateTime(new Date()),
            };

            this.sendToClient(client, 'session.connected', payload);
          }
        }
      } catch (err) {
        this.logger.error(`Invalid message from ${clientId}: ${err}`);
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const clientId = client.id;
    if (clientId) {
      this.clients.delete(clientId);
      this.logger.log(`Client disconnected: ${clientId}`);
    }
  }

  private async handleCreateSession(
    client: WebSocket,
    data: CreateSessionDto | Record<string, any>,
  ) {
    const clientId = client.id;
    const { name, engine } = data as CreateSessionDto;

    if (!name) {
      return this.sendToClient(client, 'session.error', {
        message: 'Missing session name',
      });
    }

    const listEngine: EngineType[] = ['baileys', 'wwebjs'];
    if (engine && !listEngine.includes(engine)) {
      return this.sendToClient(client, 'session.error', {
        message: 'Invalid engine type',
      });
    }

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
      session = await this.sessions.create({ name, engine });
    }

    clientData.sessions.add(session.name);

    this.broadcastToSession(session.name, 'session.created', {
      session_id: session.id,
      name: session.name,
      engine: session.engine || 'unknown',
      status: 'created',
      timestamp: new Date(),
    });

    // CONNECT ENGINE
    try {
      const connect = await this.sessions.connect(session.id);

      if (connect?.connected) {
        this.broadcastToSession(session.name, 'session.connected', {
          session_id: session.id,
          name: session.name,
          engine: session.engine || 'unknown',
          status: 'connected',
          timestamp: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(`Failed to connect session ${session.id}: ${error}`);

      this.broadcastToSession(session.name, 'session.error', {
        session_id: session.id,
        name,
        engine,
        status: 'error',
        timestamp: new Date(),
        message: 'Failed to connect session',
      });
    }
  }

  private sendToClient(
    client: WebSocket,
    event: WebhookEvent,
    data: Record<string, any>,
  ) {
    try {
      client.send(JSON.stringify({ event, data }));
    } catch (err) {
      this.logger.error(`Failed to send event ${event}: ${err}`);
    }
  }

  private broadcastToSession(
    sessionName: string,
    event: WebhookEvent,
    payload: Record<string, any>,
  ) {
    for (const [, { socket, sessions }] of this.clients.entries()) {
      if (sessions.has(sessionName)) {
        this.sendToClient(socket, event, payload);
      }
    }
  }

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
