import { EventEmitter } from "node:events";

import * as config from "#src/config.js";
import { Logger } from "#src/utils/utils.js";
import {
    CLIENT_MESSAGE,
    CLIENT_REQUEST,
    SERVER_MESSAGE,
    SERVER_REQUEST,
} from "#src/shared/enums.js";

/**
 * @typedef {Object} SessionInfo
 * @property {boolean} isTalking
 * @property {boolean} isCameraOn
 * @property {boolean} isScreenSharingOn
 * @property {boolean} isSelfMuted
 * @property {boolean} isDeaf
 * @property {boolean} isRaisingHand
 */

/**
 * @typedef {Object} TransportConfig
 * @property {string} id
 * @property {import("mediasoup").types.IceParameters} iceParameters
 * @property {import("mediasoup").types.IceCandidate[]} iceCandidates
 * @property {import("mediasoup").types.DtlsParameters} dtlsParameters
 * @property {import("mediasoup").types.SctpParameters} sctpParameters
 */

/**
 * @typedef {Object} Consumers
 * @property {import("mediasoup").types.Consumer | null} audio
 * @property {import("mediasoup").types.Consumer | null} camera
 * @property {import("mediasoup").types.Consumer | null} screen
 */

/**
 * @typedef {Object} Producers
 * @property {import("mediasoup").types.Producer | null} audio
 * @property {import("mediasoup").types.Producer | null} camera
 * @property {import("mediasoup").types.Producer | null} screen
 */

const logger = new Logger("SESSION");

export const SESSION_STATE = Object.freeze({
    NEW: "new",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    CLOSED: "closed",
});

export const SESSION_CLOSE_CODE = Object.freeze({
    CLEAN: "clean",
    REPLACED: "replaced",
    WS_ERROR: "ws_error",
    WS_CLOSED: "ws_closed",
    CHANNEL_CLOSED: "channel_closed",
    C_TIMEOUT: "connection_timeout",
    P_TIMEOUT: "ping_timeout",
    KICKED: "kicked",
    ERROR: "error",
});

/**
 * @fires Session#stateChange
 * @fires Session#close
 */
export class Session extends EventEmitter {
    /** @type {import("#src/shared/bus").Bus}*/
    bus;
    /** @type {number} */
    id;
    /** @type {SessionInfo} */
    info = Object.seal({
        isRaisingHand: undefined,
        isSelfMuted: undefined,
        isTalking: undefined,
        isDeaf: undefined,
        isCameraOn: undefined,
        isScreenSharingOn: undefined,
    });
    /** @type {string} */
    remote;
    /** @type {Map<number, Consumers>} */
    _consumers = new Map();
    /** @type {Producers} */
    producers = {
        audio: null,
        camera: null,
        screen: null,
    };
    /** @type {import("#src/models/channel").Channel} */
    _channel;
    /** @type {Error[]} */
    errors = [];
    /** @type {SESSION_STATE[keyof SESSION_STATE]} */
    _state = SESSION_STATE.NEW;
    /** @type {[]} */
    _iceServers;
    /** @type {Object} */
    _clientCapabilities;
    /** @type {import("mediasoup").types.WebRtcTransport} Client-To-Server Transport */
    _ctsTransport;
    /** @type {import("mediasoup").types.WebRtcTransport} Server-To-Client Transport */
    _stcTransport;
    /** @type {Map<number,NodeJS.Timeout>} */
    _recoverConsumerTimeouts = new Map();

    /**
     * @param {number} id
     * @param {import("#src/models/channel.js").Channel} channel
     */
    constructor(id, channel) {
        super();
        this.id = id;
        this._channel = channel;
        this._handleMessage = this._handleMessage.bind(this);
        this._handleRequest = this._handleRequest.bind(this);
        /**
         * The amount of listeners grows with the amount of sessions per channel,
         * this disables the default warning when going above the 10 listener soft limit.
         */
        this.setMaxListeners(config.CHANNEL_SIZE * 2);
    }

    /**
     * @returns {string}
     */
    get name() {
        return `${this._channel.name}:${this.id}@${this.remote}`;
    }

    /**
     * @returns {SESSION_STATE[keyof SESSION_STATE]} `SESSION_STATE`
     */
    get state() {
        return this._state;
    }

    /**
     * @param {SESSION_STATE[keyof SESSION_STATE]} state
     * @fires Session#stateChange
     */
    set state(state) {
        this._state = state;
        /**
         * stateChange event.
         * @event Session#stateChange
         * @type {string} `SESSION_STATE`
         */
        this.emit("stateChange", state);
    }

