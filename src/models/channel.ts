import { EventEmitter } from "node:events";
import crypto from "node:crypto";

import type { Router, Worker, WebRtcServer } from "mediasoup/node/lib/types";

import * as config from "#src/config.ts";
import { getAllowedCodecs, Logger } from "#src/utils/utils.ts";
import { AuthenticationError, OvercrowdedError } from "#src/utils/errors.ts";
import {
    Session,
    SESSION_CLOSE_CODE,
    type SessionId,
    type SessionInfo
} from "#src/models/session.ts";
import { getWorker, type RtcWorker } from "#src/services/rtc.ts";

const logger = new Logger("CHANNEL");

const mediaCodecs = getAllowedCodecs();

export interface SessionsStats {
    incomingBitRate: {
        /** Total bitrate across all media types */
        total: number;
        /** Screen sharing bitrate */
        screen: number;
        /** Audio bitrate */
        audio: number;
        /** Camera video bitrate */
        camera: number;
    };
    /** Total number of active sessions */
    count: number;
    /** Number of sessions with camera enabled */
    cameraCount: number;
    /** Number of sessions with screen sharing enabled */
    screenCount: number;
}
export interface ChannelStats {
    /** Channel creation timestamp */
    createDate: string;
    /** Unique channel identifier */
    uuid: string;
    /** Remote address that created the channel */
    remoteAddress: string;
    /** Aggregated statistics for all sessions */
    sessionsStats: SessionsStats;
    /** Whether WebRTC functionality is enabled */
    webRtcEnabled: boolean;
}
interface ChannelCreateOptions {
    /** Optional encryption key for channel authentication */
    key?: string;
    /** Whether to enable WebRTC functionality */
    useWebRtc?: boolean;
}
interface JoinResult {
    /** The channel instance */
    channel: Channel;
    /** The created session */
    session: Session;
}

/**
 * @fires Channel#sessionJoin
 * @fires Channel#sessionLeave
 * @fires Channel#close
 */
export class Channel extends EventEmitter {
    /** Global registry of all active channels by UUID */
    static records = new Map<string, Channel>();
    /** Global registry of channels by issuer for reuse */
    static recordsByIssuer = new Map<string, Channel>();
    /** Channel creation timestamp */
    public readonly createDate: string;
    /** Remote address that created this channel */
    public readonly remoteAddress: string;
    /** Unique channel identifier */
    public readonly uuid: string;
    /** Short name for logging (last 5 chars of UUID) */
    public readonly name: string;
    /** Optional encryption key for authentication */
    public readonly key?: Buffer;
    /** mediasoup Router for media routing */
    public readonly router?: Router;
    /** Active sessions in this channel */
    public readonly sessions = new Map<SessionId, Session>();
    /** mediasoup Worker handling this channel */
    private readonly _worker?: RtcWorker;
    /** Timeout for auto-closing empty channels */
    private _closeTimeout?: NodeJS.Timeout;

    /**
     * @param remoteAddress - IP address of the client creating the channel
     * @param issuer - Unique identifier for the channel creator, that can be unique per entry point, as it is used
     * to make the creation idempotent and unique by request site (issuer).
     * @param options - Channel creation options
     * @returns Promise resolving to the channel instance
     */
    static async create(
        remoteAddress: string,
        issuer: string,
        options: ChannelCreateOptions = {}
    ): Promise<Channel> {
        const { key, useWebRtc = true } = options;
        const safeIssuer = `${remoteAddress}::${issuer}`;
        const oldChannel = Channel.recordsByIssuer.get(safeIssuer);
        if (oldChannel) {
            logger.verbose(`reusing channel ${oldChannel.uuid}`);
            return oldChannel;
        }
        const channelOptions: ChannelCreateOptions & {
            worker?: Worker;
            router?: Router;
        } = { key };
        if (useWebRtc) {
            channelOptions.worker = await getWorker();
            channelOptions.router = await channelOptions.worker.createRouter({
                mediaCodecs
            });
        }
        const channel = new Channel(remoteAddress, channelOptions);
        Channel.recordsByIssuer.set(safeIssuer, channel);
        Channel.records.set(channel.uuid, channel);
        logger.info(
            `created channel ${channel.uuid} (${key ? "unique" : "global"} key) for ${safeIssuer}`
        );
        const onWorkerDeath = () => {
            logger.warn(`worker died, closing channel ${channel.uuid}`);
            channel.close();
        };
        channelOptions.worker?.once("died", onWorkerDeath);
        channel.once("close", () => {
            channelOptions.worker?.off("died", onWorkerDeath);
            Channel.recordsByIssuer.delete(safeIssuer);
            Channel.records.delete(channel.uuid);
        });
        channel.setCloseTimeout(true);
        return channel;
    }

