import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";

import { recording, dir, FFMPEG_LOGGING } from "#src/config.ts";
import { decrypt, sign } from "#src/core/services/auth.ts";
import { MediaCompiler } from "#src/recording/models/media_compiler.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA");
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
const CPU_LOAD_THRESHOLD = 0.8;
const REQUEST_TIMEOUT = 30_000;

type RoutingResponse = {
    destination: string;
};

class DiscardRecordingError extends Error {}

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

function makeJwt(key: string) {
    const nowSeconds = Date.now() / 1000;
    return sign(
        {
            exp: nowSeconds + 120,
            iat: nowSeconds
        },
        key
    );
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
}

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

/**
 * Service responsible for post-processing of media recordings.
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
    logger.info("Starting media service");
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
        logger.debug("checking for media processing");
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
            logger.error(`Error in media service check: ${error}`);
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
                const finalized = await processRecording(recordingEntry.name);
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

/**
 * TODO: when using ffmpeg for compilation, give lower priority to the process
 */
async function processRecording(folderName: string): Promise<boolean> {
    const recordingDir = path.join(dir.recordings, folderName);
    try {
        const metadataPath = path.join(recordingDir, recording.metadataFileName);
        let content: string;
        try {
            content = await fs.readFile(metadataPath, "utf-8");
        } catch (error) {
            throw new DiscardRecordingError(`Cannot read metadata: ${error}`);
        }
        let metadata: SealedMetaData;
        try {
            metadata = JSON.parse(decrypt(content));
        } catch (error) {
            throw new DiscardRecordingError(`Cannot parse metadata: ${error}`);
        }
        /**
         * TODO should add channelId to the metadata, if the channel is still alive, we skip it,
         * then we will combine all recordings of the same channel
         */
        if (!metadata.startedAt || !metadata.stoppedAt) {
            throw new DiscardRecordingError("No startedAt or stoppedAt found in metadata");
        }
        const expirationDate = metadata.stoppedAt + recording.fileTTL;
        if (expirationDate < Date.now()) {
            logger.debug(`Recording ${folderName} is older than ${recording.fileTTL}ms, removing`);
            throw new DiscardRecordingError("expired recording");
        }
        logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
        const compiler = new MediaCompiler({
            workingDir: recordingDir,
            startedAt: metadata.startedAt,
            stoppedAt: metadata.stoppedAt,
            timeStamps: metadata.timeStamps
        });
        const audioPath = await compiler.getAudio();
        const videoPath = metadata.video && (await compiler.getVideo());
        if (audioPath) {
            await uploadAudio({ filePath: audioPath, metadata, mainMedia: !videoPath });
        }
        if (videoPath) {
            await uploadVideo({ filePath: videoPath, metadata });
        }
        logger.info(`recording ${recording.metadataFileName} was succesfully processed`);
        await finalizeRecordingFolder(recordingDir, folderName);
        return true;
    } catch (error) {
        if (error instanceof DiscardRecordingError) {
            logger.error(`Discarding recording ${folderName}: ${error.message}`);
            await finalizeRecordingFolder(recordingDir, folderName);
            return true;
        }
        logger.error(`Failed to process recording ${folderName}, keeping for retry: ${error}`);
        return false;
    }
}

async function uploadAudio({
    filePath,
    metadata,
    mainMedia
}: {
    filePath: string;
    metadata: SealedMetaData;
    mainMedia: boolean;
}) {
    const fileStats = await fs.stat(filePath);
    const queryParams = ["start=" + metadata.startedAt, "end=" + metadata.stoppedAt];
    if (metadata.transcription) {
        queryParams.push("transcribe=True");
    }
    if (mainMedia) {
        queryParams.push("main_media=True");
    }
    const paramString = queryParams.length ? "?" + queryParams.join("&") : "";
    const response = await fetchWithTimeout(`${metadata.routingAddress}/audio${paramString}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${makeJwt(metadata.channelKey)}`,
            "Content-Type": `audio/${recording.audioExt}`,
            "Content-Length": fileStats.size.toString()
        },
        // FIXME remove linter error suppression
        // @ts-expect-error: Node fetch supports ReadStream
        // The reason is that the current tsconfig uses both ES2024 and DOM
        // because part of the SFU codebase runs on the client (client.ts)
        // this causes the linter to treat this fetch as a client fetch
        // it could probably fixed with some tsconfig compositing trickery
        // that takes client.ts, tests and shared files into account
        body: createReadStream(filePath),
        duplex: "half"
    });
    if (!response.ok) {
        throw new Error(
            `Failed to upload audio to ${metadata.routingAddress}: ${response.status} ${response.statusText}`
        );
    }
    return await response.text();
}

async function uploadVideo({ filePath, metadata }: { filePath: string; metadata: SealedMetaData }) {
    logger.debug(`Uploading files to ${metadata.routingAddress}`);
    const response = await fetchWithTimeout(`${metadata.routingAddress}/routing`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${makeJwt(metadata.channelKey)}`
        }
    });
    if (!response.ok) {
        throw new Error(
            `Failed to obtain routing from ${metadata.routingAddress}: ${response.status} ${response.statusText}`
        );
    }
    const jsonResponse = (await response.json()) as RoutingResponse;
    if (!jsonResponse.destination) {
        logger.warn(`No upload destination returned by ${metadata.routingAddress}/routing`);
        return;
    }
    const fileStats = await fs.stat(filePath);
    const uploadResponse = await fetchWithTimeout(jsonResponse.destination, {
        method: "POST",
        headers: {
            "Content-Type": "video/av1", // TODO should depend on config
            "Content-Length": fileStats.size.toString()
        },
        // @ts-expect-error: same as above
        body: createReadStream(filePath),
        duplex: "half"
    });
    if (!uploadResponse.ok) {
        throw new Error(
            `Failed to upload files to ${metadata.routingAddress}: ${uploadResponse.status} ${uploadResponse.statusText}`
        );
    }
}
