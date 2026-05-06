import fs from "node:fs/promises";
import path from "node:path";

import * as mediasoup from "mediasoup";

import * as config from "#src/config.ts";
import { Logger, toBigInt } from "#src/utils/utils.ts";
import { DiskSpaceLimitReachedError, PortLimitReachedError } from "#src/utils/errors.ts";

const availablePorts: number[] = [];
let unique = 1;

export const RECORDING_RESERVATION_BYTES = Math.ceil(
    (config.recording.maxDuration / (60 * 60 * 1000)) * // 1 hour
        (700 * 1024 * 1024) * // av1 average byte par hour
        4 * // raw recording multiplier
        1.2 // reservation margin
);

type RtcAppData = mediasoup.types.AppData & {
    webRtcServer?: mediasoup.types.WebRtcServer;
};
export type RtcWorker = mediasoup.types.Worker<RtcAppData>;

/**
 * Manages SFU resources such as mediasoup workers, resource folders, and dynamic ports.
 * Provides lifecycle utilities to start/clean workers, allocate folders, and hand
 * out/release transient ports.
 */

const logger = new Logger("RESOURCES");

async function setupFileSystem() {
    await clearFileSystem();
    if (config.recording.enabled) {
        await fs.mkdir(config.dir.resources, { recursive: true });
        await fs.mkdir(config.dir.recordings, { recursive: true });
        if (config.FFMPEG_LOGGING) {
            await fs.mkdir(config.dir.debug, { recursive: true });
        }
    } else {
        logger.info("Recording is disabled, scheduler service will not start");
        return;
    }
}

async function clearFileSystem() {
    try {
        if (!config.LOCAL_KEY) {
            /**
             * If the local key is not set, it means that the encryption key
             * is auto generated, so any previously encrypted recording cannot
             * be decrypted.
             */
            logger.warn("LOCAL_KEY missing from the environment, removing old recordings");
            await fs.rm(config.dir.recordings, { recursive: true, force: true });
        }
        await fs.rm(config.dir.resources, { recursive: true });
    } catch (error) {
        logger.error(`Failed to clear file system: ${error}`);
    }
}

const workers = new Set<RtcWorker>();

/**
 * Helpers exposed for testing purposes
 */
export const __testing__ = {
    hasWorker(worker: RtcWorker) {
        return workers.has(worker);
    },
    get workerCount() {
        return workers.size;
    },
    get reservedRecordingBytes() {
        return Folder.reservedRecordingBytes;
    }
};

export async function start(): Promise<void> {
    /**
     * TODO reserve dynamic ports for recordings ahead of time (conservative estimate),
     * and block recording start when remaining ports are too low.
     */
    logger.info("starting...");
    logger.info(`cleaning resources folder (${config.dir.resources})...`);
    Folder.resetReservations();
    await setupFileSystem();
    for (let i = 0; i < config.NUM_WORKERS; ++i) {
        await makeWorker();
    }
    logger.info(`initialized ${workers.size} mediasoup workers`);
    logger.info(
        `transport(RTC) layer at ${config.PUBLIC_IP}:${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`
    );
    /**
     * FIXME: Moving ports in steps of 2 because FFMPEG may use their allocated port + 1 for RTCP,
     * TODO: need to verify if FFMPEG can be configured to use muxed ports,
     * but seems to take 2 ports even with mux param to investigate more later
     */
    for (let i = config.DYNAMIC_MIN_PORT; i <= config.DYNAMIC_MAX_PORT; i += 2) {
        availablePorts.push(i);
    }
    logger.info(
        `${availablePorts.length} dynamic ports available [${config.DYNAMIC_MIN_PORT}-${config.DYNAMIC_MAX_PORT}]`
    );
}

export async function close(): Promise<void> {
    for (const worker of workers) {
        worker.appData.webRtcServer?.close();
        worker.close();
    }
    workers.clear();
    availablePorts.length = 0;
    Folder.resetReservations();
    await clearFileSystem();
}

async function makeWorker(): Promise<void> {
    const worker: RtcWorker = await mediasoup.createWorker<RtcAppData>(config.rtc.workerSettings);
    worker.appData.webRtcServer = await worker.createWebRtcServer(config.rtc.rtcServerOptions);
    workers.add(worker);
    worker.once("died", (error: Error) => {
        logger.error(`worker died: ${error.message} ${error.stack ?? ""}`);
        workers.delete(worker);
        /**
         * A new worker is made to replace the one that died.
         * TODO: We may want to limit the amount of times this happens in case deaths are unrecoverable.
         */
        makeWorker().catch((recoveryError) => {
            logger.error(`Failed to create replacement worker: ${recoveryError.message}`);
        });
    });
}

