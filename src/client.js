// eslint-disable-next-line node/no-unpublished-import
import { Device } from "mediasoup-client";

import { Bus } from "#src/shared/bus.js";
import {
    CLIENT_MESSAGE,
    CLIENT_REQUEST,
    SERVER_MESSAGE,
    SERVER_REQUEST,
    WS_CLOSE_CODE,
} from "#src/shared/enums.js";

const INITIAL_RECONNECT_DELAY = 1_000; // the initial delay between reconnection attempts
const MAXIMUM_RECONNECT_DELAY = 30_000; // the longest delay possible between reconnection attempts
const MAX_ERRORS = 6; // how many errors should occur before trying a full restart of the connection
const RECOVERY_DELAY = 1_000; // how much time after an error should pass before a soft recovery attempt (retry the operation and not the whole connection)
const SUPPORTED_TYPES = new Set(["audio", "camera", "screen"]);

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
const DEFAULT_PRODUCER_OPTIONS = {
    stopTracks: false,
    disableTrackOnPause: false,
    zeroRtpOnPause: true,
};

/**
 * @typedef {Object} Consumers
 * @property {import("mediasoup-client").types.Consumer | null} audio
 * @property {import("mediasoup-client").types.Consumer | null} camera
 * @property {import("mediasoup-client").types.Consumer | null} screen
 */

/**
 * @typedef {Object} Producers
 * @property {import("mediasoup-client").types.Producer | null} audio
 * @property {import("mediasoup-client").types.Producer | null} camera
 * @property {import("mediasoup-client").types.Producer | null} screen
 */

/**
 * @typedef {'audio' | 'camera' | 'screen' } streamType
 */

export const SFU_CLIENT_STATE = Object.freeze({
    /**
     * The client is not connected to the server and does not want to do so. This state is intentional and
     * is only set at the creation of a sfuClient, or when the client calls `disconnect`.
     */
    DISCONNECTED: "disconnected",
    /**
     * The client is trying to connect to the server, it is not authenticated yet.
     */
    CONNECTING: "connecting",
    /**
     * The initial handshake with the server has been done and the client is authenticated, the bus is ready to be used.
     */
    AUTHENTICATED: "authenticated",
    /**
     * The client is ready to send and receive tracks.
     */
    CONNECTED: "connected",
    /**
     * This state is reached when the connection is lost and the client is trying to reconnect.
     */
    RECOVERING: "recovering",
    /**
     * This state is reached when the connection is stopped and there should be no automated attempt to reconnect.
     */
    CLOSED: "closed",
});

const ACTIVE_STATES = new Set([
    SFU_CLIENT_STATE.CONNECTING,
    SFU_CLIENT_STATE.AUTHENTICATED,
    SFU_CLIENT_STATE.CONNECTED,
]);

/**
 * This class is run by the client and represents the server and abstracts the mediasoup API away.
 * It handles authentication, connection recovery and transport/consumers/producers maintenance.
 *
 *  @fires SfuClient#stateChange
 *  @fires SfuClient#update
 */
export class SfuClient extends EventTarget {
    /** @type {Error[]} */
    errors = [];
    /** @type {SFU_CLIENT_STATE[keyof SFU_CLIENT_STATE]} */
    _state = SFU_CLIENT_STATE.DISCONNECTED;
    /** @type {Bus | undefined} */
    _bus;
    /** @type {string} */
    _jsonWebToken;
    /** @type {import("mediasoup-client").types.Device} */
    _device;
    _recoverProducerTimeouts = {
        /** @type {number} */
        audio: undefined,
        /** @type {number} */
        camera: undefined,
        /** @type {number} */
        screen: undefined,
    };
    /** @type {import("mediasoup-client").types.Transport} Client-To-Server Transport */
    _ctsTransport;
    /** @type {import("mediasoup-client").types.Transport} Server-To-Client Transport */
    _stcTransport;
    /** @type {number} */
    _connectRetryDelay = INITIAL_RECONNECT_DELAY;
    /** @type {WebSocket} */
    _webSocket;
    /** @type {Map<number, Consumers>} */
    _consumers = new Map();
    /** @type {Producers} */
    _producers = {
        audio: null,
        camera: null,
        screen: null,
    };
    /** @type {Object<"audio" | "video", import("mediasoup-client").types.ProducerOptions>} */
    _producerOptionsByKind = {
        audio: DEFAULT_PRODUCER_OPTIONS,
        video: DEFAULT_PRODUCER_OPTIONS,
    };
    /** @type {Function[]} */
    _cleanups = [];

    constructor() {
        super();
        this._handleMessage = this._handleMessage.bind(this);
        this._handleRequest = this._handleRequest.bind(this);
        this._handleConnectionEnd = this._handleConnectionEnd.bind(this);
    }

