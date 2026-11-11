import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Auth, configService, Cors, Log, Websocket } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { IncomingMessage, Server } from 'http';
import { Namespace, Server as SocketIO, Socket } from 'socket.io';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

// Principal bound at handshake: '*' for the global key or an allowlisted host, otherwise the instance name.
type PrincipalRequest = IncomingMessage & { wsPrincipal?: string };

const GLOBAL_PRINCIPAL = '*';
const GLOBAL_ROOM = 'global';

export class WebsocketController extends EventController implements EventControllerInterface {
  private io: SocketIO;
  private corsConfig: Array<any>;
  private readonly logger = new Logger('WebsocketController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Websocket>('WEBSOCKET')?.ENABLED, 'websocket');

    this.cors = configService.get<Cors>('CORS').ORIGIN;
  }

  public init(httpServer: Server): void {
    if (!this.status) {
      return;
    }

    this.socket = new SocketIO(httpServer, {
      cors: { origin: this.cors },
      allowRequest: async (req, callback) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const params = new URLSearchParams(url.search);

          const { remoteAddress } = req.socket;
          const websocketConfig = configService.get<Websocket>('WEBSOCKET');
          const allowedHosts = websocketConfig.ALLOWED_HOSTS || '127.0.0.1,::1,::ffff:127.0.0.1';
          const allowAllHosts = allowedHosts.trim() === '*';
          const isAllowedHost =
            allowAllHosts ||
            allowedHosts
              .split(',')
              .map((h) => h.trim())
              .includes(remoteAddress);

          if (params.has('EIO') && isAllowedHost) {
            (req as PrincipalRequest).wsPrincipal = GLOBAL_PRINCIPAL;
            return callback(null, true);
          }

          const apiKey = params.get('apikey') || (req.headers.apikey as string);

          if (!apiKey) {
            this.logger.error('Connection rejected: apiKey not provided');
            return callback('apiKey is required', false);
          }

          const instance = await this.prismaRepository.instance.findFirst({ where: { token: apiKey } });

          if (!instance) {
            const globalToken = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
            if (apiKey !== globalToken) {
              this.logger.error('Connection rejected: invalid global token');
              return callback('Invalid global token', false);
            }
          }

          (req as PrincipalRequest).wsPrincipal = instance ? instance.name : GLOBAL_PRINCIPAL;
          callback(null, true);
        } catch (error) {
          this.logger.error('Authentication error:');
          this.logger.error(error);
          callback('Authentication error', false);
        }
      },
    });

    // Bind every namespace (root, /<instance> created on emit or on connect) to the handshake principal.
    const bindPrincipal = (socket: Socket, next: (err?: Error) => void) => {
      const principal = (socket.request as PrincipalRequest).wsPrincipal;
      const namespace = socket.nsp.name.slice(1);

      if (!principal) {
        return next(new Error('Unauthorized'));
      }

      if (namespace && principal !== GLOBAL_PRINCIPAL && principal !== namespace) {
        this.logger.error(`Connection rejected: token not allowed for namespace /${namespace}`);
        return next(new Error('Forbidden'));
      }

      socket.data.principal = principal;
      next();
    };

    this.socket.use(bindPrincipal);
    this.socket.on('new_namespace', (namespace: Namespace) => namespace.use(bindPrincipal));

    this.socket.on('connection', (socket) => {
      this.logger.info('User connected');

      if (socket.data.principal === GLOBAL_PRINCIPAL) {
        socket.join(GLOBAL_ROOM);
      }

      socket.on('disconnect', () => {
        this.logger.info('User disconnected');
      });

      socket.on('sendNode', async (data) => {
        const principal = socket.data.principal;
        if (principal !== GLOBAL_PRINCIPAL && principal !== data?.instanceId) {
          this.logger.error('sendNode rejected: token not allowed for this instance');
          return;
        }

        try {
          await this.waMonitor.waInstances[data.instanceId].baileysSendNode(data.stanza);
          this.logger.info('Node sent successfully');
        } catch (error) {
          this.logger.error('Error sending node:');
          this.logger.error(error);
        }
      });
    });

    this.logger.info('Socket.io initialized');
  }

  private set cors(cors: Array<any>) {
    this.corsConfig = cors;
  }

  private get cors(): string | Array<any> {
    return this.corsConfig?.includes('*') ? '*' : this.corsConfig;
  }

  private set socket(socket: SocketIO) {
    this.io = socket;
  }

  public get socket(): SocketIO {
    return this.io;
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('websocket')) {
      return;
    }

    if (!this.status) {
      return;
    }

    const configEv = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBSOCKET');
    const message = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      server_url: serverUrl,
      date_time: dateTime,
      sender,
      apikey: apiKey,
    };

    if (configService.get<Websocket>('WEBSOCKET')?.GLOBAL_EVENTS) {
      this.socket.to(GLOBAL_ROOM).emit(event, message);

      if (logEnabled) {
        this.logger.log({ local: `${origin}.sendData-WebsocketGlobal`, ...message });
      }
    }

    try {
      const instance = await this.get(instanceName);

      if (!instance?.enabled) {
        return;
      }

      if (Array.isArray(instance?.events) && instance?.events.includes(configEv)) {
        this.socket.of(`/${instanceName}`).emit(event, message);

        if (logEnabled) {
          this.logger.log({ local: `${origin}.sendData-Websocket`, ...message });
        }
      }
    } catch (err) {
      if (logEnabled) {
        this.logger.log(err);
      }
    }
  }
}
