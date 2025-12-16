import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { type TimeStampData, TIME_TAG } from "#src/models/recording/recorder.ts";
import { recording } from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
type compiledFiles = {
    recordings: string[];
    transcriptions: string[];
};
type compilableSegment = {
    start: number;
    end: number;
    type: "transcription" | "recording";
};
const logger = new Logger("MEDIA_COMPILER");

// TODO When all the files are processed, delete (or move, or mark as processed) the folder
export class MediaCompiler {
    private readonly _workingDir: string;
    private readonly _timeStamps: TimeStampData[];
    constructor(workingDir: string, timeStamps: TimeStampData[]) {
        this._workingDir = workingDir;
        this._timeStamps = timeStamps;
    }
    /**
     * Compiles the raw recording into compiled files.
     * @returns The paths to the compiled files.
     */
    async compile(): Promise<compiledFiles> {
        logger.debug(`Working dir: ${this._workingDir}`);
        const transcriptionSegments: compilableSegment[] = [];
        /**
         * TODO: recordingSegments equivalent for TIME_TAG.RECORDING_STARTED and TIME_TAG.RECORDING_STOPPED
         * ffmpeg -i input.mp4 \
         *  -c:v libx264 -preset slow -crf 19 \
         *  -pix_fmt yuv420p \
         *  -c:a aac -b:a 128k \
         *  output.mp4
         */
        const files = new Map<string, number>();
        let currentStart = 0;

        for (const timestamp of this._timeStamps) {
            switch (timestamp.tag) {
                case TIME_TAG.TRANSCRIPTION_STARTED:
                    currentStart = timestamp.timestamp;
                    logger.debug(`Transcription started at ${timestamp.timestamp}`);
                    break;
                case TIME_TAG.TRANSCRIPTION_STOPPED:
                    if (currentStart) {
                        transcriptionSegments.push({
                            start: currentStart,
                            end: timestamp.timestamp,
                            type: "transcription"
                        });
                        currentStart = 0;
                    }
                    logger.debug(`Transcription stopped at ${timestamp.timestamp}`);
                    break;
                case TIME_TAG.FILE_STATE_CHANGE:
                    if (
                        timestamp.info &&
                        timestamp.info.type === "audio" &&
                        timestamp.info.active
                    ) {
                        if (!files.has(timestamp.info.filename)) {
                            logger.debug(`Found audio file ${timestamp.info.filename}`);
                            files.set(timestamp.info.filename, timestamp.timestamp);
                        }
                    }
                    break;
            }
        }

        // If a transcription started but didn't stop properly, assume it goes until the end
        if (currentStart) {
            transcriptionSegments.push({
                start: currentStart,
                end: this._timeStamps[this._timeStamps.length - 1].timestamp,
                type: "transcription"
            });
        }

        logger.info(`Found ${transcriptionSegments.length} transcription segments`);

        const transcriptions: string[] = [];
        for (const segment of transcriptionSegments) {
            logger.info(`Compiling segment ${segment.start} - ${segment.end}`);
            const processedFile = await this._compileSegment(segment, files);
            if (processedFile) {
                transcriptions.push(processedFile);
            }
        }
        return {
            recordings: [], // TODO to implement
            transcriptions
        };
    }

    private async _compileSegment(segment: compilableSegment, files: Map<string, number>) {
        const relevantFiles: { path: string; offset: number }[] = [];
        for (const [filename, startTime] of files) {
            if (startTime < segment.end) {
                // TODO we could have files that start before the segment, so we will have to skip the beginning of the file (negative offset)
                relevantFiles.push({
                    path: path.join(this._workingDir, "audio", filename),
                    offset: startTime - segment.start
                });
            }
        }

        if (relevantFiles.length === 0) {
            logger.warn("No audio files found for segment");
            return;
        }
        const outputName = path.join(this._workingDir, `transcription_${segment.start}.ogg`);
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return;
        } catch {
            // File does not exist, continue to compilation
        }

        const inputs: string[] = [];
        const filterComplex: string[] = [];
        const duration = (segment.end - segment.start) / 1000;

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
