import type { WebSocket as NodeWebSocket } from "ws";

import type { JSONSerializable, BusMessage } from "./types";
export interface Payload {
    /** The actual message content */
    message: BusMessage;
    /** Request ID if this message expects a response */
    needResponse?: string;
    /** Response ID if this message is responding to a request */
    responseTo?: string;
}
interface PendingRequest {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (value: any) => void;
    reject: (error: Error | string) => void;
    timeout: NodeJS.Timeout;
}
interface BusOptions {
    /** Batch delay in milliseconds */
    batchDelay?: number;
}
interface RequestOptions {
    /** Request timeout in milliseconds */
    timeout?: number;
    /** Whether to batch this request */
    batch?: boolean;
}
interface SendOptions {
    /** Whether to batch this message */
    batch?: boolean;
}
type WebSocketLike = WebSocket | NodeWebSocket;
type WSHandler<K extends keyof WebSocketEventMap> = (ev: WebSocketEventMap[K]) => void;

/**
 * Bus class that implements a request/response pattern and batching feature on top of WebSocket.
 * Compatible in both Node.js and Browser environments.
 */
export class Bus {
    /**
     * Environment type identifier to avoid ID collisions between client and server
     * This class is used in both server (Node.js) and client (browser) environments
     */
    private static readonly _type: "c" | "s" =
        typeof window !== "undefined" && typeof window.document !== "undefined" ? "c" : "s";
    /** Global ID counter for Bus instances */
    private static _idCount = 0;
    /** Message handler for incoming messages */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public onMessage?: (message: BusMessage) => void;
    /** Request handler for incoming requests */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public onRequest?: (request: BusMessage) => Promise<any | void>;
    /** Unique bus instance identifier */
    public readonly id: number = Bus._idCount++;
    /** Request counter for generating unique request IDs */
    private _requestCount = 0;
    /** WebSocket connection */
    private readonly _websocket: WebSocketLike;
    /** Whether the websocket is an EventEmitter (Node.js ws) vs EventTarget (browser) */
    private readonly _isWebsocketEmitter: boolean;
    /** Map of pending requests awaiting responses */
    private readonly _pendingRequests = new Map<string, PendingRequest>();
    /** Queue of messages waiting to be batched */
    private _messageQueue: Payload[] = [];
    /** Current batch timeout handle */
    private _batchTimeout?: NodeJS.Timeout | number;
    /** Delay between batch sends in milliseconds */
    private readonly _batchDelay: number;

    constructor(websocket: WebSocketLike, options: BusOptions = {}) {
        const { batchDelay = 200 } = options;
        this._batchDelay = batchDelay;
        this._websocket = websocket;
        this._isWebsocketEmitter = typeof (websocket as NodeWebSocket).on === "function";
        this._onMessage = this._onMessage.bind(this);
        this._onSocket("message", this._onMessage);
        this._onSocket("close", () => {
            this.close();
        });
    }

    close(): void {
        clearTimeout(this._batchTimeout as NodeJS.Timeout);
        this.onMessage = undefined;
        this.onRequest = undefined;
        this._sendPayload = () => {};
        for (const { reject, timeout } of this._pendingRequests.values()) {
            clearTimeout(timeout);
            reject(new Error("bus closed"));
        }
        this._pendingRequests.clear();
        this._offSocket("message", this._onMessage);
    }

    /**
     * Sends a request and waits for a response
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request(message: BusMessage, options: RequestOptions = {}): Promise<JSONSerializable> {
        const { timeout = 5000, batch } = options;
        const requestId = this._getNextRequestId();
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error("bus request timed out"));
                this._pendingRequests.delete(requestId);
            }, timeout);
            this._pendingRequests.set(requestId, { resolve, reject, timeout: timeoutId });
            this._sendPayload(message, { needResponse: requestId, batch });
        });
    }

    send(message: BusMessage, options: SendOptions = {}): void {
        const { batch } = options;
        this._sendPayload(message, { batch });
    }

    private _onSocket<K extends keyof WebSocketEventMap>(event: K, func: WSHandler<K>): void {
        if (this._isWebsocketEmitter) {
            (this._websocket as NodeWebSocket).on(event, func);
        } else {
            // @ts-expect-error supporting EventTarget interface in browsers
            this._websocket.addEventListener(event, func as EventListener);
        }
    }

    private _offSocket<K extends keyof WebSocketEventMap>(event: K, func: WSHandler<K>): void {
        if (this._isWebsocketEmitter) {
            (this._websocket as NodeWebSocket).off(event, func);
        } else {
            // @ts-expect-error supporting EventTarget interface in browsers
            this._websocket.removeEventListener(event, func as EventListener);
        }
    }

    private _getNextRequestId(): string {
        return `${Bus._type}_${this.id}_${this._requestCount++}`;
    }

    private _sendPayload(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: BusMessage,
        options: {
            needResponse?: string;
            responseTo?: string;
            batch?: boolean;
        } = {}
    ): void {
        const { needResponse, responseTo, batch } = options;
        if (batch) {
            this._batch({ message, needResponse, responseTo });
            return;
        }
        this._websocket.send(JSON.stringify([{ message, needResponse, responseTo }]));
    }

    /**
     * Batches a payload for later sending
     * The delay for gathering the batch happens at the trailing end of the call.
     * If no batch is currently gathering, the first request is sent immediately
     * to be lenient with infrequent messages, and a new batch gathering phase starts.
     */
    private _batch(payload: Payload): void {
        this._messageQueue.push(payload);
        if (this._batchTimeout) {
            // Messages will be flushed in the currently gathering batch
            return;
        }
        this._flush();
    }

    private _flush(): void {
        if (this._messageQueue.length) {
            this._websocket.send(JSON.stringify(this._messageQueue));
            this._messageQueue = [];
            this._startGathering();
        }
    }

    private _startGathering(): void {
        this._batchTimeout = setTimeout(() => {
            this._flush();
            this._batchTimeout = undefined;
        }, this._batchDelay);
    }

    private _onMessage(webSocketMessage: string | MessageEvent): void {
        // Normalize message data (Node.js vs browser difference)
        const normalizedMessage = this._isWebsocketEmitter
            ? webSocketMessage
            : (webSocketMessage as MessageEvent)!.data;
        const payloads: Payload[] = JSON.parse(normalizedMessage);
        // Handle each payload in parallel (not awaited)
        for (const payload of payloads) {
            this._handlePayload(payload);
        }
    }

    /**
     * Handles incoming message payloads and dispatches them appropriately
     * Determines whether they are requests, responses, or plain messages
     */
    private async _handlePayload(payload: Payload): Promise<void> {
        const { message, needResponse, responseTo } = payload;
        if (responseTo) {
            // This is a response to a previous request
            const pendingRequest = this._pendingRequests.get(responseTo);
            if (pendingRequest) {
                clearTimeout(pendingRequest.timeout);
                pendingRequest.resolve(message);
                this._pendingRequests.delete(responseTo);
            }
        } else if (needResponse) {
            // This is a request that expects a response
            const response = await this.onRequest?.(message);
            this._sendPayload(response!, { responseTo: needResponse });
        } else {
            // This is a plain message
            this.onMessage?.(message);
        }
    }
}
