import { IncomingMessage } from 'http';
import { ProtocolHandler, ProtocolVersion } from './base';
import { OCPP16Handler } from './v16';
import { OCPP20Handler } from './v20';

export interface ProtocolDetectionResult {
  version: ProtocolVersion;
  chargerId: string;
  isValid: boolean;
  error?: string;
}

export class ProtocolFactory {
  private static handlers: Map<ProtocolVersion, ProtocolHandler> = new Map();

  static {
    this.handlers.set('1.6', new OCPP16Handler());
    this.handlers.set('2.0', new OCPP20Handler());
  }

  /**
   * Detect protocol version from WebSocket headers and URL.
   * URL format: /{chargerId}
   * Protocol detected from Sec-WebSocket-Protocol header.
   */
  static detectProtocolFromConnection(url: string, headers: IncomingMessage['headers']): ProtocolDetectionResult {
    try {
      const urlObj = new URL(url, 'http://localhost');
      const pathParts = urlObj.pathname.split('/').filter((part) => part.length > 0);

      if (pathParts.length === 0) {
        return {
          version: '1.6',
          chargerId: '',
          isValid: false,
          error: 'Missing charger ID in URL. Expected /{chargerId}',
        };
      }

      const chargerId = pathParts[0];

      if (!chargerId || chargerId.length === 0) {
        return {
          version: '1.6',
          chargerId: '',
          isValid: false,
          error: 'Invalid charger ID in URL path',
        };
      }

      // Detect protocol version from WebSocket subprotocol header
      const protocolHeader = headers['sec-websocket-protocol'];
      let version: ProtocolVersion = '1.6'; // Default fallback

      if (protocolHeader) {
        const protocols = Array.isArray(protocolHeader)
          ? protocolHeader.join(',').split(',')
          : protocolHeader.split(',');

        for (const protocol of protocols) {
          const cleanProtocol = protocol.trim().toLowerCase();

          // Check for OCPP 2.0.1 first (more specific)
          if (cleanProtocol.includes('2.0.1') || cleanProtocol.includes('ocpp201')) {
            version = '2.0.1';
            break;
          }
          // Check for OCPP 2.0 variants
          if (cleanProtocol.includes('2.0') || cleanProtocol.includes('ocpp2.0') || cleanProtocol.includes('ocpp20')) {
            version = '2.0';
            break;
          }
          // Check for OCPP 1.6 variants
          if (cleanProtocol.includes('1.6') || cleanProtocol.includes('ocpp1.6') || cleanProtocol.includes('ocpp16')) {
            version = '1.6';
            break;
          }
          // Generic OCPP protocol - default to 1.6
          if (cleanProtocol === 'ocpp') {
            version = '1.6';
            break;
          }
        }
      }

      return {
        version,
        chargerId,
        isValid: true,
      };

    } catch (error) {
      return {
        version: '1.6',
        chargerId: '',
        isValid: false,
        error: `Invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get protocol handler for a specific version.
   * OCPP 2.0.1 is handled by the 2.0 handler.
   */
  static getHandler(version: ProtocolVersion): ProtocolHandler {
    // 2.0.1 uses the same handler as 2.0
    const lookupVersion = version === '2.0.1' ? '2.0' : version;
    const handler = this.handlers.get(lookupVersion);
    if (!handler) {
      throw new Error(`No handler available for OCPP version ${version}`);
    }
    return handler;
  }

  /**
   * Get all supported protocol versions
   */
  static getSupportedVersions(): ProtocolVersion[] {
    return Array.from(this.handlers.keys());
  }
}
