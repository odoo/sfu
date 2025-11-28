import fs from "node:fs/promises";
import path from "node:path";

import * as mediasoup from "mediasoup";

import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { PortLimitReachedError } from "#src/utils/errors.ts";

const availablePorts: Set<number> = new Set();
let unique = 1;

// TODO instead of RtcWorker, try Worker<RtcAppData>
export interface RtcWorker extends mediasoup.types.Worker {
    appData: {
        webRtcServer?: mediasoup.types.WebRtcServer;
    };
}

// TODO maybe write some docstring, file used to manage resources such as folders, workers, ports

const logger = new Logger("RESOURCES");
const workers = new Set<RtcWorker>();
const directory = path.join(config.tmpDir, "resources");

export async function start(): Promise<void> {
    logger.info("starting...");
    // any existing folders are deleted since they are unreachable
    await fs.rm(directory, { recursive: true }).catch((error) => {
        logger.verbose(`Nothing to remove at ${directory}: ${error}`);
    });
    for (let i = 0; i < config.NUM_WORKERS; ++i) {
        await makeWorker();
    }
    logger.info(`initialized ${workers.size} mediasoup workers`);
    logger.info(
        `transport(RTC) layer at ${config.PUBLIC_IP}:${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`
    );
    /**
     * Moving ports in steps of 2 because FFMPEG may use their allocated port + 1 for RTCP
     */
    for (let i = config.dynamicPorts.min; i <= config.dynamicPorts.max; i += 2) {
        availablePorts.add(i);
    }
    logger.info(
        `${availablePorts.size} dynamic ports available [${config.dynamicPorts.min}-${config.dynamicPorts.max}]`
    );
}

export function close(): void {
    for (const worker of workers) {
        worker.appData.webRtcServer?.close();
        worker.close();
    }
    for (const dir of Folder.usedDirs) {
        fs.rm(dir, { recursive: true }).catch((error) => {
            logger.error(`Failed to delete folder ${dir}: ${error}`);
        });
    }
    Folder.usedDirs.clear();
    workers.clear();
}

async function makeWorker(): Promise<void> {
    const worker = await mediasoup.createWorker(config.rtc.workerSettings);
    worker.appData.webRtcServer = await worker.createWebRtcServer(config.rtc.rtcServerOptions);
    workers.add(worker as RtcWorker);
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
 * @throws {Error} If no workers are available
 */
export async function getWorker(): Promise<mediasoup.types.Worker> {
    const proms = [];
    let leastUsedWorker: mediasoup.types.Worker | undefined;
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
    static usedDirs: Set<string> = new Set();
    path: string;

    static async create(name: string) {
        const p: string = path.join(directory, name);
        await fs.mkdir(p, { recursive: true });
        return new Folder(p);
    }

    constructor(path: string) {
        this.path = path;
        Folder.usedDirs.add(path);
    }

    async add(name: string, content: string) {
        await fs.writeFile(path.join(this.path, name), content);
    }

    async seal(path: string) {
        const destinationPath = path;
        try {
            await fs.rename(this.path, destinationPath);
            logger.verbose(`Moved folder from ${this.path} to ${destinationPath}`);
            Folder.usedDirs.delete(this.path);
            this.path = destinationPath;
        } catch (error) {
            logger.error(`Failed to move folder from ${this.path} to ${destinationPath}: ${error}`);
        }
    }
    async delete() {
        try {
            await fs.rm(this.path, { recursive: true });
            logger.verbose(`Deleted folder ${this.path}`);
        } catch (error) {
            logger.error(`Failed to delete folder ${this.path}: ${error}`);
        }
    }
}

export async function getFolder(): Promise<Folder> {
    return Folder.create(`${Date.now()}-${unique++}`);
}
export class DynamicPort {
    number: number;

    constructor(number: number) {
        availablePorts.delete(number);
        this.number = number;
        logger.verbose(`Acquired port ${this.number}`);
    }

    release() {
        availablePorts.add(this.number);
        logger.verbose(`Released port ${this.number}`);
    }
}

export function getPort(): DynamicPort {
    const number = availablePorts.values().next().value;
    if (!number) {
        throw new PortLimitReachedError();
    }
    return new DynamicPort(number);
}
