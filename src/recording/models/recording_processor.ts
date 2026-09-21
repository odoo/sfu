import fs from "node:fs/promises";
import path from "node:path";

import * as config from "#src/config.ts";
import { decrypt } from "#src/core/services/auth.ts";
import { MediaCompiler } from "#src/recording/models/media_compiler.ts";
import { type SealedMetaData } from "#src/recording/models/recorder.ts";
import { MediaUploader } from "#src/recording/models/media_uploader.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("RECORDING_PROCESSOR");

export class RecordingProcessor {
    private readonly _uploader: MediaUploader;
    private readonly _finalizeRecordingFolder: (
        recordingDirectory: string,
        folderName: string
    ) => Promise<void>;

    constructor({
        uploader,
        finalizeRecordingFolder
    }: {
        uploader: MediaUploader;
        finalizeRecordingFolder: (recordingDirectory: string, folderName: string) => Promise<void>;
    }) {
        this._uploader = uploader;
        this._finalizeRecordingFolder = finalizeRecordingFolder;
    }

    /**
     * Process a queued recording once and discard its files on failure.
     *
     * @returns `true` if the directory was removed or archived, `false` if processing
     * is deferred by CPU load or directory cleanup failed.
     */
    async process(folderName: string, processMedia = true): Promise<boolean> {
        const recordingDirectory = path.join(config.dir.recordings, folderName);
        const metadataPath = path.join(recordingDirectory, config.recording.metadataFileName);
        try {
            const metadata = await this._readMetadata(metadataPath);
            logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
            if (!processMedia) {
                return false;
            }
            // Consume the queued metadata so cleanup failure or restart cannot replay delivery.
            await fs.rename(metadataPath, `${metadataPath}.processing`);
            const compiler = new MediaCompiler({
                workingDir: recordingDirectory,
                startedAt: metadata.startedAt,
                stoppedAt: metadata.stoppedAt,
                timeStamps: metadata.timeStamps
            });
            const audioPath =
                metadata.audio || metadata.transcription ? await compiler.getAudio() : undefined;
            if (metadata.transcription && audioPath) {
                await this._uploader.transcribe({ filePath: audioPath, metadata });
            }
            const videoPath = metadata.video ? await compiler.getVideo() : undefined;
            const mediaPath = videoPath ?? (metadata.audio ? audioPath : undefined);
            if (mediaPath) {
                await this._uploader.uploadMedia({
                    filePath: mediaPath,
                    metadata,
                    mimetype: videoPath
                        ? config.recording.video.mimeType
                        : config.recording.audio.mimeType
                });
            }
            await this._finalizeRecordingFolder(recordingDirectory, folderName);
            if (mediaPath || (metadata.transcription && audioPath)) {
                logger.info(`recording ${folderName} was successfully finalized`);
            } else {
                logger.warn(
                    `recording ${folderName} finalized without delivering media or transcription`
                );
            }
            return true;
        } catch (error) {
            logger.error(`Discarding recording ${folderName}: ${error}`);
            try {
                await fs.rm(recordingDirectory, { recursive: true, force: true });
                return true;
            } catch (cleanupError) {
                logger.error(`Failed to discard recording ${folderName}: ${cleanupError}`);
                return false;
            }
        }
    }

    private async _readMetadata(metadataPath: string): Promise<SealedMetaData> {
        const content = await fs.readFile(metadataPath, "utf-8");
        const metadata = JSON.parse(decrypt(content)) as SealedMetaData;
        const expirationDate = metadata.stoppedAt + config.recording.fileTTL;
        if (expirationDate < Date.now()) {
            throw new Error("Expired recording");
        }
        return metadata;
    }
}
