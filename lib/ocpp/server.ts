import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import {
  SimpleRPCServer, SimpleRPCError, SimpleRPCClient, OCPPWebSocket,
} from './simple-rpc';
import {
  ProtocolFactory,
  ProtocolVersion,
  ProtocolHandler,
  UnifiedMessage,
  UnifiedPayload,
  MessageResponse,
  RemoteCommandResponse,
  ChargingProfile,
} from './protocols';

export interface ChargerInfo {
  chargePointModel: string;
  chargePointVendor: string;
  chargePointSerialNumber?: string;
  firmwareVersion?: string;
  meterType?: string;
  meterSerialNumber?: string;
  protocolVersion: ProtocolVersion;
}

interface OCPPServerConfig {
  port: number;
  auth?: {
    username: string;
    password: string;
  };
  onChargerConnect: (chargerId: string, chargerInfo: ChargerInfo) => Promise<void>;
  onChargerDisconnect: (chargerId: string) => Promise<void>;
  onChargerMessage: (chargerId: string, messageType: string, payload: UnifiedPayload) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: (message: string, ...args: any[]) => void;
}

interface ChargerConnection {
  id: string;
  websocket: WebSocket;
  rpcClient: SimpleRPCClient;
  lastHeartbeat: Date;
  isAuthenticated: boolean;
  bootNotificationReceived: boolean;
  protocolVersion: ProtocolVersion;
  protocolHandler: ProtocolHandler;
  chargerInfo?: ChargerInfo;
}

export class OCPPServer {
  private config: OCPPServerConfig;
  private server?: WebSocketServer;
  private rpcServer: SimpleRPCServer;
  private chargerConnections: Map<string, ChargerConnection> = new Map();
  private heartbeatInterval = 60000; // 60 seconds
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(config: OCPPServerConfig) {
    this.config = config;
    this.rpcServer = new SimpleRPCServer();
    this.setupOCPPHandlers();
  }

