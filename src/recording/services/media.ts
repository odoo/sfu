import fs from "node:fs/promises";
import { createReadStream } from "node:fs";

import path from "node:path";
import os from "node:os";

import { recording, RECORDING_PATH, KEEP_RECORDINGS, LOCAL_KEY } from "#src/config.ts";
import { decrypt, sign } from "#src/core/services/auth.ts";
import { MediaCompiler } from "#src/recording/models/media_compiler.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA");
const CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
const CPU_LOAD_THRESHOLD = 0.8;

type RoutingResponse = {
    destination: string;
};

/**
 * Nice-to-have feature, if the server provides a on-demand transcriptino
 */
const IMBED_TRANSCRIPTION = false;

let interval: NodeJS.Timeout | undefined;

/**
 * Promise that resolves when all queued processing is complete.
 * Tests can await this to avoid arbitrary setTimeout delays.
 */
export let processingQueue: Promise<void> = Promise.resolve();

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
    if (recording.enabled) {
        if (!LOCAL_KEY) {
            /**
             * If the local key is not set, it means that the encryption key
             * is auto generated, so any previously encrypted recording cannot
             * be decrypted.
             */
            logger.warn("LOCAL_KEY missing from the environment, removing old recordings");
            await fs.rm(RECORDING_PATH, { recursive: true, force: true });
        }
        await fs.mkdir(RECORDING_PATH, { recursive: true });
    } else {
        logger.info("Recording is disabled, media service will not start");
        return;
    }
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
    const work = (async () => {
        try {
            if (!isCpuLoaded()) {
                await processRecordings();
            } else {
                logger.warn("CPU is too loaded, skipping recording processing");
            }
        } catch (error) {
            logger.error(`Error in media service check: ${error}`);
        }
    })();
    processingQueue = processingQueue.then(() => work);
    await work;
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
    logger.info(`Checking recordings in ${RECORDING_PATH}`);
    try {
        const channelDirectories = await fs.readdir(RECORDING_PATH, { withFileTypes: true });
        const dir = channelDirectories[0];
        if (!dir) {
            return;
        }
        if (dir.isDirectory()) {
            const dirPath = path.join(RECORDING_PATH, dir.name);
            const subDirs = await fs.readdir(dirPath, { withFileTypes: true });
            for (const subdir of subDirs) {
                if (subdir.isDirectory()) {
                    /**
                     * TODO: processRecording should not handle the upload and transcription,
                     * it should return the path to the compiled media.
                     * we will then combine all subdirs ouputs per channel dir into one
                     * then, upload it to the destination (can get the destination of any metadata of that batch)
                     */
                    await processRecording(path.join(dir.name, subdir.name));
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
}

/**
 * TODO: node:zlib
 * TODO: when using ffmpeg for compilation, give lower priority to the process
 */
async function processRecording(folderName: string) {
    const dir = path.join(RECORDING_PATH, folderName);
    const metadataPath = path.join(dir, recording.metadataFileName);
    let filePath;
    try {
        const content = await fs.readFile(metadataPath, "utf-8");
        const metadata: SealedMetaData = JSON.parse(decrypt(content));
        /**
         * TODO should add channelId to the metadata, if the channel is still alive, we skip it,
         * then we will combine all recordings of the same channel
         */
        if (!metadata.startedAt || !metadata.stoppedAt) {
            throw new Error("No startedAt or stoppedAt found in metadata");
        }
        const expirationDate = metadata.stoppedAt + recording.fileTTL;
        if (expirationDate < Date.now()) {
            logger.debug(`Recording ${folderName} is older than ${recording.fileTTL}ms, removing`);
            throw new Error("expired recording");
        }
        logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
        let srt: string | undefined;
        const compiler = new MediaCompiler({
            workingDir: dir,
            startedAt: metadata.startedAt,
            stoppedAt: metadata.stoppedAt,
            timeStamps: metadata.timeStamps
        });
        if (metadata.transcription && IMBED_TRANSCRIPTION) {
            filePath = await compiler.compile({ video: false });
            if (filePath) {
                srt = await fetchTranscription(filePath, metadata);
            }
        }
        /**
         *  todo should maybe flag if we already did the transcription.
         *  or we expect the remote server to keep track of that
         */
        filePath = await compiler.compile({ video: metadata.video, srt });
        if (filePath) {
            await upload(filePath, metadata);
        }
        logger.info(`recording ${recording.metadataFileName} was succesfully processed`);
    } catch (error) {
        logger.error(`Failed to process recording ${folderName}: ${error}`);
    }
    if (!KEEP_RECORDINGS) {
        fs.rm(dir, { recursive: true });
    }
    return filePath;
}

async function fetchTranscription(filePath: string, metadata: SealedMetaData) {
    const fileStats = await fs.stat(filePath);
    const response = await fetch(`${metadata.routingAddress}/transcription`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${makeJwt(metadata.channelKey)}`,
            "Content-Type": "audio/mpeg",
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
        logger.warn(`Failed to obtain transcription for recording`);
        return;
    }
    return await response.text();
}

async function upload(filePath: string, metadata: SealedMetaData) {
    logger.debug(`Uploading files to ${metadata.routingAddress}`);
    try {
        const response = await fetch(`${metadata.routingAddress}/routing`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${makeJwt(metadata.channelKey)}`
            }
        });
        if (!response.ok) {
            throw new Error(
                `Failed to obtain routing from ${metadata.routingAddress}: ${response.statusText}`
            );
        }
        const jsonResponse = (await response.json()) as RoutingResponse;
        if (jsonResponse.destination) {
            const fileStats = await fs.stat(filePath);
            const response = await fetch(jsonResponse.destination, {
                method: "POST",
                headers: {
                    "Content-Type": "video/av1", // TODO should depend on config
                    "Content-Length": fileStats.size.toString()
                },
                // @ts-expect-error: same as above
                body: createReadStream(filePath),
                duplex: "half"
            });
            if (!response.ok) {
                throw new Error(
                    `Failed to upload files to ${metadata.routingAddress}: ${response.statusText}`
                );
            }
        }
    } catch (e) {
        logger.error(`Failed to upload files to ${metadata.routingAddress}: ${e}`);
    }
}
