import {
  BaseProtocolHandler, UnifiedMessage, UnifiedPayload, MessageResponse, ChargingProfile,
} from './base';

export class OCPP16Handler extends BaseProtocolHandler {
  readonly version = '1.6' as const;
  readonly supportedMessages: string[] = [
    'BootNotification',
    'Heartbeat',
    'StatusNotification',
    'Authorize',
    'StartTransaction',
    'StopTransaction',
    'MeterValues',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
  ];

  parseMessage(messageType: string, payload: Record<string, unknown>, chargePointId: string): UnifiedMessage {
    let unifiedPayload: UnifiedPayload;

    switch (messageType) {
      case 'BootNotification':
        unifiedPayload = {
          chargePointModel: payload.chargePointModel as string,
          chargePointVendor: payload.chargePointVendor as string,
          chargePointSerialNumber: payload.chargePointSerialNumber as string | undefined,
          firmwareVersion: payload.firmwareVersion as string | undefined,
          chargeBoxSerialNumber: payload.chargeBoxSerialNumber,
          iccid: payload.iccid,
          imsi: payload.imsi,
          meterType: payload.meterType,
          meterSerialNumber: payload.meterSerialNumber,
        };
        break;

      case 'StatusNotification':
        unifiedPayload = {
          connectorId: payload.connectorId as number,
          status: payload.status as string,
          timestamp: payload.timestamp as string,
          errorCode: payload.errorCode as string,
          info: payload.info,
          vendorId: payload.vendorId,
          vendorErrorCode: payload.vendorErrorCode,
        };
        break;

      case 'Authorize':
        unifiedPayload = {
          idTag: payload.idTag as string,
        };
        break;

      case 'StartTransaction':
        unifiedPayload = {
          connectorId: payload.connectorId as number,
          idTag: payload.idTag as string,
          timestamp: payload.timestamp as string,
          meterStart: payload.meterStart as number,
          reservationId: payload.reservationId,
        };
        break;

      case 'StopTransaction':
        unifiedPayload = {
          transactionId: payload.transactionId as number,
          idTag: payload.idTag as string,
          timestamp: payload.timestamp as string,
          meterStop: payload.meterStop as number,
          reason: payload.reason as string | undefined,
          transactionData: payload.transactionData,
        };
        break;

      case 'MeterValues':
        unifiedPayload = {
          connectorId: payload.connectorId as number,
          transactionId: payload.transactionId as number | undefined,
          timestamp: payload.timestamp as string,
          meterValue: payload.meterValue,
        };
        break;

      case 'Heartbeat':
        unifiedPayload = {
          timestamp: new Date().toISOString(),
        };
        break;

      case 'DiagnosticsStatusNotification':
        unifiedPayload = {
          status: payload.status as string,
          timestamp: new Date().toISOString(),
        };
        break;

      case 'FirmwareStatusNotification':
        unifiedPayload = {
          status: payload.status as string,
          timestamp: new Date().toISOString(),
        };
        break;

      default:
        unifiedPayload = payload as UnifiedPayload;
    }

    return this.createUnifiedMessage(messageType, payload, chargePointId, unifiedPayload);
  }

  formatResponse(messageType: string, response: MessageResponse): Record<string, unknown> {
    switch (messageType) {
      case 'BootNotification':
        return {
          status: response.status || 'Accepted',
          currentTime: response.currentTime || new Date().toISOString(),
          interval: response.interval || 60,
        };

      case 'Heartbeat':
        return {
          currentTime: response.currentTime || new Date().toISOString(),
        };

      case 'StatusNotification':
      case 'MeterValues':
      case 'DiagnosticsStatusNotification':
      case 'FirmwareStatusNotification':
        return {}; // Empty response

      case 'Authorize':
        return {
          idTagInfo: {
            status: response.idTagInfo?.status || 'Accepted',
            expiryDate: response.idTagInfo?.expiryDate,
            parentIdTag: response.idTagInfo?.parentIdTag,
          },
        };

      case 'StartTransaction':
        return {
          transactionId: response.transactionId || Math.floor(Math.random() * 1000000),
          idTagInfo: {
            status: response.idTagInfo?.status || 'Accepted',
            expiryDate: response.idTagInfo?.expiryDate,
            parentIdTag: response.idTagInfo?.parentIdTag,
          },
        };

      case 'StopTransaction':
        return {
          idTagInfo: response.idTagInfo ? {
            status: response.idTagInfo.status || 'Accepted',
            expiryDate: response.idTagInfo.expiryDate,
            parentIdTag: response.idTagInfo.parentIdTag,
          } : undefined,
        };

      default:
        return response;
    }
  }

