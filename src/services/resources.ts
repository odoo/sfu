import * as mediasoup from "mediasoup";
import type { WebRtcServerOptions } from "mediasoup/node/lib/types";

import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { PortLimitReachedError } from "#src/utils/errors.ts";
import os from "node:os";

const availablePorts: Set<number> = new Set();
let unique = 1;

export interface RtcWorker extends mediasoup.types.Worker {
    appData: {
        webRtcServer?: mediasoup.types.WebRtcServer;
    };
}

// TODO maybe write some docstring, file used to manage resources such as folders, workers, ports

const logger = new Logger("RESOURCES");
const workers = new Set<RtcWorker>();
const tempDir = os.tmpdir() + "/ongoing_recordings";

export async function start(): Promise<void> {
    logger.info("starting...");
    for (let i = 0; i < config.NUM_WORKERS; ++i) {
        await makeWorker();
    }
    logger.info(`initialized ${workers.size} mediasoup workers`);
    logger.info(
        `transport(RTC) layer at ${config.PUBLIC_IP}:${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`
    );
    for (let i = config.dynamicPorts.min; i <= config.dynamicPorts.max; i++) {
        availablePorts.add(i);
    }
    logger.info(`${availablePorts.size} dynamic ports available [${config.dynamicPorts.min}-${config.dynamicPorts.max}]`);
}

export function close(): void {
    for (const worker of workers) {
        worker.appData.webRtcServer?.close();
        worker.close();
    }
    workers.clear();
}

async function makeWorker(): Promise<void> {
    const worker = (await mediasoup.createWorker(config.rtc.workerSettings)) as RtcWorker;
    worker.appData.webRtcServer = await worker.createWebRtcServer(
        config.rtc.rtcServerOptions as WebRtcServerOptions
    );
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
    logger.debug(`worker ${leastUsedWorker!.pid} with ${lowestUsage} ru_maxrss was selected`);
    return leastUsedWorker;
}

class Folder {
    path: string;

    constructor(path: string) {
        this.path = path;
    }

    seal(name: string) {
        console.trace(`TO IMPLEMENT, MOVING TO ${config.recording.directory}/${name}`);
    }
}

export function getFolder(): Folder {
    return new Folder(`${tempDir}/${Date.now()}-${unique++}`);
}

class DynamicPort {
    number: number;

    constructor(number: number) {
        availablePorts.delete(number);
        this.number = number;
    }

    release() {
        availablePorts.add(this.number);
    }
}

export function getPort(): DynamicPort {
    const number = availablePorts.values().next().value;
    if (!number) {
        throw new PortLimitReachedError();
    }
    return new DynamicPort(number);
}
