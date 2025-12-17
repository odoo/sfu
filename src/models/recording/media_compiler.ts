import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { type Metadata, TIME_TAG } from "#src/models/recording/recorder.ts";
import { recording } from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA_COMPILER");

export class MediaCompiler {
    private readonly _workingDir: string;
    private readonly _timeStamps: Metadata["timeStamps"];

    constructor(workingDir: string, timeStamps: Metadata["timeStamps"]) {
        this._workingDir = workingDir;
        this._timeStamps = timeStamps;
    }

    /**
     * Compiles the raw recording into compiled files.
     * @returns The paths to the compiled files.
     */
    /**
     * Compiles the raw recording into a single file.
     * @param startedAt - The start timestamp of the recording.
     * @param stoppedAt - The stop timestamp of the recording.
     * @returns The path to the compiled file, or undefined if no audio files were found.
     */
    async compile(startedAt: number, stoppedAt: number): Promise<string | undefined> {
        logger.debug(`Working dir: ${this._workingDir}`);

        const audioFiles = new Map<string, number>();
        for (const timestamp of this._timeStamps) {
            if (timestamp.tag === TIME_TAG.FILE_STATE_CHANGE) {
                if (timestamp.info && timestamp.info.type === "audio" && timestamp.info.active) {
                    if (!audioFiles.has(timestamp.info.filename)) {
                        logger.debug(`Found audio file ${timestamp.info.filename}`);
                        audioFiles.set(timestamp.info.filename, timestamp.timestamp);
                    }
                }
            }
        }
        /**
         * TODO Do the same for video, but needs cameraFiles and screenFiles,
         * then make a much more complex logic on what to display.
         * Will probably need Odoo to provide labels for rtc sessions
         * so that these labels can be passed to timestamp info.
         * The recorder may have to update _getRecordingStates() based on if there is
         * at least one screen (because if there is a screen that's what we show,
         * and maybe just the video of the sharer if there is)
         * then iterate recording tasks to update them with the new parameters.
         */
        return this._compileAudio(audioFiles, startedAt, stoppedAt);
    }

    private async _compileAudio(
        files: Map<string, number>,
        startedAt: number,
        stoppedAt: number
    ): Promise<string | undefined> {
        const relevantFiles: { path: string; offset: number }[] = [];
        for (const [filename, startTime] of files) {
            if (startTime < stoppedAt) {
                relevantFiles.push({
                    path: path.join(this._workingDir, "audio", filename),
                    offset: startTime - startedAt
                });
            }
        }

        if (relevantFiles.length === 0) {
            logger.warn("No audio files found");
            return;
        }

        const outputName = path.join(this._workingDir, `recording_${startedAt}.ogg`);
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return outputName;
        } catch {
            // File does not exist, continue to compilation
        }

        const inputs: string[] = [];
        const filterComplex: string[] = [];
        const duration = (stoppedAt - startedAt) / 1000;

        relevantFiles.forEach((file, index) => {
            const delay = file.offset > 0 ? file.offset : 0;
            // If the file starts before the segment, we skip the beginning
            if (file.offset < 0) {
                inputs.push("-ss", `${Math.abs(file.offset / 1000).toFixed(3)}`);
            }
            inputs.push("-i", file.path);
            filterComplex.push(`[${index}:a]adelay=${delay}|${delay}[a${index}]`);
        });

        const mixInputs = relevantFiles.map((_, i) => `[a${i}]`).join("");
        // dropout_transition=0 avoids volume dips when a stream ends
        filterComplex.push(
            `${mixInputs}amix=inputs=${relevantFiles.length}:dropout_transition=0,volume=${relevantFiles.length}[out]`
        );

        const args = [
            "-y",
            ...inputs,
            "-filter_complex",
            filterComplex.join(";"),
            "-map",
            "[out]",
            "-t",
            duration.toFixed(3),
            "-c:a",
            recording.audioCodec,
            "-b:a",
            recording.audioBitRate,
            outputName
        ];

        logger.debug(`Running FFMPEG: ffmpeg ${args.join(" ")}`);

        return new Promise<string>((resolve, reject) => {
            const proc = spawn("ffmpeg", args);

            proc.stderr.on("data", (data) => {
                // logger.debug(`FFMPEG stderr: ${data}`); // Too noisy
            });

            proc.on("close", (code) => {
                if (code === 0) {
                    logger.info(`Compiled ${outputName}`);
                    resolve(outputName);
                } else {
                    logger.error(`FFMPEG failed with code ${code}`);
                    reject(new Error(`FFMPEG exited with code ${code}`));
                }
            });

            proc.on("error", (err) => {
                logger.error(`Failed to spawn FFMPEG: ${err}`);
                reject(err);
            });
        });
    }
}
