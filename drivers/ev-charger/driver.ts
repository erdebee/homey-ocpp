import Homey = require('homey');
import FlowCard = require('homey/lib/FlowCard');
import type OCPPApp = require('../../app');
import { ChargerRegistry } from '../../lib/charger-registry';

interface DevicePairingData {
  name: string;
  data: { chargerId: string };
  settings: Record<string, string>;
  capabilities: string[];
  store: Record<string, string | boolean | Date>;
}

class EVChargerDriver extends Homey.Driver {

  private chargerRegistry?: ChargerRegistry;

  async onInit() {
    this.log('EV Charger driver initialized');
    this.chargerRegistry = (this.homey.app as unknown as OCPPApp).getChargerRegistry();
    this.registerFlowCardActions();
  }

  private registerFlowCardActions() {
    this.registerFlowAction('start_charging', async (args) => {
      const connectorId = parseInt(args.connector_id, 10) || 1;
      await args.device.startCharging(connectorId);
    });

    this.registerFlowAction('stop_charging', async (args) => {
      await args.device.stopCharging();
    });

    this.registerFlowAction('pause_charging', async (args) => {
      await args.device.pauseCharging();
    });

    this.registerFlowAction('resume_charging', async (args) => {
      await args.device.resumeCharging();
    });

    this.registerFlowAction('set_charger_availability', async (args) => {
      const isAvailable = args.available === 'true' || args.available === true;
      const connectorId = parseInt(args.connector_id, 10) || 1;
      await args.device.setAvailability(isAvailable, connectorId);
    });
  }

  /**
   * Register a flow card action with standardized error handling.
   */
  private registerFlowAction(cardId: string, handler: FlowCard.RunCallback): void {
    const actionCard = this.homey.flow.getActionCard(cardId);
    actionCard.registerRunListener(async (args, state) => {
      try {
        await handler(args, state);
        return true;
      } catch (error) {
        this.error(`${cardId} action failed:`, error);
        throw new Error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  async onPairListDevices(): Promise<DevicePairingData[]> {
    this.log('Listing available OCPP chargers for pairing...');

    try {
      const registry = this.getRegistry();
      if (!registry) {
        return [];
      }

      const connectedChargers = registry.getConnectedChargers();
      if (!connectedChargers?.length) {
        this.log('No connected chargers found');
        return [];
      }

      // Filter out already paired devices
      const existingChargerIds = this.getDevices().map((d) => d.getData().chargerId);

      const availableChargers = connectedChargers
        .filter((charger) => !existingChargerIds.includes(charger.id) && charger.connected)
        .map((charger) => ({
          name: charger.vendor && charger.model
            ? `${charger.vendor} ${charger.model} - ${charger.id}`
            : `OCPP Charger - ${charger.id}`,
          data: {
            chargerId: charger.id,
          },
          settings: {
            charger_id: charger.id,
            charger_model: charger.model ?? 'Unknown',
            firmware_version: charger.firmwareVersion ?? 'Unknown',
          },
          capabilities: [
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
          ],
          store: {
            vendor: charger.vendor ?? 'Unknown',
            connected: charger.connected,
            protocolVersion: charger.protocolVersion ?? '1.6',
            lastSeen: charger.lastHeartbeat ?? new Date(),
          },
        }));

      this.log(`Found ${availableChargers.length} available chargers for pairing`);
      return availableChargers;

    } catch (error) {
      this.error('Error listing OCPP chargers:', error);
      return [];
    }
  }

  async onPair(session: Homey.Driver.PairSession) {
    this.log('OCPP pairing session started');

    session.setHandler('check_connected_chargers', async () => {
      try {
        const registry = this.getRegistry();
        const chargers = registry?.getConnectedChargers() ?? [];
        return { chargers };
      } catch (error) {
        this.error('Error checking connected chargers:', error);
        return { chargers: [] };
      }
    });

    session.setHandler('showView', async (viewId: string) => {
      this.log(`Showing view: ${viewId}`);
      if (viewId === 'instructions') {
        try {
          await session.emit('view_ready', null);
        } catch {
          // Ignore
        }
      }
    });

    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

  /**
   * Get charger registry, refreshing from app if needed.
   */
  private getRegistry(): ChargerRegistry | undefined {
    if (!this.chargerRegistry) {
      this.chargerRegistry = (this.homey.app as unknown as OCPPApp).getChargerRegistry();
    }
    return this.chargerRegistry;
  }
}

export = EVChargerDriver;