  validateMessage(messageType: string, payload: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const baseValidation = super.validateMessage(messageType, payload);
    if (!baseValidation.valid) {
      return baseValidation;
    }

    const errors: string[] = [];

    switch (messageType) {
      case 'BootNotification':
        if (!payload.chargePointModel || typeof payload.chargePointModel !== 'string') {
          errors.push('chargePointModel is required and must be a string');
        }
        if (!payload.chargePointVendor || typeof payload.chargePointVendor !== 'string') {
          errors.push('chargePointVendor is required and must be a string');
        }
        break;

      case 'StatusNotification':
        if (typeof payload.connectorId !== 'number' || payload.connectorId < 0) {
          errors.push('connectorId is required and must be a non-negative number');
        }
        if (!payload.status || typeof payload.status !== 'string') {
          errors.push('status is required and must be a string');
        }
        if (!payload.errorCode || typeof payload.errorCode !== 'string') {
          errors.push('errorCode is required and must be a string');
        }
        break;

      case 'StartTransaction':
        if (typeof payload.connectorId !== 'number' || payload.connectorId <= 0) {
          errors.push('connectorId is required and must be a positive number');
        }
        if (!payload.idTag || typeof payload.idTag !== 'string') {
          errors.push('idTag is required and must be a string');
        }
        if (typeof payload.meterStart !== 'number') {
          errors.push('meterStart is required and must be a number');
        }
        break;

      case 'StopTransaction':
        if (typeof payload.transactionId !== 'number') {
          errors.push('transactionId is required and must be a number');
        }
        if (typeof payload.meterStop !== 'number') {
          errors.push('meterStop is required and must be a number');
        }
        break;

      case 'Authorize':
        if (!payload.idTag || typeof payload.idTag !== 'string') {
          errors.push('idTag is required and must be a string');
        }
        break;

      default:
        break;
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  formatRemoteStartTransaction(connectorId: number, idTag?: string): Record<string, unknown> {
    return {
      connectorId,
      idTag: idTag || 'DefaultIdTag',
    };
  }

  formatRemoteStopTransaction(transactionId: number | string): Record<string, unknown> {
    const numericId = typeof transactionId === 'string' ? parseInt(transactionId, 10) : transactionId;
    return {
      transactionId: numericId,
    };
  }

  formatChangeAvailability(connectorId: number, type: 'Inoperative' | 'Operative'): Record<string, unknown> {
    return {
      connectorId,
      type,
    };
  }

  formatSetChargingProfile(connectorId: number, chargingProfile: ChargingProfile): Record<string, unknown> {
    return {
      connectorId,
      csChargingProfiles: chargingProfile,
    };
  }

  formatClearChargingProfile(connectorId: number, chargingProfileId?: number): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (chargingProfileId !== undefined) {
      payload.id = chargingProfileId;
    }
    if (connectorId > 0) {
      payload.connectorId = connectorId;
    }
    return payload;
  }

  formatPauseChargingProfile(transactionId: number | string, profileId: number): Record<string, unknown> {
    const txId = typeof transactionId === 'string' ? parseInt(transactionId, 10) : transactionId;
    return {
      chargingProfileId: profileId,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{
          startPeriod: 0,
          limit: 0,
        }],
      },
      transactionId: txId,
    };
  }
}