    /**
     * @param {SFU_CLIENT_STATE[keyof SFU_CLIENT_STATE]} state
     * @fires SfuClient#stateChange
     */
    set state(state) {
        this._state = state;
        /**
         * @event SfuClient#stateChange
         * @type {Object}
         * @property {Object} detail
         * @property {string} detail.state
         */
        this.dispatchEvent(new CustomEvent("stateChange", { detail: { state } }));
    }

    /**
     * @returns {SFU_CLIENT_STATE[keyof SFU_CLIENT_STATE]}
     */
    get state() {
        return this._state;
    }

    /**
     * @param message any JSON serializable object
     */
    broadcast(message) {
        this._bus.send(
            {
                name: CLIENT_MESSAGE.BROADCAST,
                payload: message,
            },
            { batch: true }
        );
    }

    /**
     * @param {string} url
     * @param {string} jsonWebToken
     * @param {Object} [options]
     * @param {string} [options.channelUUID]
     * @param {[]} [options.iceServers]
     */
    async connect(url, jsonWebToken, { channelUUID, iceServers } = {}) {
        // saving the options for so that the parameters are saved for reconnection attempts
        this._url = url.replace(/^http/, "ws"); // makes sure the url is a websocket url
        this._jsonWebToken = jsonWebToken;
        this._iceServers = iceServers;
        this._channelUUID = channelUUID;
        this._connectRetryDelay = INITIAL_RECONNECT_DELAY;
        this._device = this._createDevice();
        await this._connect();
    }

    disconnect() {
        this._clear();
        this.state = SFU_CLIENT_STATE.DISCONNECTED;
    }

    /**
     * @returns {Promise<{ uploadStats: RTCStatsReport, downloadStats: RTCStatsReport }>}
     */
    async getStats() {
        const stats = {};
        const [uploadStats, downloadStats] = await Promise.all([
            this._ctsTransport?.getStats(),
            this._stcTransport?.getStats(),
        ]);
        stats.uploadStats = uploadStats;
        stats.downloadStats = downloadStats;
        const proms = [];
        for (const [type, producer] of Object.entries(this._producers)) {
            if (producer) {
                proms.push(
                    (async () => {
                        stats[type] = await producer.getStats();
                    })()
                );
            }
        }
        await Promise.all(proms);
        return stats;
    }

    /**
     * Updates the server with the info of the session (isTalking, isCameraOn,...) so that it can broadcast it to the
     * other call participants.
     *
     * @param {import("#src/models/session.js").SessionInfo} info
     * @param {Object} [param0]
     * @param {boolean} [param0.needRefresh] true if the server should refresh the local info from all sessions of this channel
     */
    updateInfo(info, { needRefresh } = {}) {
        this._bus?.send(
            {
                name: CLIENT_MESSAGE.INFO_CHANGE,
                payload: { info, needRefresh },
            },
            { batch: true }
        );
    }

    /**
     * Stop or resume the consumption of tracks from the other call participants.
     *
     * @param {number} sessionId
     * @param {Object<[streamType, boolean]>} states e.g: { audio: true, camera: false }
     */
    updateDownload(sessionId, states) {
        const consumers = this._consumers.get(sessionId);
        if (!consumers) {
            return;
        }
        let hasChanged = false;
        for (const [type, active] of Object.entries(states)) {
            if (!SUPPORTED_TYPES.has(type)) {
                continue;
            }
            const consumer = consumers[type];
            if (consumer) {
                if (active !== consumer.paused) {
                    continue;
                }
                hasChanged = true;
                if (active) {
                    consumer.resume();
                } else {
                    consumer.pause();
                }
            }
        }
        if (!hasChanged) {
            return;
        }
        this._bus?.send(
            {
                name: CLIENT_MESSAGE.CONSUMPTION_CHANGE,
                payload: { sessionId, states },
            },
            { batch: true }
        );
    }

    /**
     * @param {streamType} type
     * @param {MediaStreamTrack | null} track track to be sent to the other call participants,
     * not setting it will remove the track from the server
     */
    async updateUpload(type, track) {
        if (!SUPPORTED_TYPES.has(type)) {
            throw new Error(`Unsupported media type ${type}`);
        }
        clearTimeout(this._recoverProducerTimeouts[type]);
        const existingProducer = this._producers[type];
        if (existingProducer) {
            if (track) {
                await existingProducer.replaceTrack({ track });
            }
            this._bus.send(
                {
                    name: CLIENT_MESSAGE.PRODUCTION_CHANGE,
                    payload: { type, active: Boolean(track) },
                },
                { batch: true }
            );
            return;
        }
        if (!track) {
            return;
        }
        try {
            this._producers[type] = await this._ctsTransport.produce({
                ...this._producerOptionsByKind[track.kind],
                track,
                appData: { type },
            });
        } catch (error) {
            this.errors.push(error);
            // if we reach the max error count, we restart the whole connection from scratch
            if (this.errors.length > MAX_ERRORS) {
                // not awaited
                this._handleConnectionEnd();
                return;
            }
            // retry after some delay
            this._recoverProducerTimeouts[type] = setTimeout(async () => {
                await this.updateUpload(type, track);
            }, RECOVERY_DELAY);
            return;
        }
        this._onCleanup(() => {
            this._producers[type]?.close();
            this._producers[type] = null;
            clearTimeout(this._recoverProducerTimeouts[type]);
        });
    }

