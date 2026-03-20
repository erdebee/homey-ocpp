import Homey = require('homey');
import type EVChargerDevice = require('../drivers/ev-charger/device');
import { OCPPServer, ChargerInfo } from './ocpp/server';
import {
  ProtocolVersion, ProtocolFactory, UnifiedPayload, RemoteCommandResponse, RemoteCommandParams, ChargingProfile,
} from './ocpp/protocols';

interface ConnectorStatus {
  status: 'Available' | 'Preparing' | 'Charging' | 'SuspendedEV' | 'SuspendedEVSE' | 'Finishing' | 'Reserved' | 'Unavailable' | 'Faulted';
  errorCode?: string;
  vendorErrorCode?: string;
  vendorId?: string;
  timestamp: Date;
}

interface ChargerState {
  id: string;
  model: string;
  vendor: string;
  serialNumber?: string;
  firmwareVersion?: string;
  connected: boolean;
  protocolVersion?: ProtocolVersion;
  connectorStatus: Map<number, ConnectorStatus>;
  activeTransaction?: {
    id: number | string;
    connectorId: number;
    idTag: string;
    startTime: Date;
    meterStart: number;
    currentMeterValue?: number;
  };
  lastHeartbeat?: Date;
}

export class ChargerRegistry {
  private app: Homey.App;
  private chargers: Map<string, ChargerState> = new Map();
  private ocppServer?: OCPPServer;

  constructor(app: Homey.App) {
    this.app = app;
  }

  async initialize(): Promise<void> {
    this.app.log('ChargerRegistry initialized');
    this.loadPersistedChargers();
  }

  setOCPPServer(server: OCPPServer): void {
    this.ocppServer = server;
  }

  async registerCharger(chargerId: string, chargerInfo: ChargerInfo): Promise<void> {
    this.app.log(`Registering charger: ${chargerId} (OCPP ${chargerInfo.protocolVersion ?? 'unknown'})`);

    const existingCharger = this.chargers.get(chargerId);
    const chargerState: ChargerState = {
      id: chargerId,
      model: chargerInfo.chargePointModel ?? 'Unknown',
      vendor: chargerInfo.chargePointVendor ?? 'Unknown',
      serialNumber: chargerInfo.chargePointSerialNumber,
      firmwareVersion: chargerInfo.firmwareVersion,
      connected: true,
      protocolVersion: chargerInfo.protocolVersion,
      connectorStatus: existingCharger?.connectorStatus ?? new Map(),
      activeTransaction: existingCharger?.activeTransaction,
      lastHeartbeat: new Date(),
    };

    this.chargers.set(chargerId, chargerState);
    this.persistCharger(chargerState);

    await this.updateHomeyDevice(chargerId, {
      connected: true,
      protocol_version: chargerInfo.protocolVersion ?? 'unknown',
    });

    await this.triggerFlow('charger_connected', {
      charger_id: chargerId,
      model: chargerInfo.chargePointModel ?? 'Unknown',
      vendor: chargerInfo.chargePointVendor ?? 'Unknown',
    });
  }

  async unregisterCharger(chargerId: string): Promise<void> {
    this.app.log(`Unregistering charger: ${chargerId}`);

    const charger = this.chargers.get(chargerId);
    if (charger) {
      charger.connected = false;
      charger.lastHeartbeat = undefined;

      await this.updateHomeyDevice(chargerId, { connected: false });
      await this.triggerFlow('charger_disconnected', { charger_id: chargerId });
      this.persistCharger(charger);
    }
  }