    /**
     * @param uuid - Channel UUID
     * @param sessionId - Session identifier
     * @returns Object containing the channel and created session
     * @throws {AuthenticationError} If channel doesn't exist
     * @throws {OvercrowdedError} If channel is at capacity
     */
    static join(uuid: string, sessionId: SessionId): JoinResult {
        const channel = Channel.records.get(uuid);
        if (!channel) {
            throw new AuthenticationError(`channel [${uuid}] does not exist`);
        }
        if (channel.sessions.size >= config.CHANNEL_SIZE) {
            throw new OvercrowdedError(`channel [${uuid}] is full`);
        }
        const session = channel.join(sessionId);
        return { channel, session };
    }

    /**
     * Closes all active channels
     */
    static closeAll(): void {
        for (const channel of Channel.records.values()) {
            channel.close();
        }
    }

    /**
     * @param remoteAddress - IP address of the channel creator
     * @param options - Channel configuration options
     */
    constructor(
        remoteAddress: string,
        options: ChannelCreateOptions & {
            worker?: Worker;
            router?: Router;
        } = {}
    ) {
        super();
        const { key, worker, router } = options;
        const now = new Date();
        this.createDate = now.toISOString();
        this.remoteAddress = remoteAddress;
        this.key = key ? Buffer.from(key, "base64") : undefined;
        this.uuid = crypto.randomUUID();
        this.name = `${remoteAddress}*${this.uuid.slice(-5)}`;
        this.router = router;
        this._worker = worker;

        // Bind event handlers
        this._onSessionClose = this._onSessionClose.bind(this);
    }

    async getStats(): Promise<ChannelStats> {
        return {
            createDate: this.createDate,
            uuid: this.uuid,
            remoteAddress: this.remoteAddress,
            sessionsStats: await this.getSessionsStats(),
            webRtcEnabled: Boolean(this._worker)
        };
    }

    get sessionsInfo(): Record<SessionId, SessionInfo> {
        const sessionsInfo: Record<SessionId, SessionInfo> = {};
        for (const session of this.sessions.values()) {
            sessionsInfo[session.id] = session.info;
        }
        return sessionsInfo;
    }

    get webRtcServer(): WebRtcServer | undefined {
        return this._worker?.appData.webRtcServer;
    }

    async getSessionsStats(): Promise<SessionsStats> {
        let audioSum = 0;
        let cameraSum = 0;
        let screenSum = 0;
        let cameraCount = 0;
        let screenCount = 0;
        const proms: Promise<void>[] = [];

        for (const session of this.sessions.values()) {
            if (session.info.isCameraOn) {
                cameraCount++;
            }
            if (session.info.isScreenSharingOn) {
                screenCount++;
            }
            proms.push(
                (async () => {
                    try {
                        const { audio, camera, screen } = await session.getProducerBitRates();
                        audioSum += audio || 0;
                        cameraSum += camera || 0;
                        screenSum += screen || 0;
                    } catch (error) {
                        logger.warn(`Failed to get bitrates for session ${session.id}: ${error}`);
                    }
                })()
            );
        }
        await Promise.all(proms);
        return {
            count: this.sessions.size,
            cameraCount,
            screenCount,
            incomingBitRate: {
                audio: audioSum,
                camera: cameraSum,
                screen: screenSum,
                total: audioSum + cameraSum + screenSum
            }
        };
    }

    join(sessionId: SessionId): Session {
        const oldSession = this.sessions.get(sessionId);
        if (oldSession) {
            oldSession.off("close", this._onSessionClose);
            oldSession.close({ code: SESSION_CLOSE_CODE.REPLACED });
        }
        const session = new Session(sessionId, this);
        this.sessions.set(session.id, session);
        if (this.sessions.size > 1) {
            this.setCloseTimeout(false);
        }
        session.once("close", this._onSessionClose);
        /**
         * @event Channel#sessionJoin
         * @type {SessionId} sessionId - ID of the joining session
         */
        this.emit("sessionJoin", session.id);
        return session;
    }

    setCloseTimeout(active: boolean): void {
        if (active) {
            if (this._closeTimeout) {
                return;
            }
            this._closeTimeout = setTimeout(() => {
                this.close();
            }, config.timeouts.channel);
        } else {
            clearTimeout(this._closeTimeout);
            this._closeTimeout = undefined;
        }
    }

    /**
     * @fires Channel#close
     */
    close(): void {
        for (const session of this.sessions.values()) {
            session.off("close", this._onSessionClose);
            session.close({ code: SESSION_CLOSE_CODE.CHANNEL_CLOSED });
        }
        clearTimeout(this._closeTimeout);
        this.sessions.clear();
        Channel.records.delete(this.uuid);
        /**
         * @event Channel#close
         * @type {string} channelId - UUID of the closed channel
         */
        this.emit("close", this.uuid);
    }

    /**
     * @param event - Close event with session ID
     * @fires Channel#sessionLeave
     */
    private _onSessionClose({ id }: { id: SessionId }): void {
        this.sessions.delete(id);
        /**
         * @event Channel#sessionLeave
         * @type {SessionId} sessionId
         */
        this.emit("sessionLeave", id);
        if (this.sessions.size <= 1) {
            /**
             * If there is only one person left in the call, we already start the timeout as
             * a single person should not keep a channel alive forever.
             */
            this.setCloseTimeout(true);
        }
    }
}
