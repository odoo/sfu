// eslint-disable-next-line node/no-unpublished-import
import { Device } from "mediasoup-client";

import type {
    Consumer,
    MediaKind,
    Producer,
    ProducerOptions,
    Transport
    // eslint-disable-next-line node/no-unpublished-import
} from "mediasoup-client/lib/types";

import { Bus } from "#src/shared/bus.ts";
import {
    CLIENT_MESSAGE,
    CLIENT_REQUEST,
    SERVER_MESSAGE,
    SERVER_REQUEST,
    WS_CLOSE_CODE
} from "#src/shared/enums.ts";
import type { JSONSerializable, StreamType, BusMessage } from "#src/shared/types";
import type { TransportConfig, SessionId, SessionInfo } from "#src/models/session";

interface Consumers {
    audio: Consumer | null;
    camera: Consumer | null;
    screen: Consumer | null;
}
interface Producers {
    audio: Producer | null;
    camera: Producer | null;
    screen: Producer | null;
}
interface ProducerRecoveryTimeouts {
    audio?: number;
    camera?: number;
    screen?: number;
}
interface ConnectOptions {
    /** Channel UUID to connect to */
    channelUUID?: string;
    /** ICE servers for WebRTC connection */
    iceServers?: RTCIceServer[];
}
interface UpdateInfoOptions {
    /** Whether server should refresh local info from all sessions */
    needRefresh?: boolean;
}
export type DownloadStates = Partial<Record<StreamType, boolean>>;
export enum CLIENT_UPDATE {
    /** A new track has been received */
    TRACK = "track",
    /** A message has been received */
    BROADCAST = "broadcast",
    /** A session has left the channel */
    DISCONNECT = "disconnect",
    /** Session info has changed */
    INFO_CHANGE = "info_change"
}
type ClientUpdatePayload =
    | { senderId: SessionId; message: JSONSerializable }
    | { sessionId: SessionId }
    | Record<SessionId, SessionInfo>
    | {
          type: StreamType;
          sessionId: SessionId;
          track: MediaStreamTrack;
          active: boolean;
      };
interface SfuStats {
    /** Upload transport statistics */
    uploadStats?: RTCStatsReport;
    /** Download transport statistics */
    downloadStats?: RTCStatsReport;
    /** Producer statistics by stream type */
    [key: string]: RTCStatsReport | undefined;
}

const INITIAL_RECONNECT_DELAY = 1_000;
const MAXIMUM_RECONNECT_DELAY = 30_000;
const MAX_ERRORS = 6;
const RECOVERY_DELAY = 1_000;
const SUPPORTED_TYPES = new Set(["audio", "camera", "screen"]);

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
const DEFAULT_PRODUCER_OPTIONS: ProducerOptions = {
    stopTracks: false,
    disableTrackOnPause: false,
    zeroRtpOnPause: true
};

/**
 * SFU client states during connection lifecycle
 */
export enum SfuClientState {
    /**
     * The client is not connected to the server and does not want to do so.
     * This state is intentional and is only set at creation or when client calls disconnect.
     */
    DISCONNECTED = "disconnected",
    /**
     * The client is trying to connect to the server, it is not authenticated yet.
     */
    CONNECTING = "connecting",
    /**
     * The initial handshake with the server has been done and the client is authenticated,
     * the bus is ready to be used.
     */
    AUTHENTICATED = "authenticated",
    /**
     * The client is ready to send and receive tracks.
     */
    CONNECTED = "connected",
    /**
     * This state is reached when the connection is lost and the client is trying to reconnect.
     */
    RECOVERING = "recovering",
    /**
     * This state is reached when the connection is stopped and there should be no
     * automated attempt to reconnect.
     */
    CLOSED = "closed"
}

// Legacy export for backward compatibility
export const SFU_CLIENT_STATE = SfuClientState;

const ACTIVE_STATES = new Set<SfuClientState>([
    SfuClientState.CONNECTING,
    SfuClientState.AUTHENTICATED,
    SfuClientState.CONNECTED
]);