  async start(): Promise<void> {
    this.config.logger(`OCPP server starting on port ${this.config.port}`);

    this.server = new WebSocketServer({
      port: this.config.port,
      verifyClient: (info: { req: IncomingMessage }) => this.verifyClient(info),
    });

    this.server.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleChargerConnection(ws, request);
    });

    this.server.on('error', (error) => {
      this.config.logger('WebSocket server error:', error);
    });

    this.startHeartbeatMonitoring();

    this.config.logger(`OCPP server listening on port ${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    for (const [chargerId, connection] of this.chargerConnections) {
      connection.websocket.close(1000, 'Server shutdown');
      await this.config.onChargerDisconnect(chargerId);
    }
    this.chargerConnections.clear();

    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.config.logger('OCPP server stopped');
  }

  /**
   * Send a remote command to a connected charger.
   * All remote command methods delegate here to avoid copy-paste.
   */
  private async sendRemoteCommand(
    chargerId: string,
    commandName: string,
    payload: Record<string, unknown>,
    logPrefix: string,
  ): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);

    try {
      const response = await connection.rpcClient.call(commandName, payload);
      this.config.logger(`${commandName} response from ${chargerId} (OCPP ${connection.protocolVersion}):`, response);
      return connection.protocolHandler.parseRemoteCommandResponse(commandName, response as Record<string, unknown>);
    } catch (error) {
      this.config.logger(`${logPrefix} failed for ${chargerId}:`, error);
      throw error;
    }
  }

  /**
   * Get a connection and verify it's ready for commands.
   */
  private getVerifiedConnection(chargerId: string): ChargerConnection {
    const connection = this.chargerConnections.get(chargerId);
    if (!connection) {
      throw new Error(`Charger ${chargerId} not connected`);
    }
    if (!connection.bootNotificationReceived) {
      throw new Error(`Charger ${chargerId} has not completed boot notification`);
    }
    return connection;
  }

  async sendRemoteStartTransaction(chargerId: string, connectorId: number, idTag?: string): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);
    const { protocolHandler, protocolVersion } = connection;
    const payload = protocolHandler.formatRemoteStartTransaction(connectorId, idTag);
    const commandName = protocolVersion === '1.6' ? 'RemoteStartTransaction' : 'RequestStartTransaction';
    return this.sendRemoteCommand(chargerId, commandName, payload, 'RemoteStartTransaction');
  }

  async sendRemoteStopTransaction(chargerId: string, transactionId: number | string): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);
    const { protocolHandler, protocolVersion } = connection;
    const payload = protocolHandler.formatRemoteStopTransaction(transactionId);
    const commandName = protocolVersion === '1.6' ? 'RemoteStopTransaction' : 'RequestStopTransaction';
    return this.sendRemoteCommand(chargerId, commandName, payload, 'RemoteStopTransaction');
  }

  async changeAvailability(chargerId: string, connectorId: number, type: 'Inoperative' | 'Operative'): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);
    const payload = connection.protocolHandler.formatChangeAvailability(connectorId, type);
    return this.sendRemoteCommand(chargerId, 'ChangeAvailability', payload, 'ChangeAvailability');
  }

  async sendSetChargingProfile(chargerId: string, connectorId: number, chargingProfile: ChargingProfile): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);
    const payload = connection.protocolHandler.formatSetChargingProfile(connectorId, chargingProfile);
    return this.sendRemoteCommand(chargerId, 'SetChargingProfile', payload, 'SetChargingProfile');
  }

  async sendClearChargingProfile(chargerId: string, connectorId: number, chargingProfileId?: number): Promise<RemoteCommandResponse> {
    const connection = this.getVerifiedConnection(chargerId);
    const payload = connection.protocolHandler.formatClearChargingProfile(connectorId, chargingProfileId);
    return this.sendRemoteCommand(chargerId, 'ClearChargingProfile', payload, 'ClearChargingProfile');
  }

  getConnectedChargers(): Array<{ id: string; info: ChargerInfo; lastHeartbeat: Date }> {
    const result: Array<{ id: string; info: ChargerInfo; lastHeartbeat: Date }> = [];

    for (const [chargerId, connection] of this.chargerConnections) {
      if (connection.bootNotificationReceived && connection.chargerInfo) {
        result.push({
          id: chargerId,
          info: connection.chargerInfo,
          lastHeartbeat: connection.lastHeartbeat,
        });
      }
    }

    return result;
  }

  getAllConnectedChargers(): Array<{ id: string; bootNotificationReceived: boolean; protocolVersion: ProtocolVersion; lastHeartbeat: Date }> {
    const result: Array<{ id: string; bootNotificationReceived: boolean; protocolVersion: ProtocolVersion; lastHeartbeat: Date }> = [];

    for (const [chargerId, connection] of this.chargerConnections) {
      result.push({
        id: chargerId,
        bootNotificationReceived: connection.bootNotificationReceived,
        protocolVersion: connection.protocolVersion,
        lastHeartbeat: connection.lastHeartbeat,
      });
    }

    return result;
  }

  getCharger(chargerId: string): ChargerConnection | null {
    return this.chargerConnections.get(chargerId) ?? null;
  }

  private verifyClient(info: { req: IncomingMessage }): boolean {
    const protocolResult = ProtocolFactory.detectProtocolFromConnection(info.req.url || '/', info.req.headers);

    if (!protocolResult.isValid || !protocolResult.chargerId) {
      this.config.logger('Invalid URL format or missing charger ID:', protocolResult.error);
      return false;
    }

    if (this.config.auth) {
      const authHeader = info.req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        this.config.logger(`Authentication required for charger ${protocolResult.chargerId}`);
        return false;
      }

      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
      const [username, password] = credentials.split(':');

      if (username !== this.config.auth.username || password !== this.config.auth.password) {
        this.config.logger(`Invalid credentials for charger ${protocolResult.chargerId}`);
        return false;
      }
    }

    return true;
  }

  private handleChargerConnection(ws: WebSocket, request: IncomingMessage): void {
    // Protocol detection already validated in verifyClient; re-parse URL for charger ID and version
    const protocolResult = ProtocolFactory.detectProtocolFromConnection(request.url || '/', request.headers);

    if (!protocolResult.isValid || !protocolResult.chargerId) {
      this.config.logger('Invalid connection attempt:', protocolResult.error);
      ws.close(1003, protocolResult.error || 'Invalid URL format');
      return;
    }

    const { version: protocolVersion, chargerId } = protocolResult;
    const protocolHandler = ProtocolFactory.getHandler(protocolVersion);

    this.config.logger(`Charger ${chargerId} connecting with OCPP ${protocolVersion}`);

    // Set chargePointId on WebSocket for RPC client identification
    (ws as OCPPWebSocket).chargePointId = chargerId;

    const rpcClient = this.rpcServer.createClient(ws);

    const connection: ChargerConnection = {
      id: chargerId,
      websocket: ws,
      rpcClient,
      lastHeartbeat: new Date(),
      isAuthenticated: true,
      bootNotificationReceived: false,
      protocolVersion,
      protocolHandler,
    };

    this.chargerConnections.set(chargerId, connection);

    ws.on('close', (code, reason) => {
      this.config.logger(`Charger ${chargerId} (OCPP ${protocolVersion}) disconnected: ${code} ${reason}`);
      this.chargerConnections.delete(chargerId);
      this.config.onChargerDisconnect(chargerId).catch((err) => {
        this.config.logger(`Error during charger disconnect for ${chargerId}:`, err);
      });
    });

    ws.on('error', (error) => {
      this.config.logger(`WebSocket error for charger ${chargerId}:`, error);
    });

    rpcClient.on('error', (error: unknown) => {
      this.config.logger(`RPC error for charger ${chargerId}:`, error);
    });

    this.config.logger(`Charger ${chargerId} connected with OCPP ${protocolVersion}`);
  }

  private setupOCPPHandlers(): void {
    const createHandler = (messageType: string) => {
      return async (params: Record<string, unknown>, { chargePointId }: { chargePointId: string }) => {
        const connection = this.chargerConnections.get(chargePointId);
        if (!connection) {
          this.config.logger(`No connection found for chargePointId '${chargePointId}'`);
          throw new SimpleRPCError('InternalError', 'Charger connection not found');
        }

        const { protocolHandler, protocolVersion } = connection;

        this.config.logger(`${messageType} from ${chargePointId} (OCPP ${protocolVersion}):`, params);

        const validation = protocolHandler.validateMessage(messageType, params);
        if (!validation.valid) {
          this.config.logger(`Invalid ${messageType} from ${chargePointId}:`, validation.errors);
          throw new SimpleRPCError('FormatViolation', validation.errors?.join(', ') || 'Invalid message format');
        }

        const unifiedMessage = protocolHandler.parseMessage(messageType, params, chargePointId);

        let response: MessageResponse = {};

        switch (messageType) {
          case 'BootNotification':
            response = await this.handleBootNotification(connection, unifiedMessage);
            break;

          case 'Heartbeat':
            response = await this.handleHeartbeat(connection);
            break;

          default:
            await this.config.onChargerMessage(chargePointId, messageType, unifiedMessage.payload);

            if (['StatusNotification', 'MeterValues', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification'].includes(messageType)) {
              response = {};
            } else if (messageType === 'Authorize') {
              response = { idTagInfo: { status: 'Accepted' } };
            } else if (messageType === 'StartTransaction') {
              const transactionId = protocolVersion === '1.6'
                ? Math.floor(Math.random() * 1000000)
                : Math.floor(Math.random() * 1000000).toString();
              response = {
                transactionId,
                idTagInfo: { status: 'Accepted' },
              };
            } else if (messageType === 'StopTransaction') {
              response = { idTagInfo: { status: 'Accepted' } };
            }
        }

        return protocolHandler.formatResponse(messageType, response);
      };
    };

    // Register handlers for all supported message types across all protocols
    const allMessageTypes = new Set<string>();
    ProtocolFactory.getSupportedVersions().forEach((version) => {
      const handler = ProtocolFactory.getHandler(version);
      handler.supportedMessages.forEach((msgType) => allMessageTypes.add(msgType));
    });

    allMessageTypes.forEach((messageType) => {
      this.rpcServer.handle(messageType, createHandler(messageType));
    });
  }

  private async handleBootNotification(connection: ChargerConnection, unifiedMessage: UnifiedMessage): Promise<MessageResponse> {
    const { id: chargePointId, protocolVersion } = connection;
    const { payload } = unifiedMessage;

    this.config.logger(`BootNotification from ${chargePointId}: ${payload.chargePointVendor} ${payload.chargePointModel}`);

    const chargerInfo: ChargerInfo = {
      chargePointModel: payload.chargePointModel ?? 'Unknown',
      chargePointVendor: payload.chargePointVendor ?? 'Unknown',
      chargePointSerialNumber: payload.chargePointSerialNumber,
      firmwareVersion: payload.firmwareVersion,
      meterType: payload.meterType as string | undefined,
      meterSerialNumber: payload.meterSerialNumber as string | undefined,
      protocolVersion,
    };

    connection.chargerInfo = chargerInfo;
    connection.bootNotificationReceived = true;

    await this.config.onChargerConnect(chargePointId, chargerInfo);

    return {
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: this.heartbeatInterval / 1000,
    };
  }

  private async handleHeartbeat(connection: ChargerConnection): Promise<MessageResponse> {
    connection.lastHeartbeat = new Date();
    return {
      currentTime: new Date().toISOString(),
    };
  }

  private startHeartbeatMonitoring(): void {
    // eslint-disable-next-line homey-app/global-timers
    this.heartbeatTimer = setInterval(() => {
      const now = new Date();
      const timeout = this.heartbeatInterval * 3;

      for (const [chargerId, connection] of this.chargerConnections) {
        if (connection.bootNotificationReceived) {
          const timeSinceLastHeartbeat = now.getTime() - connection.lastHeartbeat.getTime();

          if (timeSinceLastHeartbeat > timeout) {
            this.config.logger(`Charger ${chargerId} heartbeat timeout, closing connection`);
            connection.websocket.close(1001, 'Heartbeat timeout');
          }
        }
      }
    }, this.heartbeatInterval);
  }
}