    /**
     * To be overridden in tests.
     *
     * @returns {import("mediasoup-client").types.Device}
     */
    _createDevice() {
        return new Device();
    }

    /**
     * To be overridden in tests.
     *
     * @param {string} url
     * @returns {WebSocket}
     * @private
     */
    _createWebSocket(url) {
        return new WebSocket(url);
    }

    /**
     * Opens the webSocket connection to the server and authenticates, handles reconnection attempts.
     */
    async _connect() {
        if (ACTIVE_STATES.has(this.state)) {
            return;
        }
        this._clear();
        this.state = SFU_CLIENT_STATE.CONNECTING;
        try {
            this._bus = await this._createBus();
            this.state = SFU_CLIENT_STATE.AUTHENTICATED;
        } catch {
            this._handleConnectionEnd();
            return;
        }
        this._bus.onMessage = this._handleMessage;
        this._bus.onRequest = this._handleRequest;
    }

    /**
     * @param {string} [cause]
     * @private
     */
    _close(cause) {
        this._clear();
        const state = SFU_CLIENT_STATE.CLOSED;
        this._state = state;
        this.dispatchEvent(new CustomEvent("stateChange", { detail: { state, cause } }));
    }

    /**
     * @returns {Promise<Bus>}
     */
    _createBus() {
        return new Promise((resolve, reject) => {
            let webSocket;
            try {
                webSocket = this._createWebSocket(this._url);
            } catch (error) {
                reject(error);
                return;
            }
            webSocket.addEventListener("close", this._handleConnectionEnd);
            webSocket.addEventListener("error", this._handleConnectionEnd);
            this._onCleanup(() => {
                webSocket.removeEventListener("close", this._handleConnectionEnd);
                webSocket.removeEventListener("error", this._handleConnectionEnd);
                if (webSocket.readyState < webSocket.CLOSING) {
                    webSocket.close(WS_CLOSE_CODE.CLEAN);
                }
            });
            /**
             * Websocket handshake with the rtc server,
             * when opening the webSocket, the server expects the first message to contain the jwt.
             */
            webSocket.addEventListener(
                "open",
                () => {
                    webSocket.send(
                        JSON.stringify({ channelUUID: this._channelUUID, jwt: this._jsonWebToken })
                    );
                },
                { once: true }
            );
            /**
             * Receiving a message means that the server has authenticated the client and is ready to receive messages.
             */
            webSocket.addEventListener(
                "message",
                () => {
                    resolve(new Bus(webSocket));
                },
                { once: true }
            );
        });
    }

    /**
     * @param {Function} callback
     */
    _onCleanup(callback) {
        this._cleanups.push(callback);
    }

    _clear() {
        for (const cleanup of this._cleanups.splice(0)) {
            cleanup();
        }
        this.errors = [];
        for (const consumers of this._consumers.values()) {
            for (const consumer of Object.values(consumers)) {
                consumer?.close();
            }
        }
        this._consumers.clear();
    }

