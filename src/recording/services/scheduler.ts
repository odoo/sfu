import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { recording, dir, FFMPEG_LOGGING } from "#src/config.ts";
import { MediaUploader } from "#src/recording/models/media_uploader.ts";
import { RecordingProcessor } from "#src/recording/models/recording_processor.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("SCHEDULER");
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
const CPU_LOAD_THRESHOLD = 0.8;
const REQUEST_TIMEOUT = 30_000;

let interval: NodeJS.Timeout | undefined;

/**
 * Promise that resolves when all queued processing is complete.
 * Tests can await this to avoid arbitrary setTimeout delays.
 */
let processingQueue: Promise<void> = Promise.resolve();

export const __testing__ = {
    async oneProcessingBatch() {
        await processingQueue;
        return;
    }
};

async function finalizeRecordingFolder(recordingDir: string, folderName: string) {
    try {
        if (FFMPEG_LOGGING) {
            await fs.rename(recordingDir, path.join(dir.debug, folderName));
        } else {
            await fs.rm(recordingDir, { recursive: true });
        }
    } catch (error) {
        logger.error(`Failed to cleanup recording folder ${folderName}: ${error}`);
    }
}

const mediaUploader = new MediaUploader({ requestTimeoutMs: REQUEST_TIMEOUT });
const recordingProcessor = new RecordingProcessor({
    uploader: mediaUploader,
    finalizeRecordingFolder
});

/**
 * Service responsible for scheduling the post-processing of media recordings.
 *
 * This service runs periodically to check for completed
 * recordings in the recording directory and manage the lifecycle
 * of recording files:
 * - Monitoring CPU load to schedule processing during idle times.
 * - Checking for expired recordings and cleaning them up based on TTL.
 * - Compiling raw media streams into consumable formats
 *   (e.g., merging audio/video, generating transcriptions).
 * - Uploading processed media and transcriptions to the
 *   routing address specified in the metadata.
 *
 * Note: This service is currently part of the main process but is
 * designed to potentially run as a separate worker or service in the
 * future to offload heavy media processing.
 * The conversion to separate worker thread should be fairly
 * straightforward as there is no shared memory (although some
 * initialization data should be provided like the auth keys)
 */
export async function start(): Promise<void> {
    logger.info("Starting scheduler service");
    await checkSystemAndProcess();
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
    processingQueue = processingQueue.then(async () => {
        logger.debug("checking scheduled recording processing");
        try {
            if (isCpuLoaded()) {
                logger.warn("CPU is too loaded, skipping recording processing");
                return;
            }
            // Loop until no recordings remain or CPU becomes too loaded.
            let didWork = true;
            while (didWork) {
                didWork = await processRecordings();
                if (!didWork) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, recording.processingCooldown));
                if (isCpuLoaded()) {
                    logger.warn("CPU is too loaded, skipping recording processing");
                    return;
                }
            }
        } catch (error) {
            logger.error(`Error in scheduler service check: ${error}`);
        }
    });
    await processingQueue;
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

/**
 * @returns `true` if a recording directory was finalized, `false` otherwise.
 */
async function processRecordings(): Promise<boolean> {
    logger.verbose(`Checking recordings in ${dir.recordings}`);
    try {
        const recordingDirectories = await fs.readdir(dir.recordings, { withFileTypes: true });
        for (const recordingEntry of recordingDirectories) {
            if (recordingEntry.isDirectory()) {
                const finalized = await recordingProcessor.process(recordingEntry.name);
                if (finalized) {
                    return true;
                }
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug("Recording directory not found (no recordings yet)");
        } else {
            logger.error(`Failed to read recording directory: ${error}`);
        }
    }
    return false;
}
