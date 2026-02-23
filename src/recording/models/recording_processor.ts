import fs from "node:fs/promises";
import path from "node:path";

import { recording, dir } from "#src/config.ts";
import { decrypt } from "#src/core/services/auth.ts";
import { MediaCompiler } from "#src/recording/models/media_compiler.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
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
    async process(folderName: string): Promise<boolean> {
        const recordingDirectory = path.join(dir.recordings, folderName);
        try {
            const metadata = await this._readMetadata(recordingDirectory, folderName);
            logger.debug(`Read metadata for recording ${folderName}: ${metadata.channelName}`);
            const compiler = new MediaCompiler({
                workingDir: recordingDirectory,
                startedAt: metadata.startedAt,
                stoppedAt: metadata.stoppedAt,
                timeStamps: metadata.timeStamps
            });
            const audioPath = await compiler.getAudio();
            const videoPath = metadata.video && (await compiler.getVideo());
            if (audioPath) {
                await this._uploader.uploadAudio({
                    filePath: audioPath,
                    metadata,
                    mainMedia: !videoPath
                });
            }
            if (videoPath) {
                await this._uploader.uploadVideo({ filePath: videoPath, metadata });
            }
            logger.info(`recording ${recording.metadataFileName} was succesfully processed`);
            await this._finalizeRecordingFolder(recordingDirectory, folderName);
            return true;
        } catch (error) {
            if (error instanceof DiscardRecordingError) {
                logger.error(`Discarding recording ${folderName}: ${error.message}`);
                await this._finalizeRecordingFolder(recordingDirectory, folderName);
                return true;
            }
            logger.error(`Failed to process recording ${folderName}, keeping for retry: ${error}`);
            return false;
        }
    }

    private async _readMetadata(
        recordingDirectory: string,
        folderName: string
    ): Promise<SealedMetaData> {
        const metadataPath = path.join(recordingDirectory, recording.metadataFileName);
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
        if (!metadata.startedAt || !metadata.stoppedAt) {
            throw new DiscardRecordingError("No startedAt or stoppedAt found in metadata");
        }
        const expirationDate = metadata.stoppedAt + recording.fileTTL;
        if (expirationDate < Date.now()) {
            logger.debug(`Recording ${folderName} is older than ${recording.fileTTL}ms, removing`);
            throw new DiscardRecordingError("expired recording");
        }
        return metadata;
    }
}