/**
 * @throws {Error} when no worker can be selected.
 */
export async function getWorker(): Promise<RtcWorker> {
    const proms = [];
    let leastUsedWorker: RtcWorker | undefined;
    let lowestUsage = Infinity;
    for (const worker of workers) {
        proms.push(
            (async () => {
                const { ru_maxrss } = await worker.getResourceUsage();
                if (ru_maxrss < lowestUsage) {
                    leastUsedWorker = worker;
                    lowestUsage = ru_maxrss;
                }
            })()
        );
    }
    await Promise.all(proms);
    if (!leastUsedWorker) {
        throw new Error("No mediasoup workers available");
    }
    logger.verbose(`worker ${leastUsedWorker!.pid} with ${lowestUsage} ru_maxrss was selected`);
    return leastUsedWorker;
}

export class Folder {
    path: string;
    name: string;
    private _reservedBytes = 0;
    private static _reservedRecordingBytes = 0;

    static get reservedRecordingBytes() {
        return Folder._reservedRecordingBytes;
    }

    static resetReservations() {
        Folder._reservedRecordingBytes = 0;
    }

    /**
     * @throws {DiskSpaceLimitReachedError} when reservation exceeds available disk.
     */
    static async create(name: string, subDirectories: string[]) {
        await Folder._checkMemoryAllocation();
        const p: string = path.join(config.dir.resources, `${name}-${unique++}`);
        await fs.mkdir(p);
        const proms = [];
        for (const subDirectory of subDirectories) {
            proms.push(fs.mkdir(path.join(p, subDirectory)));
        }
        await Promise.all(proms);
        return new Folder(p, name);
    }

    /**
     * @throws {DiskSpaceLimitReachedError} when reservation exceeds available disk.
     */
    private static async _checkMemoryAllocation() {
        const size = RECORDING_RESERVATION_BYTES;
        const stats = await fs.statfs(config.dir.resources);
        const blockSize = toBigInt(stats.bsize);
        const availableBlocks = toBigInt(stats.bavail);
        const availableDiskBytes = blockSize * availableBlocks;
        const remaining = availableDiskBytes - BigInt(Folder._reservedRecordingBytes);
        if (remaining < BigInt(size)) {
            throw new DiskSpaceLimitReachedError(
                `Not enough disk space to reserve ${size} bytes for recording`
            );
        }
    }

    private _reserveMemory() {
        const size = RECORDING_RESERVATION_BYTES;
        Folder._reservedRecordingBytes += size;
        this._reservedBytes = size;
    }

    private _releaseMemory() {
        if (!this._reservedBytes) {
            return;
        }
        Folder._reservedRecordingBytes = Math.max(
            0,
            Folder._reservedRecordingBytes - this._reservedBytes
        );
        this._reservedBytes = 0;
    }

    constructor(path: string, name: string) {
        this.path = path;
        this.name = name;
        this._reserveMemory();
    }

    async add(name: string, content: string) {
        await fs.writeFile(path.join(this.path, name), content);
    }

    async move(destinationPath: string) {
        const fullPath = path.join(destinationPath, this.name);
        try {
            await fs.mkdir(destinationPath, { recursive: true });
            await fs.rename(this.path, fullPath);
            logger.verbose(`Moved folder from ${this.path} to ${fullPath}`);
            this.path = fullPath;
        } catch (error) {
            logger.error(`Failed to move folder from ${this.path} to ${fullPath}: ${error}`);
            throw error;
        } finally {
            this._releaseMemory();
        }
    }
    async delete() {
        try {
            await fs.rm(this.path, { recursive: true });
            logger.verbose(`Deleted folder ${this.path}`);
        } catch (error) {
            logger.error(`Failed to delete folder ${this.path}: ${error}`);
        } finally {
            this._releaseMemory();
        }
    }
}
export class DynamicPort {
    number: number;

    /**
     * @throws {PortLimitReachedError} when all dynamic ports are exhausted.
     */
    constructor() {
        const maybeNum = availablePorts.shift();
        if (!maybeNum) {
            throw new PortLimitReachedError();
        }
        this.number = maybeNum;
    }

    release() {
        availablePorts.push(this.number);
    }
}
