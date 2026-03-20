/**
 * Simple RPC implementation for OCPP WebSocket communication.
 * Implements the OCPP-J (JSON over WebSocket) message format:
 *   CALL:       [2, messageId, action, payload]
 *   CALLRESULT: [3, messageId, payload]
 *   CALLERROR:  [4, messageId, errorCode, errorDescription, errorDetails]
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import type { RawData } from 'ws';

export interface OCPPWebSocket extends WebSocket {
  chargePointId?: string;
}

export class SimpleRPCError extends Error {
  public type: string;
  public details: unknown;

  constructor(type: string, message: string, details?: unknown) {
    super(message);
    this.type = type;
    this.details = details;
    this.name = 'SimpleRPCError';
  }
}

type HandlerFn = (params: Record<string, unknown>, context: { chargePointId: string }) => Promise<Record<string, unknown>>;

export class SimpleRPCServer extends EventEmitter {
  private handlers: Map<string, HandlerFn> = new Map();

  handle(action: string, handler: HandlerFn): void {
    this.handlers.set(action, handler);
  }

  /* eslint-disable no-use-before-define */
  createClient(ws: WebSocket): SimpleRPCClient {
    return new SimpleRPCClient(ws, this);
  }
  /* eslint-enable no-use-before-define */

  async handleMessage(action: string, params: Record<string, unknown>, chargePointId: string): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(action);
    if (!handler) {
      throw new SimpleRPCError('NotSupported', `Action ${action} not supported`);
    }
    return handler(params, { chargePointId });
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SimpleRPCClient extends EventEmitter {
  private ws: WebSocket;
  private server: SimpleRPCServer;
  private pendingCalls: Map<string, PendingCall> = new Map();
  private messageCounter = 0;
  private chargePointId: string;

  constructor(ws: WebSocket, server: SimpleRPCServer) {
    super();
    this.ws = ws;
    this.server = server;
    this.chargePointId = (ws as OCPPWebSocket).chargePointId || 'unknown';

    this.ws.on('message', (data: RawData) => {
      this.handleMessage(data);
    });

    this.ws.on('close', () => {
      // Reject all pending calls and clear their timers
      for (const pending of this.pendingCalls.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket closed'));
      }
      this.pendingCalls.clear();
    });
  }

  async call(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const messageId = (++this.messageCounter).toString();

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line homey-app/global-timers
      const timer = setTimeout(() => {
        if (this.pendingCalls.has(messageId)) {
          this.pendingCalls.delete(messageId);
          reject(new Error(`RPC call timeout for ${action}`));
        }
      }, 30000);

      this.pendingCalls.set(messageId, { resolve, reject, timer });

      const messageArray = [2, messageId, action, payload];
      this.ws.send(JSON.stringify(messageArray));
    });
  }

  private handleMessage(data: RawData): void {
    try {
      let messageString: string;
      if (typeof data === 'string') {
        messageString = data;
      } else if (Buffer.isBuffer(data)) {
        messageString = data.toString('utf8');
      } else if (data instanceof ArrayBuffer) {
        messageString = Buffer.from(data).toString('utf8');
      } else if (Array.isArray(data)) {
        messageString = Buffer.concat(data).toString('utf8');
      } else {
        messageString = String(data);
      }

      const messageArray: unknown[] = JSON.parse(messageString);

      if (!Array.isArray(messageArray) || messageArray.length < 3) {
        this.emit('error', new Error('Invalid message format'));
        return;
      }

      const messageTypeId = messageArray[0];

      switch (messageTypeId) {
        case 2: // CALL
          this.handleCall(messageArray).catch((err) => this.emit('error', err));
          break;
        case 3: // CALLRESULT
          this.handleCallResult(messageArray);
          break;
        case 4: // CALLERROR
          this.handleCallError(messageArray);
          break;
        default:
          this.emit('error', new Error(`Unknown message type: ${messageTypeId}`));
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private async handleCall(messageArray: unknown[]): Promise<void> {
    const [, messageId, action, payload] = messageArray;

    try {
      const result = await this.server.handleMessage(
        action as string,
        payload as Record<string, unknown>,
        this.chargePointId,
      );

      // Send CALLRESULT
      const responseArray = [3, messageId, result || {}];
      this.ws.send(JSON.stringify(responseArray));
    } catch (error) {
      // Send CALLERROR
      const errorCode = error instanceof SimpleRPCError ? error.type : 'InternalError';
      const errorDescription = error instanceof Error ? error.message : 'Unknown error';
      const errorArray = [4, messageId, errorCode, errorDescription, {}];
      this.ws.send(JSON.stringify(errorArray));
    }
  }

  private handleCallResult(messageArray: unknown[]): void {
    const [, messageId, payload] = messageArray;
    const pending = this.pendingCalls.get(messageId as string);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(messageId as string);
      pending.resolve(payload);
    }
  }

  private handleCallError(messageArray: unknown[]): void {
    const [, messageId, errorCode, errorDescription, errorDetails] = messageArray;
    const pending = this.pendingCalls.get(messageId as string);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(messageId as string);
      pending.reject(new SimpleRPCError(errorCode as string, errorDescription as string, errorDetails));
    }
  }
}
