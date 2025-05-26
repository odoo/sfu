import { EventEmitter } from "node:events";

import type {
    IceParameters,
    IceCandidate,
    DtlsParameters,
    SctpParameters,
    Consumer,
    Producer,
    WebRtcTransport,
    RtpCapabilities
} from "mediasoup/node/lib/types";

import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import {
    CLIENT_MESSAGE,
    CLIENT_REQUEST,
    SERVER_MESSAGE,
    SERVER_REQUEST,
    STREAM_TYPE
} from "#src/shared/enums.ts";
import type { JSONSerializable, StreamType, BusMessage } from "#src/shared/types";
import type { Bus } from "#src/shared/bus.ts";
import type { Channel } from "#src/models/channel.ts";

export type SessionId = number | string;
export type SessionInfo = {
    /** Whether the session is currently talking */
    isTalking?: boolean;
    /** Whether the camera is turned on */
    isCameraOn?: boolean;
    /** Whether screen sharing is active */
    isScreenSharingOn?: boolean;
    /** Whether the session is self-muted */
    isSelfMuted?: boolean;
    /** Whether the session is deaf (not receiving audio) */
    isDeaf?: boolean;
    /** Whether the session is raising their hand */
    isRaisingHand?: boolean;
};
export enum SESSION_STATE {
    NEW = "new",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    CLOSED = "closed"
}
export enum SESSION_CLOSE_CODE {
    CLEAN = "clean",
    REPLACED = "replaced",
    WS_ERROR = "ws_error",
    WS_CLOSED = "ws_closed",
    CHANNEL_CLOSED = "channel_closed",
    C_TIMEOUT = "connection_timeout",
    P_TIMEOUT = "ping_timeout",
    KICKED = "kicked",
    ERROR = "error"
}
export interface TransportConfig {
    /** Transport identifier */
    id: string;
    /** ICE parameters for connection establishment */
    iceParameters: IceParameters;
    /** ICE candidates for connection establishment */
    iceCandidates: IceCandidate[];
    /** DTLS parameters for secure connection */
    dtlsParameters: DtlsParameters;
    /** SCTP parameters for data channel support */
    sctpParameters: SctpParameters;
}
interface Consumers {
    /** Audio consumer */
    [STREAM_TYPE.AUDIO]: Consumer | null;
    /** Camera video consumer */
    [STREAM_TYPE.CAMERA]: Consumer | null;
    /** Screen sharing consumer */
    [STREAM_TYPE.SCREEN]: Consumer | null;
}
interface Producers {
    /** Audio producer */
    [STREAM_TYPE.AUDIO]: Producer | null;
    /** Camera video producer */
    [STREAM_TYPE.CAMERA]: Producer | null;
    /** Screen sharing producer */
    [STREAM_TYPE.SCREEN]: Producer | null;
}
interface SessionCloseOptions {
    /** Close code indicating reason for termination */
    code?: SESSION_CLOSE_CODE;
    /** Human-readable cause description */
    cause?: string;
}
interface ProducerBitRates {
    /** Audio bitrate in bps */
    [STREAM_TYPE.AUDIO]?: number;
    /** Camera video bitrate in bps */
    [STREAM_TYPE.CAMERA]?: number;
    /** Screen sharing bitrate in bps */
    [STREAM_TYPE.SCREEN]?: number;
}

const logger = new Logger("SESSION");

/**
 * Represents a real-time communication session for a participant in a channel.
 * Handles WebRTC connections, media production/consumption, and session lifecycle.
 *
 * @fires Session#stateChange - Emitted when session state changes
 * @fires Session#close - Emitted when session is closed
 */
export class Session extends EventEmitter {
    /** Communication bus for WebSocket messaging */
    public bus?: Bus;
    /** Unique session identifier */
    public readonly id: SessionId;
    /** Session information visible to other participants */
    public readonly info: SessionInfo;
    /** Remote client address */
    public remote?: string;
    /** Errors encountered during session lifecycle */
    public errors: Error[] = [];
    /** Current session state */
    private _state: SESSION_STATE = SESSION_STATE.NEW;
    /** Client RTP capabilities */
    private _clientCapabilities?: RtpCapabilities;
    /** Client-to-server WebRTC transport */
    private _ctsTransport?: WebRtcTransport;
    /** Server-to-client WebRTC transport */
    private _stcTransport?: WebRtcTransport;
    /** Media consumers indexed by session ID */
    private readonly _consumers = new Map<SessionId, Consumers>();
    /** Media producers for this session */
    public readonly producers: Producers = {
        audio: null,
        camera: null,
        screen: null
    };
    /** Parent channel containing this session */
    private readonly _channel: Channel;
    /** Recovery timeouts for failed consumers */
    private readonly _recoverConsumerTimeouts = new Map<SessionId, NodeJS.Timeout>();

