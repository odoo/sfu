import fs from "node:fs/promises";
import path from "node:path";

import * as config from "#src/config.ts";
import { decrypt } from "#src/core/services/auth.ts";
import { MediaCompiler } from "#src/recording/models/media_compiler.ts";
import { type SealedMetaData } from "#src/recording/models/recorder.ts";
import { MediaUploader } from "#src/recording/models/media_uploader.ts";
import { Logger } from "#src/utils/utils.ts";

class DiscardRecordingError extends Error {}

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
     * @returns `true` if the recording was finalized (saved or discarded), `false` if it should be retried.
     */
    async process(folderName: string, processMedia = true): Promise<boolean> {
        const recordingDirectory = path.join(config.dir.recordings, folderName);
        try {
            const metadata = await this._readMetadata(recordingDirectory, folderName);
            logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
            if (!processMedia) {
                return false;
            }
            const compiler = new MediaCompiler({
                workingDir: recordingDirectory,
                startedAt: metadata.startedAt,
                stoppedAt: metadata.stoppedAt,
                timeStamps: metadata.timeStamps
            });
            if (metadata.audio || metadata.transcription) {
                const audioPath = await compiler.getAudio();
                if (metadata.transcription && audioPath) {
                    await this._uploader.transcribe({ filePath: audioPath, metadata });
                }
                if (metadata.audio && audioPath && !metadata.video) {
                    await this._uploader.uploadMedia({ filePath: audioPath, metadata });
                }
            }
            if (metadata.video) {
                const videoPath = await compiler.getVideo();
                if (videoPath) {
                    await this._uploader.uploadMedia({ filePath: videoPath, metadata });
                }
            }
        } catch (error) {
            if (!(error instanceof DiscardRecordingError)) {
                logger.error(
                    `Failed to process recording ${folderName}, keeping for retry: ${error}`
                );
                return false;
            }
            logger.error(`Discarding recording ${folderName}: ${error.message}`);
        }
        try {
            await this._finalizeRecordingFolder(recordingDirectory, folderName);
            logger.info(`recording ${folderName} was successfully finalized`);
            return true;
        } catch (error) {
            logger.error(`Failed to finalize recording ${folderName}, keeping for retry: ${error}`);
            return false;
        }
    }

    private async _readMetadata(
        recordingDirectory: string,
        folderName: string
    ): Promise<SealedMetaData> {
        const metadataPath = path.join(recordingDirectory, config.recording.metadataFileName);
        let content: string;
        try {
            content = await fs.readFile(metadataPath, "utf-8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new DiscardRecordingError(`Cannot read metadata: ${error}`);
            }
            throw error;
        }
        let metadata: SealedMetaData;
        try {
            metadata = JSON.parse(decrypt(content)) as SealedMetaData;
        } catch (error) {
            throw new DiscardRecordingError(`Cannot parse metadata: ${error}`);
        }
        const expirationDate = metadata.stoppedAt + config.recording.fileTTL;
        if (expirationDate < Date.now()) {
            logger.debug(
                `Recording ${folderName} is older than ${config.recording.fileTTL}ms, removing`
            );
            throw new DiscardRecordingError("expired recording");
        }
        return metadata;
    }
}
