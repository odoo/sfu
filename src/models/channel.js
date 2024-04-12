import { EventEmitter } from "node:events";

import * as config from "#src/config.js";
import { getAllowedCodecs, Logger } from "#src/utils/utils.js";
import { AuthenticationError, OvercrowdedError } from "#src/utils/errors.js";
import { Session, SESSION_CLOSE_CODE } from "#src/models/session.js";
import { getWorker } from "#src/services/rtc.js";

const logger = new Logger("CHANNEL");

const mediaCodecs = getAllowedCodecs();

/**
 * @typedef {Object} SessionsStats
 * @property {{total: number, screen: number, audio: number, camera: number}} incomingBitRate
 * @property {number} count
 * @property {number} cameraCount
 * @property {number} screenCount
 */

/**
 * @fires Channel#sessionJoin
 * @fires Channel#sessionLeave
 * @fires Channel#close
 */
export class Channel extends EventEmitter {
    /** @type {Map<string, Channel>} */
    static records = new Map();
    /** @type {Map<string, Channel>} */
    static recordsByIssuer = new Map();

    /** @type {string} */
    createDate;
    /** @type {string} */
    remoteAddress;
    /** @type {string} */
    uuid;
    /** @type {string} short of uuid for logging */
    name;
    /** @type {WithImplicitCoercion<string>} base 64 buffer key */
    key;
    /** @type {import("mediasoup").types.Router}*/
    router;
    /** @type {Map<number, Session>} */
    sessions = new Map();
    /** @type {import("mediasoup").types.Worker}*/
    _worker;
    /** @type {NodeJS.Timeout} */
    _closeTimeout;

    /**
     * @param {string} remoteAddress
     * @param {string} issuer
     * @param {Object} [options]
     * @param {string} [options.key] if the key is set, authentication with this channel uses this key
     * @param {boolean} [options.useWebRtc=true] whether to use WebRTC:
     *  with webRTC: can stream audio/video
     *  without webRTC: can only use websocket
     */
    static async create(remoteAddress, issuer, { key, useWebRtc = true } = {}) {
        const safeIssuer = `${remoteAddress}::${issuer}`;
        const oldChannel = Channel.recordsByIssuer.get(safeIssuer);
        if (oldChannel) {
            logger.verbose(`reusing channel ${oldChannel.uuid}`);
            return oldChannel;
        }
        const options = { key };
        if (useWebRtc) {
            options.worker = await getWorker();
            options.router = await options.worker.createRouter({
                mediaCodecs,
            });
        }
        const channel = new Channel(remoteAddress, options);
        Channel.recordsByIssuer.set(safeIssuer, channel);
        Channel.records.set(channel.uuid, channel);
        logger.info(
            `created channel ${channel.uuid} (${key ? "unique" : "global"} key) for ${safeIssuer}`
        );
        const onWorkerDeath = () => {
            logger.warn(`worker died, closing channel ${channel.uuid}`);
            channel.close();
        };
        options.worker?.once("died", onWorkerDeath);
        channel.once("close", () => {
            options.worker?.off("died", onWorkerDeath);
            Channel.recordsByIssuer.delete(safeIssuer);
            Channel.records.delete(channel.uuid);
        });
        channel.setCloseTimeout(true);
        return channel;
    }

    /**
     * @param {string} uuid
     * @param {number} sessionId
     */
    static join(uuid, sessionId) {
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

    static closeAll() {
        for (const channel of Channel.records.values()) {
            channel.close();
        }
    }

    /**
     * @param {string} remoteAddress
     * @param {Object} [options]
     * @param {string} [options.key]
     * @param {import("mediasoup").types.Worker} [options.worker]
     * @param {import("mediasoup").types.Router} [options.router]
     */
    constructor(remoteAddress, { key, worker, router } = {}) {
        super();
        const now = new Date();
        this.createDate = now.toISOString();
        this.remoteAddress = remoteAddress;
        this.key = key && Buffer.from(key, "base64");
        this.uuid = crypto.randomUUID();
        this.name = `${remoteAddress}*${this.uuid.slice(-5)}`;
        this.router = router;
        this._worker = worker;
        this._onSessionClose = this._onSessionClose.bind(this);
    }

    /**
     * @returns {Promise<{ uuid: string, remoteAddress: string, sessionsStats: SessionsStats, createDate: string }>}
     */
    async getStats() {
        return {
            createDate: this.createDate,
            uuid: this.uuid,
            remoteAddress: this.remoteAddress,
            sessionsStats: await this.getSessionsStats(),
            webRtcEnabled: Boolean(this._worker),
        };
    }

    /**
     * @returns {Record<number, import("#src/models/session.js").SessionInfo>}
     */
    get sessionsInfo() {
        const sessionsInfo = {};
        for (const session of this.sessions.values()) {
            sessionsInfo[session.id] = session.info;
        }
        return sessionsInfo;
    }

    /**
     * @returns {import("mediasoup").types.WebRtcServer}
     */
    get webRtcServer() {
        return this._worker?.appData.webRtcServer;
    }

    /**
     * @return {Promise<SessionsStats>}
     */
    async getSessionsStats() {
        let audioSum = 0;
        let cameraSum = 0;
        let screenSum = 0;
        let cameraCount = 0;
        let screenCount = 0;
        const proms = [];
        for (const session of this.sessions.values()) {
            session.info.isCameraOn && cameraCount++;
            session.info.isScreenSharingOn && screenCount++;
            proms.push(
                (async () => {
                    const { audio, camera, screen } = await session.getProducerBitRates();
                    audioSum += audio || 0;
                    cameraSum += camera || 0;
                    screenSum += screen || 0;
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
                total: audioSum + cameraSum + screenSum,
            },
        };
    }

    /**
     * @param {number} sessionId
     * @fires Channel#sessionJoin
     * @returns {Session}
     */
    join(sessionId) {
        const oldSession = this.sessions.get(sessionId);
        if (oldSession) {
            oldSession.off("close", this._onSessionClose);
            oldSession.close(SESSION_CLOSE_CODE.REPLACED);
        }
        const session = new Session(sessionId, this);
        this.sessions.set(session.id, session);
        if (this.sessions.size > 1) {
            this.setCloseTimeout(false);
        }
        session.once("close", this._onSessionClose);
        /**
         * @event Channel#sessionJoin
         * @type {number} sessionId
         */
        this.emit("sessionJoin", session.id);
        return session;
    }

    setCloseTimeout(active) {
        if (active) {
            if (this._closeTimeout) {
                return;
            }
            this._closeTimeout = setTimeout(() => {
                this.close();
            }, config.timeouts.channel);
        } else {
            clearTimeout(this._closeTimeout);
            this._closeTimeout = null;
        }
    }

    /**
     * @fires Channel#close
     */
    close() {
        for (const session of this.sessions.values()) {
            session.off("close", this._onSessionClose);
            session.close({ code: SESSION_CLOSE_CODE.CHANNEL_CLOSED });
        }
        clearTimeout(this._closeTimeout);
        this.sessions.clear();
        Channel.records.delete(this.uuid);
        /**
         * @event Channel#close
         * @type {number} channelId
         */
        this.emit("close", this.uuid);
    }

    /**
     * @param {{ id: number }}
     * @fires Channel#sessionLeave
     */
    _onSessionClose({ id }) {
        this.sessions.delete(id);
        /**
         * @event Channel#sessionLeave
         * @type {number} sessionId
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
