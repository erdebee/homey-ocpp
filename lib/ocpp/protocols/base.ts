export type ProtocolVersion = '1.6' | '2.0' | '2.0.1';

export interface UnifiedPayload {
  // Common fields that exist in both OCPP 1.6 and 2.0
  connectorId?: number;
  status?: string;
  timestamp?: string;
  idTag?: string;
  transactionId?: number | string;
  meterStart?: number;
  meterStop?: number;
  reason?: string;
  errorCode?: string;

  // Charger info fields
  chargePointModel?: string;
  chargePointVendor?: string;
  chargePointSerialNumber?: string;
  firmwareVersion?: string;

  // Additional fields for extensibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface UnifiedMessage {
  messageType: string;
  payload: UnifiedPayload;
  chargePointId: string;
  timestamp: Date;
  originalVersion: ProtocolVersion;
  originalPayload: Record<string, unknown>;
}

export interface MessageResponse {
  status?: string;
  currentTime?: string;
  interval?: number;
  transactionId?: number | string;
  idTagInfo?: {
    status: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface RemoteCommandResponse {
  status: string;
  [key: string]: unknown;
}

export interface ChargingSchedulePeriod {
  startPeriod: number;
  limit: number;
}

export interface ChargingSchedule {
  id?: number;
  chargingRateUnit: 'A' | 'W';
  chargingSchedulePeriod: ChargingSchedulePeriod[];
}

export interface ChargingProfile {
  chargingProfileId: number;
  stackLevel?: number;
  chargingProfilePurpose?: string;
  chargingProfileKind?: string;
  transactionId?: number | string;
  chargingSchedule: ChargingSchedule | ChargingSchedule[];
}

export interface RemoteCommandParams {
  connectorId?: number;
  idTag?: string;
  transactionId?: number | string;
  type?: 'Inoperative' | 'Operative';
  chargingProfile?: ChargingProfile;
  chargingProfileId?: number;
}

export interface ProtocolHandler {
  readonly version: ProtocolVersion;
  readonly supportedMessages: string[];

  // Message processing
  parseMessage(messageType: string, payload: Record<string, unknown>, chargePointId: string): UnifiedMessage;
  formatResponse(messageType: string, response: MessageResponse): Record<string, unknown>;

  // Protocol-specific validation
  validateMessage(messageType: string, payload: Record<string, unknown>): { valid: boolean; errors?: string[] };

  // Remote commands
  formatRemoteStartTransaction(connectorId: number, idTag?: string): Record<string, unknown>;
  formatRemoteStopTransaction(transactionId: number | string): Record<string, unknown>;
  formatChangeAvailability(connectorId: number, type: 'Inoperative' | 'Operative'): Record<string, unknown>;
  formatSetChargingProfile(connectorId: number, chargingProfile: ChargingProfile): Record<string, unknown>;
  formatClearChargingProfile(connectorId: number, chargingProfileId?: number): Record<string, unknown>;
  formatPauseChargingProfile(transactionId: number | string, profileId: number): Record<string, unknown>;

  // Response parsing
  parseRemoteCommandResponse(command: string, response: Record<string, unknown>): RemoteCommandResponse;
}

export abstract class BaseProtocolHandler implements ProtocolHandler {
  abstract readonly version: ProtocolVersion;
  abstract readonly supportedMessages: string[];

  abstract parseMessage(messageType: string, payload: Record<string, unknown>, chargePointId: string): UnifiedMessage;
  abstract formatResponse(messageType: string, response: MessageResponse): Record<string, unknown>;

  validateMessage(messageType: string, payload: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    if (!messageType || typeof messageType !== 'string') {
      return { valid: false, errors: ['Invalid message type'] };
    }

    if (!this.supportedMessages.includes(messageType)) {
      return { valid: false, errors: [`Unsupported message type: ${messageType}`] };
    }

    return { valid: true };
  }

  abstract formatRemoteStartTransaction(connectorId: number, idTag?: string): Record<string, unknown>;
  abstract formatRemoteStopTransaction(transactionId: number | string): Record<string, unknown>;
  abstract formatChangeAvailability(connectorId: number, type: 'Inoperative' | 'Operative'): Record<string, unknown>;
  abstract formatSetChargingProfile(connectorId: number, chargingProfile: ChargingProfile): Record<string, unknown>;
  abstract formatClearChargingProfile(connectorId: number, chargingProfileId?: number): Record<string, unknown>;
  abstract formatPauseChargingProfile(transactionId: number | string, profileId: number): Record<string, unknown>;

  parseRemoteCommandResponse(_command: string, response: Record<string, unknown>): RemoteCommandResponse {
    const status = typeof response?.status === 'string' ? response.status : 'Unknown';
    return {
      status,
      ...response,
    };
  }

  protected createUnifiedMessage(
    messageType: string,
    payload: Record<string, unknown>,
    chargePointId: string,
    unifiedPayload: UnifiedPayload,
  ): UnifiedMessage {
    return {
      messageType,
      payload: unifiedPayload,
      chargePointId,
      timestamp: new Date(),
      originalVersion: this.version,
      originalPayload: payload,
    };
  }
}