    /**
     * @param id - Unique session identifier
     * @param channel - Parent channel containing this session
     */
    constructor(id: SessionId, channel: Channel) {
        super();
        this.id = id;
        this._channel = channel;
        this.info = Object.seal({
            isRaisingHand: undefined,
            isSelfMuted: undefined,
            isTalking: undefined,
            isDeaf: undefined,
            isCameraOn: undefined,
            isScreenSharingOn: undefined
        });
        this._handleMessage = this._handleMessage.bind(this);
        this._handleRequest = this._handleRequest.bind(this);
        this.setMaxListeners(config.CHANNEL_SIZE * 2);
    }

    get name(): string {
        return `${this._channel.name}:${this.id}@${this.remote}`;
    }

    get state(): SESSION_STATE {
        return this._state;
    }

    set state(state: SESSION_STATE) {
        this._state = state;
        this.emit("stateChange", state);
    }

    async getProducerBitRates(): Promise<ProducerBitRates> {
        const bitRates: ProducerBitRates = {};
        const proms: Promise<void>[] = [];
        for (const [type, producer] of Object.entries(this.producers) as [StreamType, Producer][]) {
            if (!producer) {
                continue;
            }
            proms.push(
                (async () => {
                    try {
                        const stats = await producer.getStats();
                        const codec = producer.rtpParameters?.codecs[0];
                        const bitRate = stats[0]?.bitrate;
                        logger.verbose(
                            `[${this.name}] ${type}(${codec?.mimeType}) bitrate: ${bitRate}`
                        );
                        bitRates[type] = bitRate;
                    } catch (error) {
                        logger.warn(`[${this.name}] Failed to get stats for ${type}: ${error}`);
                    }
                })()
            );
        }
        await Promise.all(proms);
        return bitRates;
    }

