import Homey = require('homey');
import { OCPPServer, ChargerInfo } from './lib/ocpp/server';
import { ChargerRegistry } from './lib/charger-registry';
import { UnifiedPayload } from './lib/ocpp/protocols';

class OCPPApp extends Homey.App {

  private ocppServer?: OCPPServer;
  public chargerRegistry?: ChargerRegistry;

  async onInit() {
    try {
      // Initialize charger registry
      this.chargerRegistry = new ChargerRegistry(this);
      await this.chargerRegistry.initialize();

      // Get OCPP server configuration
      const serverPort = this.homey.settings.get('ocpp_server_port') ?? 9000;
      const authEnabled = this.homey.settings.get('ocpp_auth_enabled') ?? false;
      const authUsername = this.homey.settings.get('ocpp_auth_username') ?? 'charger';
      const authPassword = this.homey.settings.get('ocpp_auth_password') ?? 'password';

      // Initialize OCPP server
      this.ocppServer = new OCPPServer({
        port: serverPort,
        auth: authEnabled ? { username: authUsername, password: authPassword } : undefined,
        onChargerConnect: this.handleChargerConnect.bind(this),
        onChargerDisconnect: this.handleChargerDisconnect.bind(this),
        onChargerMessage: this.handleChargerMessage.bind(this),
        logger: this.log.bind(this),
      });

      // Set OCPP server reference in charger registry
      this.chargerRegistry.setOCPPServer(this.ocppServer);

      // Start the OCPP server
      await this.ocppServer.start();

      this.log(`OCPP Central System started on port ${serverPort} (auth: ${authEnabled ? 'on' : 'off'})`);

    } catch (error) {
      this.error('Failed to initialize OCPP app:', error);
      throw error;
    }
  }

  async onUninit() {
    if (this.ocppServer) {
      await this.ocppServer.stop();
    }
  }

  private async handleChargerConnect(chargerId: string, chargerInfo: ChargerInfo) {
    this.log(`Charger connected: ${chargerId}`);
    if (this.chargerRegistry) {
      await this.chargerRegistry.registerCharger(chargerId, chargerInfo);
    }
  }

  private async handleChargerDisconnect(chargerId: string) {
    this.log(`Charger disconnected: ${chargerId}`);
    if (this.chargerRegistry) {
      await this.chargerRegistry.unregisterCharger(chargerId);
    }
  }

  private async handleChargerMessage(chargerId: string, messageType: string, payload: UnifiedPayload) {
    if (this.chargerRegistry) {
      await this.chargerRegistry.handleChargerMessage(chargerId, messageType, payload);
    }
  }

  getOCPPServer(): OCPPServer | undefined {
    return this.ocppServer;
  }

  getChargerRegistry(): ChargerRegistry | undefined {
    return this.chargerRegistry;
  }
}

export = OCPPApp;