/**
 * This class runs on the client and represents the server, abstracting the mediasoup API.
 * It handles authentication, connection recovery, and transport/consumers/producers maintenance.
 *
 * @fires SfuClient#stateChange
 * @fires SfuClient#update
 */
export class SfuClient extends EventTarget {
    /** Connection errors encountered */
    public errors: Error[] = [];
    /** Current client state */
    private _state: SfuClientState = SfuClientState.DISCONNECTED;
    /** Communication bus */
    private _bus?: Bus;
    /** JWT token for authentication */
    private _jsonWebToken?: string;
    /** Connection URL */
    private _url?: string;
    /** Channel UUID */
    private _channelUUID?: string;
    /** ICE servers configuration */
    private _iceServers?: RTCIceServer[];
    /** mediasoup Device */
    private _device?: Device;
    /** Producer recovery timeouts */
    private _recoverProducerTimeouts: ProducerRecoveryTimeouts = {};
    /** Client-to-server transport */
    private _ctsTransport?: Transport;
    /** Server-to-client transport */
    private _stcTransport?: Transport;
    /** Reconnection delay */
    private _connectRetryDelay = INITIAL_RECONNECT_DELAY;
    /** Consumer instances by session ID */
    private readonly _consumers = new Map<SessionId, Consumers>();
    /** Producer instances */
    private readonly _producers: Producers = {
        audio: null,
        camera: null,
        screen: null
    };
    /** Producer options by media kind */
    private _producerOptionsByKind: Record<MediaKind, ProducerOptions> = {
        audio: DEFAULT_PRODUCER_OPTIONS,
        video: DEFAULT_PRODUCER_OPTIONS
    };
    /** Cleanup functions to call on disconnect */
    private readonly _cleanups: (() => void)[] = [];

    constructor() {
        super();
        this._handleMessage = this._handleMessage.bind(this);
        this._handleRequest = this._handleRequest.bind(this);
        this._handleConnectionEnd = this._handleConnectionEnd.bind(this);
    }

    get state(): SfuClientState {
        return this._state;
    }

    private set state(state: SfuClientState) {
        this._state = state;
        this.dispatchEvent(
            new CustomEvent("stateChange", {
                detail: { state }
            })
        );
    }

    /**
     * @param message - Any JSON serializable object
     */
    broadcast(message: JSONSerializable): void {
        this._bus?.send(
            {
                name: CLIENT_MESSAGE.BROADCAST,
                payload: message
            },
            { batch: true }
        );
    }

    /**
     * @param url - WebSocket URL
     * @param jsonWebToken - Authentication token
     * @param options - Connection options
     */
    async connect(url: string, jsonWebToken: string, options: ConnectOptions = {}): Promise<void> {
        const { channelUUID, iceServers } = options;

        // Save parameters for reconnection attempts
        this._url = url.replace(/^http/, "ws"); // Ensure WebSocket URL
        this._jsonWebToken = jsonWebToken;
        this._iceServers = iceServers;
        this._channelUUID = channelUUID;
        this._connectRetryDelay = INITIAL_RECONNECT_DELAY;
        this._device = this._createDevice();
        await this._connect();
    }

    disconnect(): void {
        this._clear();
        this.state = SfuClientState.DISCONNECTED;
    }

