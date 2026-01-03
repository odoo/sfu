import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { TIME_TAG, type TimeStampData } from "#src/recording/models/recorder.ts";
import { recording } from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";

const logger = new Logger("MEDIA_COMPILER");

export class MediaCompiler {
    private readonly _workingDir: string;
    private readonly _startedAt: number;
    private readonly _stoppedAt: number;
    private readonly _timeStamps: TimeStampData[];
    private _audioPath?: string;

    constructor({
        workingDir,
        startedAt,
        stoppedAt,
        timeStamps
    }: {
        workingDir: string;
        startedAt: number;
        stoppedAt: number;
        timeStamps: TimeStampData[];
    }) {
        this._workingDir = workingDir;
        this._startedAt = startedAt;
        this._stoppedAt = stoppedAt;
        this._timeStamps = timeStamps;
    }

    /**
     * Compiles the raw recording into a single file.
     * @returns The full path to the compiled file, or undefined if no audio files were found.
     */
    async compileAudio(): Promise<string | undefined> {
        logger.debug(`Working dir: ${this._workingDir}`);

        const audioFiles = new Map<string, number>();
        for (const timestamp of this._timeStamps) {
            if (timestamp.tag === TIME_TAG.FILE_STATE_CHANGE) {
                if (
                    timestamp.info &&
                    timestamp.info.type === STREAM_TYPE.AUDIO &&
                    timestamp.info.active
                ) {
                    if (!audioFiles.has(timestamp.info.filename)) {
                        logger.debug(`Found audio file ${timestamp.info.filename}`);
                        audioFiles.set(timestamp.info.filename, timestamp.timestamp);
                    }
                }
            }
        }
        /**
         * TODO in the case of videoFiles, we cannot just take active and add the file,
         * because when they are active=false (and that state can alternate many times),
         * over the course of the recording) we need to compile a new segment without
         * them (otherwise we will show a black screen on the final recording).
         */
        // If no camera and screen stream, it's a pure audio file.
        this._audioPath = await this._compile(audioFiles);
        return this._audioPath;
    }

    async compileVideo(srtFile?: string): Promise<string | undefined> {
        // if no video, and no srtFile, no need to redo work, just return the audio file
        // should be checked in _compile()
        return this._audioPath || this.compileAudio();
    }

    // TODO should be refactored to take video files, and a srt file, and build a full video file, with subtitles.
    private async _compile(audioFiles: Map<string, number>): Promise<string | undefined> {
        const relevantFiles: { path: string; offset: number }[] = [];
        for (const [filename, startTime] of audioFiles) {
            if (startTime < this._stoppedAt) {
                relevantFiles.push({
                    path: path.join(this._workingDir, "audio", filename),
                    offset: startTime - this._startedAt
                });
            }
        }

        if (relevantFiles.length === 0) {
            logger.warn("No audio files found");
            return;
        }

        const outputName = path.join(this._workingDir, `recording_${this._startedAt}.ogg`);
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return outputName;
        } catch {
            // File does not exist, continue to compilation
        }

        const inputs: string[] = [];
        const filterComplex: string[] = [];
        const duration = (this._stoppedAt - this._startedAt) / 1000;

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