    private _broadcast(message: BusMessage): void {
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

    close(options: SessionCloseOptions = {}): void {
        const { code = SESSION_CLOSE_CODE.CLEAN, cause } = options;
        for (const timeout of this._recoverConsumerTimeouts.values()) {
            clearTimeout(timeout);
        }
        this._recoverConsumerTimeouts.clear();
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
                payload: { sessionId: this.id }
            });
        }
        /**
         * @event Session#close
         * @type {{ id: SessionId, code: number }}
         */
        this.emit("close", { id: this.id, code });
    }

    async connect(bus: Bus): Promise<void> {
        this.state = SESSION_STATE.CONNECTING;
        this.bus = bus;
        this.bus.onMessage = this._handleMessage;
        this.bus.onRequest = this._handleRequest;

        const connectionTimeout = setTimeout(() => {
            if (this.state !== SESSION_STATE.CONNECTED) {
                this.close({ code: SESSION_CLOSE_CODE.C_TIMEOUT });
            }
        }, config.timeouts.session);
        const pingInterval = setInterval(async () => {
            try {
                await this.bus!.request(
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

        if (this._channel.router) {
            await this._initializeTransports();
        }

        // @ts-expect-error Check if session was asynchronously closed during initialization
        if (this.state === SESSION_STATE.CLOSED) {
            logger.verbose(`[${this.name}] was closed during the connection process`);
            this._ctsTransport?.close();
            this._stcTransport?.close();
            return;
        }
        this.state = SESSION_STATE.CONNECTED;
        logger.info(`[${this.name}] connected`);
        const promises: Promise<void>[] = [];
        for (const session of this._channel.sessions.values()) {
            promises.push(this.consume(session));
            promises.push(session.consume(this));
        }
        await Promise.all(promises);
    }

    private async _initializeTransports(): Promise<void> {
        try {
            const [ctsTransport, stcTransport] = await Promise.all([
                this._channel.router!.createWebRtcTransport({
                    ...config.rtc.rtcTransportOptions,
                    webRtcServer: this._channel.webRtcServer!
                }),
                this._channel.router!.createWebRtcTransport({
                    ...config.rtc.rtcTransportOptions,
                    webRtcServer: this._channel.webRtcServer!
                })
            ]);
            this._ctsTransport = ctsTransport;
            this._stcTransport = stcTransport;
            this.once("close", () => {
                this._ctsTransport?.close();
                this._stcTransport?.close();
            });
            this._clientCapabilities = (await this.bus!.request({
                name: SERVER_REQUEST.INIT_TRANSPORTS,
                payload: {
                    capabilities: this._channel.router!.rtpCapabilities,
                    stcConfig: this._createTransportConfig(this._stcTransport),
                    ctsConfig: this._createTransportConfig(this._ctsTransport),
                    producerOptionsByKind: config.rtc.producerOptionsByKind
                }
            })) as RtpCapabilities;
            await Promise.all([
                this._ctsTransport.setMaxIncomingBitrate(config.MAX_BITRATE_IN),
                this._stcTransport.setMaxOutgoingBitrate(config.MAX_BITRATE_OUT)
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(
                `[${this.name}] failed to create transports (${errorMessage}), closing session`
            );
            this.close({
                code: SESSION_CLOSE_CODE.ERROR,
                cause: errorMessage
            });
            throw error;
        }
    }

    private _createTransportConfig(transport: WebRtcTransport): TransportConfig {
        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters!
        };
    }

    /**
     * Creates missing consumers for each producer of `params.session` and sets their appropriate `paused` state.
     * This batches the consumption of all streams.
     */
    async consume(session: Session): Promise<void> {
        if (
            this === session ||
            session.state !== SESSION_STATE.CONNECTED ||
            !this._channel.router
        ) {
            return;
        }
        let consumers = this._consumers.get(session.id);
        if (!consumers) {
            consumers = { audio: null, camera: null, screen: null };
            this._consumers.set(session.id, consumers);
            session.once("close", () => {
                if (this.state === SESSION_STATE.CLOSED) {
                    return;
                }
                for (const consumer of Object.values(consumers!)) {
                    consumer?.close();
                }
                this._consumers.delete(session.id);
            });
        }
        await this._createConsumersForSession(session, consumers);
    }

    private async _createConsumersForSession(
        session: Session,
        consumers: Consumers
    ): Promise<void> {
        for (const [type, producer] of Object.entries(session.producers) as [
            StreamType,
            Producer
        ][]) {
            if (!producer) {
                // nothing to consume
                continue;
            }
            if (
                !this._channel.router!.canConsume({
                    producerId: producer.id,
                    rtpCapabilities: this._clientCapabilities!
                })
            ) {
                continue;
            }
            try {
                const consumer = consumers[type];
                if (!consumer) {
                    const newConsumer = await this._stcTransport!.consume({
                        producerId: producer.id,
                        rtpCapabilities: this._clientCapabilities!,
                        paused: true
                    });
                    await this.bus!.request(
                        {
                            name: SERVER_REQUEST.INIT_CONSUMER,
                            payload: {
                                id: newConsumer.id,
                                kind: newConsumer.kind,
                                producerId: producer.id,
                                rtpParameters: newConsumer.rtpParameters,
                                sessionId: session.id,
                                active: !producer.paused,
                                type
                            }
                        },
                        { batch: true }
                    );

                    consumers[type]?.close();
                    consumers[type] = newConsumer;
                }
                await this._syncConsumerState(consumers[type]!, producer);
            } catch (error) {
                consumers[type]?.close();
                consumers[type] = null;
                if (session.state === SESSION_STATE.CLOSED) {
                    return;
                }
                this._handleError(error as Error);
                this._scheduleConsumerRecovery(session);
                return;
            }
        }
    }

    private async _syncConsumerState(consumer: Consumer, producer: Producer): Promise<void> {
        if (producer.paused !== consumer.paused) {
            if (producer.paused) {
                await consumer.pause();
            } else {
                await consumer.resume();
            }

            logger.verbose(
                `[${this.name}] consumer reading ${producer.kind} of [${this.name}]: ${
                    consumer.paused ? "off" : "on"
                }`
            );
        }
    }

    private _scheduleConsumerRecovery(session: Session): void {
        clearTimeout(this._recoverConsumerTimeouts.get(session.id));

        const timeout = setTimeout(() => {
            this.consume(session);
        }, config.timeouts.recovery);

        this._recoverConsumerTimeouts.set(session.id, timeout);
    }

    private _broadcastInfo(): void {
        this._broadcast({
            name: SERVER_MESSAGE.INFO_CHANGE,
            payload: { [this.id]: this.info }
        });
    }

    /**
     * registers the error and closes the session if the error limit is reached
     */
    private _handleError(error: Error): void {
        this.errors.push(error);
        logger.error(
            `[${this.name}] handling error (${this.errors.length}): ${error.message} : ${error.stack}`
        );

        if (this.errors.length > config.maxSessionErrors) {
            const message = `[${this.name}] reached error limit: ${this.errors
                .map((e) => e.message)
                .join(", ")}`;
            this.close({
                code: SESSION_CLOSE_CODE.ERROR,
                cause: message
            });
        }
    }

    /**
     * If this session's production changed, we need to update the consumption of all other sessions.
     */
    private _updateRemoteConsumers(): void {
        for (const session of this._channel.sessions.values()) {
            // Fire-and-forget consumer update
            session.consume(this);
        }
    }

    private async _handleMessage({ name, payload }: BusMessage): Promise<void> {
        switch (name) {
            case CLIENT_MESSAGE.BROADCAST:
                this._broadcast({
                    name: SERVER_MESSAGE.BROADCAST,
                    payload: {
                        senderId: this.id,
                        message: payload
                    }
                });
                break;
            case CLIENT_MESSAGE.CONSUMPTION_CHANGE: {
                const { sessionId, states } = payload;
                for (const [type, active] of Object.entries(states) as [StreamType, boolean][]) {
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
                break;
            }
            case CLIENT_MESSAGE.PRODUCTION_CHANGE: {
                const { type, active } = payload;
                if (type === STREAM_TYPE.SCREEN) {
                    this.info.isScreenSharingOn = active;
                } else if (type === STREAM_TYPE.CAMERA) {
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
                break;
            }
            case CLIENT_MESSAGE.INFO_CHANGE: {
                const { info, needRefresh } = payload;
                // Update session info with validated boolean values
                for (const [key, value] of Object.entries(info)) {
                    if (key in this.info) {
                        this.info[key as keyof SessionInfo] = Boolean(value);
                    }
                }
                if (needRefresh) {
                    this.bus!.send(
                        {
                            name: SERVER_MESSAGE.INFO_CHANGE,
                            payload: this._channel.sessionsInfo
                        },
                        { batch: true }
                    );
                }
                this._broadcastInfo();
                break;
            }
            default:
                logger.warn(`[${this.name}] Unknown message type: ${name}`);
        }
    }

    private async _handleRequest({ name, payload }: BusMessage): Promise<JSONSerializable | void> {
        switch (name) {
            case CLIENT_REQUEST.CONNECT_STC_TRANSPORT: {
                const { dtlsParameters } = payload;
                await this._stcTransport!.connect({ dtlsParameters });
                return;
            }
            case CLIENT_REQUEST.CONNECT_CTS_TRANSPORT: {
                const { dtlsParameters } = payload;
                await this._ctsTransport!.connect({ dtlsParameters });
                return;
            }
            case CLIENT_REQUEST.INIT_PRODUCER: {
                const { type, kind, rtpParameters } = payload;
                this.producers[type]?.close();
                this.producers[type] = null;
                let producer: Producer;
                try {
                    producer = await this._ctsTransport!.produce({
                        kind,
                        rtpParameters
                    });
                } catch (error) {
                    this._handleError(error as Error);
                    throw error;
                }
                this.producers[type] = producer;
                this.on("close", () => {
                    producer.close();
                    this.producers[type] = null;
                });
                if (type === STREAM_TYPE.SCREEN) {
                    this.info.isScreenSharingOn = true;
                } else if (type === STREAM_TYPE.CAMERA) {
                    this.info.isCameraOn = true;
                }
                const codec = producer.rtpParameters.codecs[0];
                logger.debug(`[${this.name}] producing ${type}: ${codec?.mimeType}`);
                this._updateRemoteConsumers();
                this._broadcastInfo();
                return { id: producer.id };
            }
            default:
                logger.warn(`[${this.name}] Unknown request type: ${name}`);
                throw new Error(`Unknown request type: ${name}`);
        }
    }
}
