import {
  BaseProtocolHandler, UnifiedMessage, UnifiedPayload, MessageResponse, ChargingProfile,
} from './base';

export class OCPP20Handler extends BaseProtocolHandler {
  readonly version = '2.0' as const;
  readonly supportedMessages: string[] = [
    'BootNotification',
    'Heartbeat',
    'StatusNotification',
    'Authorize',
    'MeterValues',
    'TransactionEvent',
  ];

  parseMessage(messageType: string, payload: Record<string, unknown>, chargePointId: string): UnifiedMessage {
    let unifiedPayload: UnifiedPayload;

    switch (messageType) {
      case 'BootNotification': {
        const chargingStation = payload.chargingStation as Record<string, unknown> | undefined;
        unifiedPayload = {
          chargePointModel: (chargingStation?.model ?? payload.chargePointModel) as string,
          chargePointVendor: (chargingStation?.vendorName ?? payload.chargePointVendor) as string,
          chargePointSerialNumber: (chargingStation?.serialNumber ?? payload.chargePointSerialNumber) as string | undefined,
          firmwareVersion: (chargingStation?.firmwareVersion ?? payload.firmwareVersion) as string | undefined,
        };
        break;
      }

      case 'StatusNotification': {
        const statusInfo = payload.statusInfo as Record<string, unknown> | undefined;
        unifiedPayload = {
          connectorId: payload.connectorId as number,
          status: payload.connectorStatus as string,
          timestamp: payload.timestamp as string,
          errorCode: statusInfo?.reasonCode as string | undefined,
        };
        break;
      }

      case 'Authorize': {
        const idToken = payload.idToken as Record<string, unknown> | undefined;
        unifiedPayload = {
          idTag: (idToken?.idToken ?? payload.idTag) as string,
        };
        break;
      }

      case 'TransactionEvent': {
        const evse = payload.evse as Record<string, unknown> | undefined;
        const txIdToken = payload.idToken as Record<string, unknown> | undefined;
        const txInfo = payload.transactionInfo as Record<string, unknown> | undefined;
        const meterValue = payload.meterValue as Array<Record<string, unknown>> | undefined;
        const sampledValue = meterValue?.[0]?.sampledValue as Array<Record<string, unknown>> | undefined;

        if (payload.eventType === 'Started') {
          unifiedPayload = {
            connectorId: (evse?.id ?? payload.connectorId) as number,
            idTag: (txIdToken?.idToken ?? payload.idTag) as string,
            timestamp: payload.timestamp as string,
            meterStart: (sampledValue?.[0]?.value ?? payload.meterStart) as number,
            transactionId: (txInfo?.transactionId ?? payload.transactionId) as string,
          };
          return this.createUnifiedMessage('StartTransaction', payload, chargePointId, unifiedPayload);
        } if (payload.eventType === 'Ended') {
          unifiedPayload = {
            transactionId: (txInfo?.transactionId ?? payload.transactionId) as string,
            idTag: (txIdToken?.idToken ?? payload.idTag) as string,
            timestamp: payload.timestamp as string,
            meterStop: (sampledValue?.[0]?.value ?? payload.meterStop) as number,
            reason: payload.reason as string | undefined,
          };
          return this.createUnifiedMessage('StopTransaction', payload, chargePointId, unifiedPayload);
        }
        // Updated event — pass through as generic
        unifiedPayload = payload as UnifiedPayload;
        break;
      }

      case 'MeterValues': {
        const mvEvse = payload.evse as Record<string, unknown> | undefined;
        const mvTxInfo = payload.transactionInfo as Record<string, unknown> | undefined;
        unifiedPayload = {
          connectorId: (mvEvse?.id ?? payload.connectorId) as number,
          transactionId: mvTxInfo?.transactionId as string | undefined,
          timestamp: payload.timestamp as string,
          meterValue: payload.meterValue,
        };
        break;
      }

      case 'Heartbeat':
        unifiedPayload = {
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
          statusInfo: response.status === 'Rejected' ? { reasonCode: 'NoError' } : undefined,
        };

      case 'Heartbeat':
        return {
          currentTime: response.currentTime || new Date().toISOString(),
        };

      case 'StatusNotification':
      case 'MeterValues':
        return {};

      case 'Authorize':
        return {
          idTokenInfo: {
            status: response.idTagInfo?.status || 'Accepted',
          },
        };

      case 'TransactionEvent':
        if (response.transactionId) {
          return {
            transactionId: response.transactionId.toString(),
            idTokenInfo: {
              status: response.idTagInfo?.status || 'Accepted',
            },
          };
        }
        return {
          idTokenInfo: {
            status: response.idTagInfo?.status || 'Accepted',
          },
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
      case 'BootNotification': {
        const cs = payload.chargingStation as Record<string, unknown> | undefined;
        if (!cs || typeof cs !== 'object') {
          errors.push('chargingStation object is required');
        } else {
          if (!cs.model || typeof cs.model !== 'string') {
            errors.push('chargingStation.model is required and must be a string');
          }
          if (!cs.vendorName || typeof cs.vendorName !== 'string') {
            errors.push('chargingStation.vendorName is required and must be a string');
          }
        }
        break;
      }

      case 'StatusNotification':
        if (!payload.connectorStatus || typeof payload.connectorStatus !== 'string') {
          errors.push('connectorStatus is required and must be a string');
        }
        break;

      case 'TransactionEvent': {
        const ti = payload.transactionInfo as Record<string, unknown> | undefined;
        if (!payload.eventType || typeof payload.eventType !== 'string') {
          errors.push('eventType is required and must be a string');
        }
        if (!ti || !ti.transactionId) {
          errors.push('transactionInfo.transactionId is required');
        }
        break;
      }

      case 'Authorize': {
        const authToken = payload.idToken as Record<string, unknown> | undefined;
        if (!authToken || !authToken.idToken) {
          errors.push('idToken.idToken is required');
        }
        break;
      }

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
      evseId: connectorId,
      idToken: {
        idToken: idTag || 'DefaultIdTag',
        type: 'ISO14443',
      },
    };
  }

  formatRemoteStopTransaction(transactionId: number | string): Record<string, unknown> {
    return {
      transactionId: transactionId.toString(),
    };
  }

  formatChangeAvailability(connectorId: number, type: 'Inoperative' | 'Operative'): Record<string, unknown> {
    return {
      evse: {
        id: connectorId,
      },
      operationalStatus: type,
    };
  }

  formatSetChargingProfile(connectorId: number, chargingProfile: ChargingProfile): Record<string, unknown> {
    return {
      evseId: connectorId,
      chargingProfile,
    };
  }

  formatClearChargingProfile(connectorId: number, chargingProfileId?: number): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (chargingProfileId !== undefined) {
      payload.chargingProfileId = chargingProfileId;
    }
    if (connectorId > 0) {
      payload.chargingProfileCriteria = {
        evseId: connectorId,
      };
    }
    return payload;
  }

  formatPauseChargingProfile(transactionId: number | string, profileId: number): Record<string, unknown> {
    return {
      id: profileId,
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: [{
        id: 1,
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{
          startPeriod: 0,
          limit: 0,
        }],
      }],
      transactionId: transactionId.toString(),
    };
  }
}
