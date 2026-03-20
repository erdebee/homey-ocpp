import Homey = require('homey');
import type OCPPApp = require('../../app');
import { ChargerRegistry } from '../../lib/charger-registry';
import { UnifiedPayload } from '../../lib/ocpp/protocols';

const REQUIRED_CAPABILITIES = [
  'charging_status',
  'connected',
  'protocol_version',
  'charging_start',
  'charging_stop',
  'charging_pause',
  'charging_resume',
  'measure_power',
  'meter_power',
  'measure_voltage',
  'measure_current',
  'target_current',
];

class EVChargerDevice extends Homey.Device {

  private chargerId!: string;
  private chargerRegistry?: ChargerRegistry;
  private syncInterval?: NodeJS.Timeout;

  async onInit() {
    this.chargerId = this.getData().chargerId;
    this.log(`EV Charger device initialized: ${this.chargerId}`);

    this.chargerRegistry = (this.homey.app as unknown as OCPPApp).chargerRegistry;

    // Ensure all required capabilities are present
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    // Set default target current if freshly added
    if (this.getCapabilityValue('target_current') == null) {
      await this.setCapabilityValue('target_current', 16);
    }

    // Register charging control button listeners
    const buttonActions: Record<string, () => Promise<void>> = {
      charging_start: () => this.startCharging(),
      charging_stop: () => this.stopCharging(),
      charging_pause: () => this.pauseCharging(),
      charging_resume: () => this.resumeCharging(),
    };

    for (const [capability, action] of Object.entries(buttonActions)) {
      this.registerCapabilityListener(capability, async () => {
        try {
          await action();
        } catch (error) {
          this.error(`${capability} button error:`, error);
          throw error;
        }
      });
    }

    // Register target current listener
    this.registerCapabilityListener('target_current', async (value: number) => {
      try {
        await this.setChargingCurrent(value);
      } catch (error) {
        this.error('Failed to set charging current:', error);
        throw error;
      }
    });

    // Initial sync and periodic updates
    await this.updateCapabilitiesFromRegistry();

    this.syncInterval = this.homey.setInterval(() => {
      this.updateCapabilitiesFromRegistry().catch((error) => {
        this.error('Error during periodic capability sync:', error);
      });
    }, 30000);
  }

  async onDeleted() {
    this.log(`Device ${this.chargerId} deleted`);
    if (this.syncInterval) {
      this.homey.clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
  }

  private requireRegistry(): ChargerRegistry {
    if (!this.chargerRegistry) {
      throw new Error('Charger registry not available');
    }
    return this.chargerRegistry;
  }

  async startCharging(connectorId: number = 1, idTag?: string): Promise<void> {
    this.log(`Starting charging on connector ${connectorId}`);
    const registry = this.requireRegistry();

    const charger = registry.getCharger(this.chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${this.chargerId} is not connected`);
    }
    if (charger.activeTransaction) {
      throw new Error(`Charger ${this.chargerId} is already charging (transaction ${charger.activeTransaction.id})`);
    }

    const response = await registry.sendRemoteCommand(this.chargerId, 'start', {
      connectorId,
      idTag: idTag ?? 'DefaultIdTag',
    });

    if (response.status !== 'Accepted') {
      throw new Error(`Remote start transaction rejected: ${response.status}`);
    }
    this.log(`Remote start accepted by charger ${this.chargerId}`);
  }

  async stopCharging(): Promise<void> {
    this.log('Stopping charging');
    const registry = this.requireRegistry();

    const charger = registry.getCharger(this.chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${this.chargerId} is not connected`);
    }
    if (!charger.activeTransaction) {
      throw new Error(`Charger ${this.chargerId} is not currently charging`);
    }

    const response = await registry.sendRemoteCommand(this.chargerId, 'stop', {
      transactionId: charger.activeTransaction.id,
    });

    if (response.status !== 'Accepted') {
      throw new Error(`Remote stop transaction rejected: ${response.status}`);
    }
    this.log(`Remote stop accepted by charger ${this.chargerId}`);
  }

  async pauseCharging(connectorId: number = 1): Promise<void> {
    this.log('Pausing charging');
    const registry = this.requireRegistry();

    const response = await registry.pauseCharging(this.chargerId, connectorId);
    if (response.status !== 'Accepted') {
      throw new Error(`Pause charging rejected: ${response.status}`);
    }
    this.log('Charging paused successfully');
  }

  async resumeCharging(connectorId: number = 1): Promise<void> {
    this.log('Resuming charging');
    const registry = this.requireRegistry();

    const response = await registry.resumeCharging(this.chargerId, connectorId);
    if (response.status !== 'Accepted') {
      throw new Error(`Resume charging rejected: ${response.status}`);
    }
    this.log('Charging resumed successfully');
  }

  async setAvailability(available: boolean, connectorId: number = 1): Promise<void> {
    this.log(`Setting availability to: ${available}`);
    const registry = this.requireRegistry();

    const charger = registry.getCharger(this.chargerId);
    if (!charger?.connected) {
      throw new Error(`Charger ${this.chargerId} is not connected`);
    }

    const response = await registry.sendRemoteCommand(this.chargerId, 'availability', {
      connectorId,
      type: available ? 'Operative' : 'Inoperative',
    });

    if (response.status !== 'Accepted') {
      throw new Error(`Change availability rejected: ${response.status}`);
    }
    this.log(`Availability change accepted by charger ${this.chargerId}`);
  }