    /**
     * @returns {Promise<{ audio: number | undefined, camera: number | undefined, screen: number | undefined}>}
     */
    async getProducerBitRates() {
        const bitRates = {};
        const proms = [];
        for (const [type, producer] of Object.entries(this.producers)) {
            if (!producer) {
                continue;
            }
            proms.push(
                (async () => {
                    const stats = await producer.getStats();
                    const codec = producer.rtpParameters?.codecs[0];
                    const bitRate = stats[0]?.bitrate;
                    logger.verbose(
                        `[${this.name}] ${type}(${codec?.mimeType}) bitrate: ${bitRate}`
                    );
                    bitRates[type] = bitRate;
                })()
            );
        }
        await Promise.all(proms);
        return bitRates;
    }

    /**
     * Sends a message to all sessions of this channel (sans this session).
     *
     * @param {Object} message
     */
    _broadcast(message) {
        for (const session of this._channel.sessions.values()) {
            if (session.id === this.id) {
                continue;
            }
            if (!session.bus) {
                logger.warn(
                    `session ${session.id} has no bus but tried to send message: ${message?.name}`
                );
                continue;
            }
            session.bus.send(message, { batch: true });
        }
    }

    /**
     * @param {Object} [param0]
     * @param {SESSION_CLOSE_CODE[keyof SESSION_CLOSE_CODE]} [param0.code=SESSION_CLOSE_CODE.CLEAN]
     * @param {string} [param0.cause]
     * @fires Session#close
     */
    close({ code = SESSION_CLOSE_CODE.CLEAN, cause } = {}) {
        for (const timeout of this._recoverConsumerTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.errors = [];
        for (const consumers of this._consumers.values()) {
            for (const consumer of Object.values(consumers)) {
                try {
                    consumer?.close();
                } catch {
                    logger.verbose(
                        `[${this.name}] failed to close consumer, probably already closed`
                    );
                }
            }
        }
        this._consumers.clear();
        if (!this.state || this.state === SESSION_STATE.CLOSED) {
            return;
        }
        logger.info(`[${this.name}] closed with code "${code}", cause: ${cause}`);
        this.state = SESSION_STATE.CLOSED;
        if (code !== SESSION_CLOSE_CODE.CHANNEL_CLOSED) {
            /**
             * Broadcasting so that all the CLIENTS of the other sessions can cleanly remove their consumers.
             * If the channel is being closed, there is no reason to broadcast.
             */
            this._broadcast({
                name: SERVER_MESSAGE.SESSION_LEAVE,
                payload: { sessionId: this.id },
            });
        }
        /**
         * @event Session#close
         * @type {{ id: number, code: number }}
         */
        this.emit("close", { id: this.id, code });
    }

    /**
     * @param {import("#src/shared/bus.js").Bus} bus
     * @param {[]} [ice_servers]
     */
    async connect(bus, ice_servers = []) {
        this.state = SESSION_STATE.CONNECTING;
        this._iceServers = ice_servers;
        this.bus = bus;
        this.bus.onMessage = this._handleMessage;
        this.bus.onRequest = this._handleRequest;

        // starting timeouts
        const connectionTimeout = setTimeout(() => {
            if (this.state !== SESSION_STATE.CONNECTED) {
                this.close({ code: SESSION_CLOSE_CODE.C_TIMEOUT });
            }
        }, config.timeouts.session);
        const pingInterval = setInterval(async () => {
            try {
                await this.bus.request(
                    { name: SERVER_REQUEST.PING },
                    { timeout: config.timeouts.session, batch: true }
                );
            } catch {
                this.close({ code: SESSION_CLOSE_CODE.P_TIMEOUT });
            }
        }, config.timeouts.ping);
        this.once("close", () => {
            clearInterval(pingInterval);
            clearTimeout(connectionTimeout);
        });

        // starting transports
        if (this._channel.router) {
            try {
                const [ctsTransport, sctTransport] = await Promise.all([
                    this._channel.router.createWebRtcTransport({
                        ...config.rtc.rtcTransportOptions,
                        webRtcServer: this._channel.webRtcServer,
                    }),
                    this._channel.router.createWebRtcTransport({
                        ...config.rtc.rtcTransportOptions,
                        webRtcServer: this._channel.webRtcServer,
                    }),
                ]);
                this._ctsTransport = ctsTransport;
                this._stcTransport = sctTransport;
                this.once("close", () => {
                    this._ctsTransport?.close();
                    this._stcTransport?.close();
                });
                this._clientCapabilities = await this.bus.request({
                    name: SERVER_REQUEST.INIT_TRANSPORTS,
                    payload: {
                        capabilities: this._channel.router.rtpCapabilities,
                        /** @type{TransportConfig} */
                        stcConfig: {
                            id: this._stcTransport.id,
                            iceParameters: this._stcTransport.iceParameters,
                            iceCandidates: this._stcTransport.iceCandidates,
                            dtlsParameters: this._stcTransport.dtlsParameters,
                            sctpParameters: this._stcTransport.sctpParameters,
                        },
                        /** @type{TransportConfig} */
                        ctsConfig: {
                            id: this._ctsTransport.id,
                            iceParameters: this._ctsTransport.iceParameters,
                            iceCandidates: this._ctsTransport.iceCandidates,
                            dtlsParameters: this._ctsTransport.dtlsParameters,
                            sctpParameters: this._ctsTransport.sctpParameters,
                        },
                        producerOptionsByKind: config.rtc.producerOptionsByKind,
                    },
                });
                await Promise.all([
                    this._ctsTransport.setMaxIncomingBitrate(config.MAX_BITRATE_IN),
                    this._stcTransport.setMaxOutgoingBitrate(config.MAX_BITRATE_OUT),
                ]);
            } catch (error) {
                logger.error(
                    `[${this.name}] failed to create transports (${error.message}), closing session`
                );
                this.close({ code: SESSION_CLOSE_CODE.ERROR, cause: error.message });
                return;
            }
        }
        if (this.state === SESSION_STATE.CLOSED) {
            /**
             * It is possible that the session was closed while connecting,
             * in that case we close the newly created transports and stop here.
             */
            logger.verbose(`[${this.name}] was closed during the connection process`);
            this._ctsTransport?.close();
            this._stcTransport?.close();
            return;
        }
        /**
         * The session is considered connected as soon as the transports are ready,
         * regardless of whether we are producing or consuming streams, as this can
         * happen arbitrarily late in the lifecycle of a session.
         */
        this.state = SESSION_STATE.CONNECTED;
        logger.info(`[${this.name}] connected`);

        // starting streams
        const promises = [];
        for (const session of this._channel.sessions.values()) {
            promises.push(this.consume(session));
            promises.push(session.consume(this));
        }
        await Promise.all(promises);
    }

    /**
     * Creates missing consumers for each producer of `params.session` and sets their appropriate `paused` state.
     * This batches the consumption of all streams.
     *
     * @param {Session} session
     */
    async consume(session) {
        if (this === session) {
            return;
        }
        if (session.state !== SESSION_STATE.CONNECTED) {
            return;
        }
        if (!this._channel.router) {
            return;
        }
        let consumers;
        if (!this._consumers.has(session.id)) {
            consumers = {
                audio: null,
                camera: null,
                screen: null,
            };
            this._consumers.set(session.id, consumers);
            session.once("close", () => {
                if (this.state === SESSION_STATE.CLOSED) {
                    return;
                }
                for (const consumer of Object.values(consumers)) {
                    consumer?.close();
                }
                this._consumers.delete(session.id);
            });
        } else {
            consumers = this._consumers.get(session.id);
        }
        for (const [type, producer] of Object.entries(session.producers)) {
            if (!producer) {
                // nothing to consume
                continue;
            }
            if (
                !this._channel.router.canConsume({
                    producerId: producer.id,
                    rtpCapabilities: this._clientCapabilities,
                })
            ) {
                continue;
            }
            let consumer = consumers[type];
            try {
                if (!consumer) {
                    // nice-to-have simulcast, implementing PRODUCER_OPTIONS.encodings, CONSUMER_OPTIONS.preferredLayers
                    // https://mediasoup.org/documentation/v3/mediasoup/api/#ConsumerOptions
                    consumer = await this._stcTransport.consume({
                        producerId: producer.id,
                        rtpCapabilities: this._clientCapabilities,
                        paused: true,
                    });
                    await this.bus.request(
                        {
                            name: SERVER_REQUEST.INIT_CONSUMER,
                            payload: {
                                id: consumer.id,
                                kind: consumer.kind,
                                producerId: producer.id,
                                rtpParameters: consumer.rtpParameters,
                                sessionId: session.id,
                                active: !producer.paused,
                                type,
                            },
                        },
                        { batch: true }
                    );
                    consumers[type]?.close(); // by the time promises are resolved, there could be a new consumer
                }
                if (producer.paused !== consumer.paused) {
                    if (producer.paused) {
                        await consumer.pause();
                    } else {
                        await consumer.resume();
                    }
                    logger.verbose(
                        `[${this.name}] consumer reading ${type} of [${session.name}]: ${
                            consumer.paused ? "off" : "on"
                        }`
                    );
                }
            } catch (error) {
                consumer?.close();
                consumers[type] = null;
                if (session.state === SESSION_STATE.CLOSED) {
                    return;
                }
                this._handleError(error);
                clearTimeout(this._recoverConsumerTimeouts.get(session.id));
                // retries the whole consumption process for the session couple
                this._recoverConsumerTimeouts.set(
                    session.id,
                    setTimeout(() => {
                        this.consume(session);
                    }, config.timeouts.recovery)
                );
                return;
            }
            consumers[type] = consumer;
        }
    }

    _broadcastInfo() {
        this._broadcast({
            name: SERVER_MESSAGE.INFO_CHANGE,
            payload: { [this.id]: this.info },
        });
    }

    /**
     * registers the error and closes the session if the error limit is reached
     *
     * @param {Error} error
     */
    _handleError(error) {
        this.errors.push(error);
        logger.error(
            `[${this.name}] handling error (${this.errors.length}): ${error.message} : ${error.stack}`
        );
        if (this.errors.length > config.maxSessionErrors) {
            let message = `[${this.name}] reached error limit: `;
            for (const error of this.errors) {
                message += `${error.message},`;
            }
            this.close({ code: SESSION_CLOSE_CODE.ERROR, cause: message });
        }
    }

    /**
     * If this session's production changed, we need to update the consumption of all other sessions.
     */
    _updateRemoteConsumers() {
        for (const session of this._channel.sessions.values()) {
            // no need to await
            session.consume(this);
        }
    }

    /**
     * @param {{name: string, payload: Object }} param0
     */
    async _handleMessage({ name, payload }) {
        switch (name) {
            case CLIENT_MESSAGE.BROADCAST:
                {
                    this._broadcast({
                        name: SERVER_MESSAGE.BROADCAST,
                        payload: {
                            senderId: this.id,
                            message: payload,
                        },
                    });
                }
                break;
            case CLIENT_MESSAGE.CONSUMPTION_CHANGE:
                {
                    /** @type {{ sessionId: number, states: Object<boolean> }} */
                    const { sessionId, states } = payload;
                    for (const [type, active] of Object.entries(states)) {
                        const consumer = this._consumers.get(sessionId)?.[type];
                        if (consumer) {
                            logger.verbose(
                                `[${this.name}] changed consumption of ${type}-${sessionId} to ${
                                    active ? "on" : "off"
                                }`
                            );
                            if (active) {
                                await consumer.resume();
                            } else {
                                await consumer.pause();
                            }
                        }
                    }
                }
                break;
            case CLIENT_MESSAGE.PRODUCTION_CHANGE:
                {
                    const { type, active } = payload;
                    if (type === "screen") {
                        this.info.isScreenSharingOn = active;
                    } else if (type === "camera") {
                        this.info.isCameraOn = active;
                    }
                    const producer = this.producers[type];
                    if (!producer) {
                        return;
                    }
                    logger.debug(`[${this.name}] ${type} ${active ? "on" : "off"}`);
                    if (active) {
                        await producer.resume();
                    } else {
                        await producer.pause();
                    }
                    this._updateRemoteConsumers();
                    this._broadcastInfo();
                }
                break;
            case CLIENT_MESSAGE.INFO_CHANGE:
                {
                    for (const [key, value] of Object.entries(payload.info)) {
                        if (key in this.info) {
                            this.info[key] = Boolean(value);
                        }
                    }
                    if (payload.needRefresh) {
                        this.bus.send(
                            {
                                name: SERVER_MESSAGE.INFO_CHANGE,
                                payload: this._channel.sessionsInfo,
                            },
                            { batch: true }
                        );
                    }
                    this._broadcastInfo();
                }
                break;
        }
    }

    /**
     * @param {{name: string, payload: Object }} param0
     * @returns {Promise<any>} any JSON-serializable
     */
    async _handleRequest({ name, payload }) {
        switch (name) {
            case CLIENT_REQUEST.CONNECT_STC_TRANSPORT: {
                const { dtlsParameters, iceParameters } = payload;
                await this._stcTransport.connect({ dtlsParameters, iceParameters });
                return;
            }
            case CLIENT_REQUEST.CONNECT_CTS_TRANSPORT: {
                const { dtlsParameters, iceParameters } = payload;
                await this._ctsTransport.connect({ dtlsParameters, iceParameters });
                return;
            }
            case CLIENT_REQUEST.INIT_PRODUCER: {
                const { type, kind, rtpParameters } = payload;
                this.producers[type]?.close();
                this.producers[type] = null;
                let producer;
                try {
                    producer = await this._ctsTransport.produce({
                        kind,
                        rtpParameters,
                    });
                } catch (error) {
                    this._handleError(error);
                    return;
                }
                this.producers[type] = producer;
                this.on("close", () => {
                    producer.close();
                    this.producers[type] = null;
                });
                if (type === "screen") {
                    this.info.isScreenSharingOn = true;
                } else if (type === "camera") {
                    this.info.isCameraOn = true;
                }
                const codec = producer.rtpParameters.codecs[0];
                logger.debug(`[${this.name}] producing ${type}: ${codec?.mimeType}`);
                this._updateRemoteConsumers();
                this._broadcastInfo();
                return { id: producer.id };
            }
        }
    }
}
