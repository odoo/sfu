import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { recording, RECORDING_PATH } from "#src/config.ts";
import { decrypt, sign } from "#src/services/auth.ts";
import { MediaCompiler } from "#src/models/recording/media_compiler.ts";
import type { SealedMetaData } from "#src/models/recording/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA");
const CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const CPU_LOAD_THRESHOLD = 0.8;

type RoutingInformation = {
    recording?: string;
    transcription?: string;
};

let interval: NodeJS.Timeout | undefined;

/**
 * Service responsible for post-processing of media recordings.
 *
 * This service runs periodically to check for completed recordings in the recording directory.
 * Manages the lifecycle of recording files:
 * - Monitoring CPU load to schedule processing during idle times.
 * - Checking for expired recordings and cleaning them up based on TTL.
 * - Compiling raw media streams into consumable formats (e.g., merging audio/video, generating transcriptions).
 * - Uploading processed media and transcriptions to the routing address specified in the metadata.
 *
 * Note: This service is currently part of the main process but is designed to potentially
 * run as a separate worker or service in the future to offload heavy media processing.
 */
export async function start(): Promise<void> {
    if (!recording.enabled) {
        logger.info("Recording is disabled, media service will not start");
        return;
    }
    logger.info("Starting media service");
    checkSystemAndProcess();
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
    const dir = path.join(RECORDING_PATH, folderName);
    const metadataPath = path.join(dir, "metadata.json");
    try {
        const content = await fs.readFile(metadataPath, "utf-8");
        const metadata: SealedMetaData = JSON.parse(decrypt(content));
        const expirationDate = (metadata.sealedAt || 0) + recording.fileTTL;
        if (expirationDate < Date.now()) {
            logger.debug(`Recording ${folderName} is older than ${recording.fileTTL}ms, removing`);
            throw new Error("expired recording");
        }
        logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
        logger.debug(`Expected to be delivered at ${metadata.routingAddress}`);
        const comp = new MediaCompiler(dir, metadata.timeStamps);
        const file = await comp.compile(metadata.startedAt || 0, metadata.stoppedAt || 0);

        if (file) {
            await uploadFiles(file, {
                metadata,
                video: Boolean(metadata.video),
                transcription: Boolean(metadata.transcription)
            });
        }
    } catch (error) {
        logger.error(`Failed to process recording ${folderName}: ${error}`);
        fs.rm(dir, { recursive: true });
    }
}

async function uploadFiles(
    file: string,
    {
        metadata,
        video,
        transcription
    }: {
        metadata: SealedMetaData;
        video?: boolean;
        transcription?: boolean;
    }
) {
    logger.debug(`Uploading files to ${metadata.routingAddress}`);
    try {
        const nowSeconds = Date.now() / 1000;
        const jwt = sign(
            {
                aud: metadata.routingAddress,
                exp: nowSeconds + 120,
                iat: nowSeconds
            },
            metadata.channelKey
        );
        const response = await fetch(metadata.routingAddress, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${jwt}`
            }
        });
        if (!response.ok) {
            throw new Error(
                `Failed to obtain routing from ${metadata.routingAddress}: ${response.statusText}`
            );
        }
        const routing = (await response.json()) as RoutingInformation;
        logger.debug(
            `Obtained routing from ${metadata.routingAddress}: ${JSON.stringify(routing)}`
        );
        // TODO implement upload
    } catch (e) {
        logger.error(`Failed to obtain routing from ${metadata.routingAddress}: ${e}`);
    }
}
