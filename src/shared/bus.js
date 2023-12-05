/**
 * @typedef Payload
 * @property {Object} message
 * @property {string} [needResponse]
 * @property {string} [responseTo]
 */

/**
 * Bus class that implements a request/response pattern and a batching feature on top of a websocket.
 *
 * Compatible in both Node and Browser environment.
 */
export class Bus {
    /**
     * Used to know if the code runs on the client to avoid ID collisions as this class can is defined in both
     * the server(/node) and the client(/browser) environments (and therefore not share static properties).
     *
     * @type {"c"|"s"}
     */
    static _type =
        typeof window !== "undefined" && typeof window.document !== "undefined" ? "c" : "s";
    /** @type {number} */
    static _idCount = 0;

    /** @type {Function} */
    onMessage;
    /** @type {Function} */
    onRequest;
    /** @type {number} */
    id = Bus._idCount++;
    /** @type {number} */
    _requestCount = 0;
    /** @type {WebSocket} */
    _websocket;
    /**
     * Whether the websocket is an EventEmitter (from `ws` node library), if false it is a EventTarget like the native browser ws.
     * @type {boolean}
     */
    _isWebsocketEmitter;
    /** @type {Map<string, {resolve: Function, reject: Function}>} */
    _pendingRequests = new Map();
    /** @type {Payload[]} */
    _messageQueue = [];
    /** @type {NodeJS.Timeout | string} */
    _batchTimeout;
    /** @type {number} */
    _batchDelay = 100;

    /**
     * @param {import("ws").WebSocket} websocket
     * @param {Object} [options]
     * @param {number} [options.batchDelay] in milliseconds
     */
    constructor(websocket, { batchDelay = 200 } = {}) {
        this._batchDelay = batchDelay;
        this._websocket = websocket;
        this._isWebsocketEmitter = typeof websocket.on === "function"; // could use constructor name but can't use mocks during tests
        this._onMessage = this._onMessage.bind(this);
        this._onSocket("message", this._onMessage);
        this._onSocket("close", () => {
            this.close();
        });
    }

    close() {
        clearTimeout(this._batchTimeout);
        this.onMessage = null;
        this.onRequest = null;
        this._sendPayload = () => {};
        for (const { reject, timeout } of this._pendingRequests.values()) {
            clearTimeout(timeout);
            reject(new Error("bus closed"));
        }
        this._offSocket("message", this._onMessage);
    }

    /**
     * @param {Object} message
     * @param {Object} [options]
     * @param {number} [options.timeout] in milliseconds
     * @param {boolean} [options.batch]
     * @returns {Promise<Object>} response
     */
    request(message, { timeout = 5000, batch } = {}) {
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

    /**
     * @param message any JSON-serializable object
     * @param {Object} [options]
     * @param {boolean} [options.batch]
     */
    send(message, { batch } = {}) {
        this._sendPayload(message, { batch });
    }

    /**
     * @param {string} event
     * @param {Function} func
     */
    _onSocket(event, func) {
        if (this._isWebsocketEmitter) {
            this._websocket.on(event, func);
        } else {
            this._websocket.addEventListener(event, func);
        }
    }

    /**
     * @param {string} event
     * @param {Function} func
     */
    _offSocket(event, func) {
        if (this._isWebsocketEmitter) {
            this._websocket.off(event, func);
        } else {
            this._websocket.removeEventListener(event, func);
        }
    }

    _getNextRequestId() {
        return `${Bus._type}_${this.id}_${this._requestCount++}`;
    }

    /**
     * @param message any JSON-serializable object
     * @param {Object} [options]
     * @param {string} [options.needResponse] if set, the message is a `request` that expects a response with the same id.
     * @param {string} [options.responseTo] if set, the message is a response to a request of that id.
     * @param {boolean} [options.batch] true if batching the message
     */
    _sendPayload(message, { needResponse, responseTo, batch } = {}) {
        if (batch) {
            this._batch({ message, needResponse, responseTo });
            return;
        }
        this._websocket.send(JSON.stringify([{ message, needResponse, responseTo }]));
    }

    /**
     * The delay for gathering the batch happens at the trailing end of the call, meaning that if there is no batch currently
     * gathering requests, the first request is sent immediately (to be lenient with infrequent messages), and new batch gathering
     * phase starts gathering the subsequent ones.
     *
     * @param {any} payload any JSON serializable
     */
    _batch(payload) {
        this._messageQueue.push(payload);
        if (this._batchTimeout) {
            // the messages will be flushed in currently gathering batch
            return;
        }
        this._flush();
    }

    _flush() {
        if (this._messageQueue.length) {
            this._websocket.send(JSON.stringify(this._messageQueue));
            this._messageQueue = [];
            this._startGathering();
        }
    }

    _startGathering() {
        this._batchTimeout = setTimeout(() => {
            this._flush();
            this._batchTimeout = undefined;
        }, this._batchDelay);
    }

    /**
     * @param webSocketMessage the structure of the webSocketMessage varies depending on whether the websocket is an EventEmitter (node) or an EventTarget (browser)
     */
    _onMessage(webSocketMessage) {
        const normalizedMessage = this._isWebsocketEmitter
            ? webSocketMessage
            : webSocketMessage.data;
        /** @type {Payload[]} */
        const payloads = JSON.parse(normalizedMessage);
        for (const payload of payloads) {
            // not awaiting, handled in parallel
            this._handlePayload(payload);
        }
    }

    /**
     * Handles incoming messages and dispatches them to the right handler based on whether they are requests, responses or plain messages.
     *
     * @param {Payload} payload
     */
    async _handlePayload({ message, needResponse, responseTo }) {
        if (responseTo) {
            const pendingRequest = this._pendingRequests.get(responseTo);
            clearTimeout(pendingRequest?.timeout);
            pendingRequest?.resolve(message);
            this._pendingRequests.delete(responseTo);
        } else if (needResponse) {
            const response = await this.onRequest?.(message);
            this._sendPayload(response, { responseTo: needResponse });
        } else {
            this.onMessage?.(message);
        }
    }
}
