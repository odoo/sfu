import mediasoup from "mediasoup";

import * as config from "#src/config.js";
import { Logger } from "#src/utils/utils.js";

const logger = new Logger("RTC");

/** @type {Set<mediasoup.types.Worker>} */
const workers = new Set();

export async function start() {
    logger.info("starting...");
    for (let i = 0; i < config.NUM_WORKERS; ++i) {
        await makeWorker();
    }
    logger.info(`initialized ${workers.size} mediasoup workers`);
    logger.info(
        `transport(RTC) layer at ${config.PUBLIC_IP}:${config.RTC_MIN_PORT}-${config.RTC_MAX_PORT}`
    );
}

export function close() {
    for (const worker of workers) {
        worker.appData.webRtcServer.close();
        worker.close();
    }
    workers.clear();
}

async function makeWorker() {
    const worker = await mediasoup.createWorker(config.rtc.workerSettings);
    worker.appData.webRtcServer = await worker.createWebRtcServer(config.rtc.rtcServerOptions);
    workers.add(worker);
    worker.once("died", (error) => {
        logger.error(`worker died: ${error.message} ${error.stack ?? ""}`);
        workers.delete(worker);
        /**
         * A new worker is made to replace the one that died.
         * TODO: We may want to limit the amount of times this happens in case deaths are unrecoverable.
         */
        makeWorker();
    });
}

/**
 * @returns {import("mediasoup").types.Worker}
 */
export async function getWorker() {
    const proms = [];
    let leastUsedWorker;
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
    logger.debug(`worker ${leastUsedWorker.pid} with ${lowestUsage} ru_maxrss was selected`);
    return leastUsedWorker;
}