    /**
     * @param {import("#src/models/session.js").SessionInfo.TransportConfig} ctsConfig
     */
    _makeCTSTransport(ctsConfig) {
        const transport = this._device.createSendTransport({
            ...ctsConfig,
            iceServers: this._iceServers,
        });
        transport.on("connect", async ({ dtlsParameters, iceParameters }, callback, errback) => {
            try {
                await this._bus.request({
                    name: CLIENT_REQUEST.CONNECT_CTS_TRANSPORT,
                    payload: { dtlsParameters, iceParameters },
                });
                callback();
            } catch (error) {
                errback(error);
            }
        });
        transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
                const result = await this._bus.request({
                    name: CLIENT_REQUEST.INIT_PRODUCER,
                    payload: { type: appData.type, kind, rtpParameters },
                });
                callback({ id: result.id });
            } catch (error) {
                errback(error);
            }
        });
        this._ctsTransport = transport;
        this._onCleanup(() => transport.close());
    }

    /**
     * @param {import("#src/models/session.js").SessionInfo.TransportConfig} stcConfig
     */
    _makeSTCTransport(stcConfig) {
        const transport = this._device.createRecvTransport({
            ...stcConfig,
            iceServers: this._iceServers,
        });
        transport.on("connect", async ({ dtlsParameters, iceParameters }, callback, errback) => {
            try {
                await this._bus.request({
                    name: CLIENT_REQUEST.CONNECT_STC_TRANSPORT,
                    payload: { dtlsParameters, iceParameters },
                });
                callback();
            } catch (error) {
                errback(error);
            }
        });
        this._stcTransport = transport;
        this._onCleanup(() => transport.close());
    }

    /**
     * @param {number} sessionId
     */
    _removeConsumers(sessionId) {
        const consumers = this._consumers.get(sessionId);
        if (!consumers) {
            return;
        }
        for (const consumer of Object.values(consumers)) {
            consumer?.close();
        }
        this._consumers.delete(sessionId);
    }

    /**
     * dispatches an event, intended for the client
     *
     * @param { "disconnect" | "info_change" | "track" | "error" | "broadcast"} name
     * @param [payload]
     * @fires SfuClient#update
     */
    _updateClient(name, payload) {
        /**
         * @event SfuClient#update
         * @type {Object}
         * @property {Object} detail
         * @property {string} detail.name
         * @property {Object} detail.payload
         */
        this.dispatchEvent(new CustomEvent("update", { detail: { name, payload } }));
    }

    /**
     * Handles cases where the connection to the server ends or in error and attempts to recover it if appropriate.
     *
     * @param {Event | CloseEvent} [event]
     */
    _handleConnectionEnd(event) {
        if (this.state === SFU_CLIENT_STATE.DISCONNECTED) {
            // state DISCONNECTED is intentional, so there is no reason to retry
            return;
        }
        switch (event?.code) {
            case WS_CLOSE_CODE.CHANNEL_FULL:
                this._close("full");
                return;
            case WS_CLOSE_CODE.AUTHENTICATION_FAILED:
            case WS_CLOSE_CODE.KICKED:
                this._close();
                return;
        }
        this.state = SFU_CLIENT_STATE.RECOVERING;
        // Retry connecting with an exponential backoff.
        this._connectRetryDelay =
            Math.min(this._connectRetryDelay * 1.5, MAXIMUM_RECONNECT_DELAY) + 1000 * Math.random();
        const timeout = setTimeout(this._connect.bind(this), this._connectRetryDelay);
        this._onCleanup(() => clearTimeout(timeout));
    }

    /**
     * @param {Object} param0
     * @param {string} param0.name
     * @param {Object} param0.payload
     */
    async _handleMessage({ name, payload }) {
        switch (name) {
            case SERVER_MESSAGE.BROADCAST:
                this._updateClient("broadcast", payload);
                break;
            case SERVER_MESSAGE.SESSION_LEAVE:
                {
                    const { sessionId } = payload;
                    this._removeConsumers(sessionId);
                    this._updateClient("disconnect", payload);
                }
                break;
            case SERVER_MESSAGE.INFO_CHANGE:
                this._updateClient("info_change", payload);
                break;
        }
    }

    /**
     * @param {Object} param0
     * @param {string} param0.name
     * @param {Object} [param0.payload]
     * @returns {Promise<any>} response to the request, JSON-serializable
     */
    async _handleRequest({ name, payload }) {
        switch (name) {
            case SERVER_REQUEST.INIT_CONSUMER: {
                const { id, kind, producerId, rtpParameters, sessionId, type, active } = payload;
                let consumers;
                if (!this._consumers.has(sessionId)) {
                    consumers = {
                        audio: null,
                        camera: null,
                        screen: null,
                    };
                    this._consumers.set(sessionId, consumers);
                } else {
                    consumers = this._consumers.get(sessionId);
                    consumers[type]?.close();
                }
                const consumer = await this._stcTransport.consume({
                    id,
                    producerId,
                    kind,
                    rtpParameters,
                });
                if (!active) {
                    consumer.pause();
                } else {
                    consumer.resume();
                }
                this._updateClient("track", { type, sessionId, track: consumer.track, active });
                consumers[type] = consumer;
                return;
            }
            case SERVER_REQUEST.INIT_TRANSPORTS: {
                const { capabilities, stcConfig, ctsConfig, producerOptionsByKind } = payload;
                if (producerOptionsByKind) {
                    this._producerOptionsByKind = producerOptionsByKind;
                }
                if (!this._device.loaded) {
                    await this._device.load({ routerRtpCapabilities: capabilities });
                }
                this._makeSTCTransport(stcConfig);
                this._makeCTSTransport(ctsConfig);
                this.state = SFU_CLIENT_STATE.CONNECTED;
                return this._device.rtpCapabilities;
            }
            case SERVER_REQUEST.PING:
                return; // the server just needs a response, merely returning is enough
        }
    }
}
