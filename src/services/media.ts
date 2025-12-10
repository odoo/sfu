import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RECORDING, RECORDING_PATH } from "#src/config.ts";
import type { Metadata } from "#src/models/recording/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA");
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const CPU_LOAD_THRESHOLD = 0.8;

let interval: NodeJS.Timeout | undefined;

export async function start(): Promise<void> {
    if (!RECORDING) {
        logger.info("Recording is disabled, media service will not start");
        return;
    }
    logger.info("Starting media service");
    void checkSystemAndProcess();
    // TODO maybe use fs.watch(dir)
    // may need local knowledge of which files are being processed
    // read folder at startup, then listen for change, build a queue of folders to process
    interval = setInterval(checkSystemAndProcess, CHECK_INTERVAL);
}

export function close() {
    if (interval) {
        clearInterval(interval);
        interval = undefined;
    }
}

async function checkSystemAndProcess() {
    try {
        if (!isCpuLoaded()) {
            await processRecordings();
        } else {
            logger.warn("CPU is too loaded, skipping recording processing");
        }
    } catch (error) {
        logger.error(`Error in media service check: ${error}`);
    }
}

function isCpuLoaded(): boolean {
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg()[0]; // 1 (last) minute load average
    const loadPercentage = loadAvg / cpus;
    logger.debug(
        `CPU Load: ${loadAvg.toFixed(2)} / ${cpus} (${(loadPercentage * 100).toFixed(1)}%)`
    );
    return loadPercentage > CPU_LOAD_THRESHOLD;
}

async function processRecordings() {
    logger.debug(`Checking recordings in ${RECORDING_PATH}`);
    try {
        const entries = await fs.readdir(RECORDING_PATH, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await processRecording(entry.name);
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug("Recording directory not found (no recordings yet)");
        } else {
            logger.error(`Failed to read recording directory: ${error}`);
        }
    }
}

/**
 * TODO: node:zlib
 * TODO: when using ffmpeg for compilation, give lower priority to the process
 */
async function processRecording(folderName: string) {
    const metadataPath = path.join(RECORDING_PATH, folderName, "metadata.json");
    try {
        const content = await fs.readFile(metadataPath, "utf-8");
        const metadata: Metadata = JSON.parse(content);
        logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
        logger.debug(`Expected to be delivered at ${metadata.routingAddress}`);
        for (const timestamp of metadata.timeStamps) {
            logger.debug(
                `Timestamp: ${timestamp.tag} at ${timestamp.timestamp} info: ${JSON.stringify(
                    timestamp.info
                )}`
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug(`No metadata.json found in ${folderName}, skipping`);
        } else {
            logger.error(`Failed to process recording ${folderName}: ${error}`);
        }
    }
}