  async setChargingCurrent(currentLimit: number): Promise<void> {
    this.log(`Setting charging current limit to ${currentLimit}A`);
    const registry = this.requireRegistry();

    if (currentLimit < 6 || currentLimit > 32) {
      throw new Error('Current limit must be between 6A and 32A');
    }

    const chargingProfile = {
      chargingProfileId: Date.now(),
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A' as const,
        chargingSchedulePeriod: [{
          startPeriod: 0,
          limit: currentLimit,
        }],
      },
    };

    const response = await registry.sendRemoteCommand(this.chargerId, 'setProfile', {
      connectorId: 1,
      chargingProfile,
    });

    if (response.status !== 'Accepted') {
      throw new Error(`Current limit rejected: ${response.status}`);
    }
    this.log(`Charging current limit set to ${currentLimit}A successfully`);
    await this.setCapabilityValue('target_current', currentLimit);
  }

  async updateMeterValues(meterValues: UnifiedPayload): Promise<void> {
    try {
      const values = this.parseMeterValues(meterValues);

      if (values.power !== undefined) {
        await this.setCapabilityValue('measure_power', values.power);
      }
      if (values.energy !== undefined) {
        await this.setCapabilityValue('meter_power', values.energy);
      }
      if (values.voltage !== undefined) {
        await this.setCapabilityValue('measure_voltage', values.voltage);
      }
      if (values.current !== undefined) {
        await this.setCapabilityValue('measure_current', values.current);
      }
    } catch (error) {
      this.error('Failed to update meter values:', error);
    }
  }

  // ---- Private ----

  private async updateCapabilitiesFromRegistry(): Promise<void> {
    try {
      if (!this.chargerRegistry) return;

      const charger = this.chargerRegistry.getCharger(this.chargerId);
      if (!charger) {
        return;
      }

      // Update connected status
      await this.setCapabilityIfChanged('connected', charger.connected);

      // Update protocol version
      if (charger.protocolVersion) {
        await this.setCapabilityIfChanged('protocol_version', charger.protocolVersion);
      }

      // Update charging status from connector status (single source of truth)
      if (this.hasCapability('charging_status')) {
        let status = 'Available';

        if (charger.connectorStatus.size > 0) {
          const firstConnectorStatus = charger.connectorStatus.values().next().value;
          if (firstConnectorStatus) {
            status = this.mapOCPPStatus(firstConnectorStatus.status);
          }
        }

        await this.setCapabilityIfChanged('charging_status', status);
      }
    } catch (error) {
      this.error('Failed to update capabilities from registry:', error);
    }
  }

  /**
   * Only update a capability if the value has actually changed.
   */
  private async setCapabilityIfChanged(capability: string, value: string | number | boolean | null): Promise<void> {
    if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

  /**
   * Map OCPP status strings to Homey capability values.
   * OCPP 2.0 'Occupied' maps to 'Charging'.
   */
  private mapOCPPStatus(ocppStatus: string): string {
    if (ocppStatus === 'Occupied') {
      return 'Charging';
    }

    const validStatuses = [
      'Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE',
      'Finishing', 'Reserved', 'Unavailable', 'Faulted',
    ];

    return validStatuses.includes(ocppStatus) ? ocppStatus : 'Available';
  }

  private parseMeterValues(meterValues: UnifiedPayload): { power?: number; energy?: number; current?: number; voltage?: number } {
    const values: { power?: number; energy?: number; current?: number; voltage?: number } = {};

    try {
      if (!meterValues?.meterValue) {
        return values;
      }

      const meterValueArr = meterValues.meterValue as Array<Record<string, unknown>>;
      const meterValue = Array.isArray(meterValueArr)
        ? meterValueArr[0]
        : meterValueArr;

      if (!meterValue?.sampledValue) {
        return values;
      }

      const sampledValueArr = meterValue.sampledValue as Array<Record<string, unknown>>;
      const sampledValues = Array.isArray(sampledValueArr)
        ? sampledValueArr
        : [sampledValueArr];

      for (const sample of sampledValues) {
        const value = parseFloat(sample.value as string);
        if (Number.isNaN(value)) continue;

        const measurand = (sample.measurand as string) ?? 'Energy.Active.Import.Register';
        const unit = sample.unit as string | undefined;

        switch (measurand) {
          case 'Power.Active.Import': {
            let powerValue: number | undefined;
            if (!unit || unit === 'W') {
              powerValue = value;
            } else if (unit === 'kW') {
              powerValue = value * 1000;
            }
            values.power = powerValue;
            break;
          }

          case 'Energy.Active.Import.Register': {
            let energyValue: number | undefined;
            if (!unit || unit === 'Wh') {
              energyValue = value / 1000;
            } else if (unit === 'kWh') {
              energyValue = value;
            }
            values.energy = energyValue;
            break;
          }

          case 'Current.Import':
          case 'Current.Offered':
            if (!unit || unit === 'A') {
              values.current = value;
            }
            break;

          case 'Voltage':
            if (!unit || unit === 'V') {
              values.voltage = value;
            }
            break;

          default:
            break;
        }
      }
    } catch (error) {
      this.error('Error parsing meter values:', error);
    }

    return values;
  }
}

export = EVChargerDevice;