  async handleChargerMessage(chargerId: string, messageType: string, payload: UnifiedPayload): Promise<void> {
    const charger = this.chargers.get(chargerId);
    if (!charger) {
      this.app.log(`Unknown charger ${chargerId}, ignoring message`);
      return;
    }

    // Re-connect if charger was marked disconnected but is sending messages
    let wasDisconnected = false;
    if (!charger.connected) {
      this.app.log(`Charger ${chargerId} was disconnected but sent ${messageType}, marking connected`);
      charger.connected = true;
      wasDisconnected = true;
    }

    switch (messageType) {
      case 'StatusNotification':
        await this.handleStatusNotification(chargerId, charger, payload);
        break;
      case 'StartTransaction':
        await this.handleStartTransaction(chargerId, charger, payload);
        break;
      case 'StopTransaction':
        await this.handleStopTransaction(chargerId, charger, payload);
        break;
      case 'MeterValues':
        await this.handleMeterValues(chargerId, charger, payload);
        break;
      case 'Authorize':
        this.app.log(`Authorization request from ${chargerId} for tag ${payload.idTag}`);
        break;
      default:
        this.app.log(`Unhandled message type: ${messageType}`);
        this.updateHeartbeatAndPersist(charger);
    }

    if (wasDisconnected) {
      await this.updateHomeyDevice(chargerId, { connected: true });
    }
  }

  getConnectedChargers(): ChargerState[] {
    return Array.from(this.chargers.values()).filter((charger) => charger.connected);
  }

  getCharger(chargerId: string): ChargerState | null {
    return this.chargers.get(chargerId) ?? null;
  }

  getAllChargers(): ChargerState[] {
    return Array.from(this.chargers.values());
  }

  async sendRemoteCommand(chargerId: string, command: 'start' | 'stop' | 'availability' | 'setProfile' | 'clearProfile', params: RemoteCommandParams): Promise<RemoteCommandResponse> {
    if (!this.ocppServer) {
      throw new Error('OCPP server not available');
    }

    const charger = this.chargers.get(chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${chargerId} is not connected`);
    }

    switch (command) {
      case 'start':
        return this.ocppServer.sendRemoteStartTransaction(
          chargerId,
          params.connectorId ?? 1,
          params.idTag,
        );

      case 'stop': {
        const transactionId = params.transactionId ?? charger.activeTransaction?.id;
        if (!transactionId) {
          throw new Error(`No active transaction found for charger ${chargerId}`);
        }
        return this.ocppServer.sendRemoteStopTransaction(chargerId, transactionId);
      }

      case 'availability':
        return this.ocppServer.changeAvailability(
          chargerId,
          params.connectorId ?? 1,
          params.type!,
        );

      case 'setProfile':
        return this.ocppServer.sendSetChargingProfile(
          chargerId,
          params.connectorId ?? 1,
          params.chargingProfile!,
        );

      case 'clearProfile':
        return this.ocppServer.sendClearChargingProfile(
          chargerId,
          params.connectorId ?? 1,
          params.chargingProfileId,
        );

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  /**
   * Pause charging by setting a zero-power charging profile.
   * Delegates profile format to the protocol handler.
   */
  async pauseCharging(chargerId: string, connectorId: number = 1): Promise<RemoteCommandResponse> {
    const charger = this.chargers.get(chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${chargerId} is not connected`);
    }
    if (!charger.activeTransaction) {
      throw new Error(`No active transaction found for charger ${chargerId}`);
    }

    const profileId = this.getPauseProfileId(charger.activeTransaction.id);
    const protocolHandler = this.getProtocolHandler(charger.protocolVersion);
    const chargingProfile = protocolHandler.formatPauseChargingProfile(charger.activeTransaction.id, profileId) as unknown as ChargingProfile;

