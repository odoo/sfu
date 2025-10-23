import * as mediasoup from "mediasoup";
import type { WebRtcServerOptions } from "mediasoup/node/lib/types";

import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";

export interface RtcWorker extends mediasoup.types.Worker {
    appData: {
        webRtcServer?: mediasoup.types.WebRtcServer;
    };
}

const logger = new Logger("RESOURCES");
const workers = new Set<RtcWorker>();

export async function start(): Promise<void> {
    logger.info("starting...");
    for (let i = 0; i < config.NUM_WORKERS; ++i) {
        await makeWorker();
    }
    logger.info(`initialized ${workers.size} mediasoup workers`);
    logger.info(
        `transport(RTC) layer at ${config.PUBLIC_IP}:${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`
    );
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

export function getFolder() {
    // create a temp folder at a path, returns the path and a function to seal the folder
    return {
        path: "",
        sealFolder: () => {
            // move the content into a permanent folder location so it can easily be retrieved for processing later
            // or directly forward for transcription
        },
    }
}

export function getPort() {
}

export function releasePort(port: number) {
}
