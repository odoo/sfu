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
    private _videoPath?: string;

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
     * Returns the full path to the file
     */
    async compile({ video = false, srt }: { video?: boolean; srt?: string } = {}) {
        if (video) {
            return this._getVideoFile(srt);
        } else {
            return this._getAudioFile();
        }
    }

    /**
     * Compiles the raw recording into a single file.
     * @returns The full path to the compiled file, or undefined if no audio files were found.
     */
    private async _getAudioFile(): Promise<string | undefined> {
        if (!this._audioPath) {
            this._audioPath = await this._compileAudio();
        }
        return this._audioPath;
    }

    private async _getVideoFile(srtFile?: string): Promise<string | undefined> {
        if (!this._videoPath) {
            this._videoPath = await this._compileVideo(srtFile);
        }
        return this._videoPath;
    }

    private async _compileVideo(srtFile?: string): Promise<string | undefined> {
        /**
         * TODO: should be similar to _compileAudio, but with video files. But
         * in the case of videoFiles, we cannot just take active and add the file,
         * because when they are active=false (that state can alternate many times
         * over the course of the recording) we need to compile a new segment without
         * them (otherwise we will show a black screen on the final recording).
         * Example:
         * the timestamps could be like that:
         * [
         * { tag: FILE_STATE_CHANGE, info: { type: "camera", active: true, filename: "cam1.mp4" }, timestamp: 1000 },
         * { tag: FILE_STATE_CHANGE, info: { type: "camera", active: false, filename: "cam1.mp4" }, timestamp: 2000 },
         * { tag: FILE_STATE_CHANGE, info: { type: "camera", active: true, filename: "cam1.mp4" }, timestamp: 3000 },
         * ]
         * So while it's always the same file, that file isn't always active (for example between timestamp 2000 and 3000,
         * there is a blank screen). So at 2000 we need to compile a new segment without that file, and then compile the next
         * segment starting from 3000 with that file.
         *
         * There can be multiple files changing their states at any time, so we need to create distinct segments for each
         * configuration of active video files (because we cannot change the inputs of ffmpeg in the middle of a segment).
         *
         * So the idea is to build a list of segments, where each segment is a list of files that are active at that time.
         * And the offset of each file from the start of that segment (for example if a camera stream lasts for 4 segments)
         * it must appear in each of the 4 segments but at an offset to align the start of the segment with the part of the
         * file that is relevant to that segment (as described by the timestamp).
         *
         * My intuition is that the way to implement it is:
         * 1) to avoid changing segments too fast, if some streams start/stop at times close to each other (for example
         * if the camera of someone starts at 20001 and the camera of someone else starts at 20002, we should consider
         * them as the same segment, and not create a new segment for the second camera, we just do as if the first camera
         * started 2ms later than it really did), to something like 500ms or even 1s.
         * 2) We should probably iterate through the timestamps and build a representation of each segment (basically a map
         * of all their active files, and the offset of each file from the start of that segment). Then build form that.
         *
         * By design, each segment has a fixed amount of active file (since if it changes it means that it's the time for another segment)
         * so each segment have a deterministic and constant layout (for example 3 cameras => we should build a layout with ffmpeg that shows the 3)
         * or if it's a segment where there is just 1 screen, then it's the simplest case, the segment is just the screen.
         * Then if there is nothing, it's just audio and a black screen.
         *
         * Then once each segment is built, we can concatenate them all with ffmpeg again to build the final file.
         */
        // temporarily just outputs the audio
        return this._compileAudio();
    }

    // TODO should be refactored to take video files, and a srt file, and build a full video file, with subtitles.
    private async _compileAudio(): Promise<string | undefined> {
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