    return this.sendRemoteCommand(chargerId, 'setProfile', {
      connectorId,
      chargingProfile,
    });
  }

  /**
   * Resume charging by clearing the pause profile.
   */
  async resumeCharging(chargerId: string, connectorId: number = 1): Promise<RemoteCommandResponse> {
    const charger = this.chargers.get(chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${chargerId} is not connected`);
    }
    if (!charger.activeTransaction) {
      throw new Error(`No active transaction found for charger ${chargerId}`);
    }

    const pauseProfileId = this.getPauseProfileId(charger.activeTransaction.id);

    return this.sendRemoteCommand(chargerId, 'clearProfile', {
      connectorId,
      chargingProfileId: pauseProfileId,
    });
  }

  // ---- Private helpers ----

  private getProtocolHandler(protocolVersion?: ProtocolVersion) {
    return ProtocolFactory.getHandler(protocolVersion ?? '1.6');
  }

  /**
   * Generate a consistent profile ID for pause functionality.
   */
  private getPauseProfileId(transactionId: number | string): number {
    const baseId = 90000;
    const txIdNum = typeof transactionId === 'string'
      ? parseInt(transactionId, 10) || 0
      : transactionId;
    return baseId + (txIdNum % 10000);
  }

  private updateHeartbeatAndPersist(charger: ChargerState): void {
    charger.lastHeartbeat = new Date();
    this.persistCharger(charger);
  }

  private async handleStatusNotification(chargerId: string, charger: ChargerState, payload: UnifiedPayload): Promise<void> {
    const connectorId = parseInt(String(payload.connectorId ?? 1), 10);
    const status: ConnectorStatus = {
      status: payload.status as ConnectorStatus['status'],
      errorCode: payload.errorCode,
      vendorErrorCode: payload.vendorErrorCode as string | undefined,
      vendorId: payload.vendorId as string | undefined,
      timestamp: new Date(payload.timestamp || Date.now()),
    };

    charger.connectorStatus.set(connectorId, status);
    this.updateHeartbeatAndPersist(charger);

    await this.updateHomeyDevice(chargerId, {
      charging_status: this.validateOCPPStatus(payload.status as string),
    });

    this.app.log(`Charger ${chargerId} connector ${connectorId} status: ${payload.status}`);
  }

  private async handleStartTransaction(chargerId: string, charger: ChargerState, payload: UnifiedPayload): Promise<void> {
    const transactionId = payload.transactionId ?? (charger.protocolVersion === '1.6'
      ? Math.floor(Math.random() * 1000000)
      : Math.floor(Math.random() * 1000000).toString());

    charger.activeTransaction = {
      id: transactionId,
      connectorId: (payload.connectorId ?? 1) as number,
      idTag: payload.idTag as string,
      startTime: new Date(payload.timestamp as string),
      meterStart: payload.meterStart as number,
    };

    this.updateHeartbeatAndPersist(charger);

    await this.triggerFlow('charging_started', {
      charger_id: chargerId,
      connector_id: payload.connectorId ?? 1,
      id_tag: payload.idTag ?? '',
      transaction_id: charger.activeTransaction.id,
    });

    this.app.log(`Transaction started on charger ${chargerId} (${charger.protocolVersion}): ${charger.activeTransaction.id}`);
  }

  private async handleStopTransaction(chargerId: string, charger: ChargerState, payload: UnifiedPayload): Promise<void> {
    if (!charger.activeTransaction) return;

    const transaction = charger.activeTransaction;
    const energyConsumed = ((payload.meterStop as number) ?? 0) - transaction.meterStart;
    const endTime = new Date(payload.timestamp as string);
    const duration = endTime.getTime() - transaction.startTime.getTime();

    await this.triggerFlow('charging_stopped', {
      charger_id: chargerId,
      connector_id: payload.connectorId ?? 1,
      transaction_id: transaction.id,
      energy_consumed: energyConsumed,
      duration_minutes: Math.round(duration / 60000),
    });

    charger.activeTransaction = undefined;
    this.updateHeartbeatAndPersist(charger);

    this.app.log(`Transaction stopped on charger ${chargerId}`);
  }

  private async handleMeterValues(chargerId: string, charger: ChargerState, payload: UnifiedPayload): Promise<void> {
    const meterValues = (payload.meterValue ?? []) as Array<Record<string, unknown>>;
    for (const meterValue of meterValues) {
      const sampledValues = (meterValue.sampledValue ?? []) as Array<Record<string, unknown>>;
      for (const sample of sampledValues) {
        if (sample.measurand === 'Energy.Active.Import.Register' && charger.activeTransaction) {
          charger.activeTransaction.currentMeterValue = parseFloat(sample.value as string);
          break;
        }
      }
    }

    this.updateHeartbeatAndPersist(charger);
    await this.updateHomeyDeviceMeterValues(chargerId, payload);
  }

  private async updateHomeyDevice(chargerId: string, capabilities: Record<string, string | number | boolean | null>): Promise<void> {
    try {
      const device = this.getDeviceForCharger(chargerId);
      if (device) {
        for (const [capability, value] of Object.entries(capabilities)) {
          if (device.hasCapability(capability)) {
            await device.setCapabilityValue(capability, value);
          }
        }
      }
    } catch (error) {
      this.app.log(`Error updating Homey device for charger ${chargerId}:`, error);
    }
  }

  private async updateHomeyDeviceMeterValues(chargerId: string, meterValuesPayload: UnifiedPayload): Promise<void> {
    try {
      const device = this.getDeviceForCharger(chargerId);
      if (device && typeof (device as unknown as EVChargerDevice).updateMeterValues === 'function') {
        await (device as unknown as EVChargerDevice).updateMeterValues(meterValuesPayload);
      }
    } catch (error) {
      this.app.log(`Error updating device meter values for charger ${chargerId}:`, error);
    }
  }

  /**
   * Look up the Homey device for a given charger ID.
   */
  private getDeviceForCharger(chargerId: string): Homey.Device | undefined {
    try {
      const driver = this.app.homey.drivers.getDriver('ev-charger');
      const devices = driver.getDevices();
      return devices.find((d) => d.getData().chargerId === chargerId);
    } catch {
      return undefined;
    }
  }

  private async triggerFlow(cardId: string, data: Record<string, string | number | boolean | null>): Promise<void> {
    try {
      const triggerCard = this.app.homey.flow.getTriggerCard(cardId);
      if (triggerCard) {
        await triggerCard.trigger(data);
      }
    } catch (error) {
      this.app.log(`Error triggering ${cardId} flow:`, error);
    }
  }

  private validateOCPPStatus(ocppStatus: string): string {
    // OCPP 2.0 'Occupied' maps to 'Charging' for Homey
    if (ocppStatus === 'Occupied') {
      return 'Charging';
    }

    const validStatuses = [
      'Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE',
      'Finishing', 'Reserved', 'Unavailable', 'Faulted',
    ];

    return validStatuses.includes(ocppStatus) ? ocppStatus : 'Available';
  }

  private loadPersistedChargers(): void {
    try {
      const persistedChargers = this.app.homey.settings.get('chargers') ?? {};

      for (const [chargerId, data] of Object.entries(persistedChargers)) {
        const chargerData = data as Record<string, unknown>;
        const chargerState: ChargerState = {
          id: (chargerData.id as string) ?? chargerId,
          model: (chargerData.model as string) ?? 'Unknown',
          vendor: (chargerData.vendor as string) ?? 'Unknown',
          serialNumber: chargerData.serialNumber as string | undefined,
          firmwareVersion: chargerData.firmwareVersion as string | undefined,
          connected: false,
          protocolVersion: chargerData.protocolVersion as ProtocolVersion | undefined,
          connectorStatus: new Map(chargerData.connectorStatus
            ? Object.entries(chargerData.connectorStatus as Record<string, ConnectorStatus>).map(([id, status]) => [parseInt(id, 10), status])
            : []),
          lastHeartbeat: chargerData.lastHeartbeat ? new Date(chargerData.lastHeartbeat as string) : undefined,
        };

        this.chargers.set(chargerId, chargerState);
      }

      this.app.log(`Loaded ${this.chargers.size} persisted chargers`);
    } catch (error) {
      this.app.log('Error loading persisted chargers:', error);
    }
  }

  private persistCharger(charger: ChargerState): void {
    try {
      const persistedChargers = this.app.homey.settings.get('chargers') ?? {};

      persistedChargers[charger.id] = {
        ...charger,
        connectorStatus: Object.fromEntries(charger.connectorStatus),
      };

      this.app.homey.settings.set('chargers', persistedChargers);
    } catch (error) {
      this.app.log(`Error persisting charger ${charger.id}:`, error);
    }
  }
}