    async getStats(): Promise<SfuStats> {
        const stats: SfuStats = {};
        const [uploadStats, downloadStats] = await Promise.all([
            this._ctsTransport?.getStats(),
            this._stcTransport?.getStats()
        ]);
        stats.uploadStats = uploadStats;
        stats.downloadStats = downloadStats;
        const proms: Promise<void>[] = [];
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
     */
    updateInfo(info: SessionInfo, options: UpdateInfoOptions = {}): void {
        const { needRefresh } = options;
        this._bus?.send(
            {
                name: CLIENT_MESSAGE.INFO_CHANGE,
                payload: { info, needRefresh }
            },
            { batch: true }
        );
    }

    /**
     * Stop or resume the consumption of tracks from the other call participants.
     */
    updateDownload(sessionId: SessionId, states: DownloadStates): void {
        const consumers = this._consumers.get(sessionId);
        if (!consumers) {
            return;
        }
        let hasChanged = false;
        for (const [type, active] of Object.entries(states)) {
            if (!SUPPORTED_TYPES.has(type as StreamType)) {
                continue;
            }
            const consumer = consumers[type as StreamType];
            if (consumer) {
                const wasActive = !consumer.paused;
                if (active === wasActive) {
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
                payload: { sessionId, states }
            },
            { batch: true }
        );
    }

    /**
     * @param type - Media type to update
     * @param track - MediaStreamTrack to upload (null removes the track)
     */
    async updateUpload(type: StreamType, track: MediaStreamTrack | null): Promise<void> {
        if (!SUPPORTED_TYPES.has(type)) {
            throw new Error(`Unsupported media type ${type}`);
        }
        clearTimeout(this._recoverProducerTimeouts[type]);
        const existingProducer = this._producers[type];
        if (existingProducer) {
            if (track) {
                await existingProducer.replaceTrack({ track });
            }
            this._bus?.send(
                {
                    name: CLIENT_MESSAGE.PRODUCTION_CHANGE,
                    payload: { type, active: Boolean(track) }
                },
                { batch: true }
            );
            return;
        }
        if (!track) {
            return;
        }
        try {
            this._producers[type] = await this._ctsTransport!.produce({
                ...this._producerOptionsByKind[track.kind as MediaKind],
                track,
                appData: { type }
            });
        } catch (error) {
            this.errors.push(error as Error);
            // if we reach the max error count, we restart the whole connection from scratch
            if (this.errors.length > MAX_ERRORS) {
                // not awaited
                this._handleConnectionEnd();
                return;
            }
            // retry after some delay
            this._recoverProducerTimeouts[type] = setTimeout(async () => {
                await this.updateUpload(type, track);
            }, RECOVERY_DELAY) as unknown as number; // Type assertion as setTimeout returns a number in browsers
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
     */
    protected _createDevice(): Device {
        return new Device();
    }

    /**
     * To be overridden in tests.
     */
    protected _createWebSocket(url: string): WebSocket {
        return new WebSocket(url);
    }

    private async _connect(): Promise<void> {
        if (ACTIVE_STATES.has(this.state)) {
            return;
        }
        this._clear();
        this.state = SfuClientState.CONNECTING;
        try {
            this._bus = await this._createBus();
            this.state = SfuClientState.AUTHENTICATED;
        } catch {
            this._handleConnectionEnd();
            return;
        }
        this._bus.onMessage = this._handleMessage;
        this._bus.onRequest = this._handleRequest;
    }

    private _close(cause?: string): void {
        this._clear();
        const state = SfuClientState.CLOSED;
        this._state = state;
        this.dispatchEvent(
            new CustomEvent("stateChange", {
                detail: { state, cause }
            })
        );
    }

    private _createBus(): Promise<Bus> {
        return new Promise((resolve, reject) => {
            let webSocket: WebSocket;
            try {
                webSocket = this._createWebSocket(this._url!);
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
                        JSON.stringify({
                            channelUUID: this._channelUUID,
                            jwt: this._jsonWebToken
                        })
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

    private _onCleanup(callback: () => void): void {
        this._cleanups.push(callback);
    }

    private _clear(): void {
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

    private _makeCTSTransport(ctsConfig: TransportConfig): void {
        const transport = this._device!.createSendTransport({
            ...ctsConfig,
            iceServers: this._iceServers
        });
        transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
                await this._bus!.request({
                    name: CLIENT_REQUEST.CONNECT_CTS_TRANSPORT,
                    payload: { dtlsParameters }
                });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });
        transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
                const result = (await this._bus!.request({
                    name: CLIENT_REQUEST.INIT_PRODUCER,
                    payload: { type: appData.type as StreamType, kind, rtpParameters }
                })) as { id: string };
                callback({ id: result.id });
            } catch (error) {
                errback(error as Error);
            }
        });
        this._ctsTransport = transport;
        this._onCleanup(() => transport.close());
    }

    private _makeSTCTransport(stcConfig: TransportConfig): void {
        const transport = this._device!.createRecvTransport({
            ...stcConfig,
            iceServers: this._iceServers
        });
        transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
                await this._bus!.request({
                    name: CLIENT_REQUEST.CONNECT_STC_TRANSPORT,
                    payload: { dtlsParameters }
                });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });
        this._stcTransport = transport;
        this._onCleanup(() => transport.close());
    }

    private _removeConsumers(sessionId: SessionId): void {
        const consumers = this._consumers.get(sessionId);
        if (!consumers) {
            return;
        }
        for (const consumer of Object.values(consumers)) {
            consumer?.close();
        }
        this._consumers.delete(sessionId);
    }

    private _updateClient(name: CLIENT_UPDATE, payload?: ClientUpdatePayload): void {
        this.dispatchEvent(
            new CustomEvent("update", {
                detail: { name, payload }
            })
        );
    }

    private _handleConnectionEnd(event?: Event | CloseEvent): void {
        if (this.state === SfuClientState.DISCONNECTED) {
            return; // Intentional disconnect
        }
        const closeCode = (event as CloseEvent)?.code;
        switch (closeCode) {
            case WS_CLOSE_CODE.CHANNEL_FULL:
                this._close("full");
                return;
            case WS_CLOSE_CODE.AUTHENTICATION_FAILED:
            case WS_CLOSE_CODE.KICKED:
                this._close();
                return;
        }
        this.state = SfuClientState.RECOVERING;
        // Retry connecting with an exponential backoff.
        this._connectRetryDelay =
            Math.min(this._connectRetryDelay * 1.5, MAXIMUM_RECONNECT_DELAY) + 1000 * Math.random();
        const timeout = window.setTimeout(() => this._connect(), this._connectRetryDelay);
        this._onCleanup(() => clearTimeout(timeout));
    }

    private async _handleMessage({ name, payload }: BusMessage): Promise<void> {
        switch (name) {
            case SERVER_MESSAGE.BROADCAST:
                this._updateClient(CLIENT_UPDATE.BROADCAST, payload);
                break;
            case SERVER_MESSAGE.SESSION_LEAVE: {
                const { sessionId } = payload as { sessionId: SessionId };
                this._removeConsumers(sessionId);
                this._updateClient(CLIENT_UPDATE.DISCONNECT, payload);
                break;
            }
            case SERVER_MESSAGE.INFO_CHANGE:
                this._updateClient(CLIENT_UPDATE.INFO_CHANGE, payload);
                break;
        }
    }

    private async _handleRequest({ name, payload }: BusMessage): Promise<JSONSerializable | void> {
        switch (name) {
            case SERVER_REQUEST.INIT_CONSUMER: {
                const { id, kind, producerId, rtpParameters, sessionId, type, active } = payload;
                let consumers = this._consumers.get(sessionId);
                if (!consumers) {
                    consumers = { audio: null, camera: null, screen: null };
                    this._consumers.set(sessionId, consumers);
                } else {
                    consumers[type]?.close();
                }
                const consumer = await this._stcTransport!.consume({
                    id,
                    producerId,
                    kind,
                    rtpParameters
                });
                if (!active) {
                    consumer.pause();
                } else {
                    consumer.resume();
                }
                this._updateClient(CLIENT_UPDATE.TRACK, {
                    type,
                    sessionId,
                    track: consumer.track,
                    active
                });
                consumers[type] = consumer;
                return;
            }
            case SERVER_REQUEST.INIT_TRANSPORTS: {
                const { capabilities, stcConfig, ctsConfig, producerOptionsByKind } = payload;
                if (producerOptionsByKind) {
                    this._producerOptionsByKind = producerOptionsByKind;
                }
                if (!this._device!.loaded) {
                    await this._device!.load({ routerRtpCapabilities: capabilities });
                }
                this._makeSTCTransport(stcConfig);
                this._makeCTSTransport(ctsConfig);
                this.state = SfuClientState.CONNECTED;
                return this._device!.rtpCapabilities;
            }
            case SERVER_REQUEST.PING:
                return; // Just respond to keep connection alive
        }
    }
}
