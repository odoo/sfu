import fs from "node:fs";
import { spawn } from "node:child_process";
import { access, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import { TIME_TAG, type TimeStampData } from "#src/recording/models/recorder.ts";
import { recording, LOG_LEVEL } from "#src/config.ts";
import { Logger, LogLevel } from "#src/utils/utils.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import type { SessionId } from "#src/core/models/session.ts";

const logger = new Logger("MEDIA_COMPILER");
const isDebug = LOG_LEVEL === LogLevel.DEBUG;

/**
 * Minimum time gap (ms) between segment boundaries. Changes occurring within
 * this threshold are merged to avoid excessive segment fragmentation.
 */
const SEGMENT_COALESCE_THRESHOLD = 500;

type VideoFileInfo = {
    filename: string;
    type: STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN;
    sessionId: SessionId;
    /** Timestamp when this file first became active (for offset calculation) */
    fileStartTime: number;
};

type VideoSegment = {
    startTime: number;
    endTime: number;
    /** Map from filename to file info */
    files: Map<string, VideoFileInfo>;
};

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

    //////////////////////////////////
    //////////// AUDIO ///////////////
    //////////////////////////////////

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
            let logStream: fs.WriteStream | undefined;

            if (isDebug) {
                logStream = fs.createWriteStream(`${outputName}.log`);
                proc.stderr?.pipe(logStream, { end: false });
                proc.stdout?.pipe(logStream, { end: false });
            }

            proc.on("close", (code) => {
                logStream?.end();
                if (code === 0) {
                    logger.info(`Compiled ${outputName}`);
                    resolve(outputName);
                } else {
                    logger.error(`FFMPEG failed with code ${code}`);
                    reject(new Error(`FFMPEG exited with code ${code}`));
                }
            });

            proc.on("error", (err) => {
                logStream?.end();
                logger.error(`Failed to spawn FFMPEG: ${err}`);
                reject(err);
            });
        });
    }

    //////////////////////////////////
    //////////// VIDEO ///////////////
    //////////////////////////////////

    private async _getVideoFile(srtFile?: string): Promise<string | undefined> {
        if (!this._videoPath) {
            this._videoPath = await this._compileVideo(srtFile);
        }
        return this._videoPath;
    }

    private async _compileVideo(srt?: string): Promise<string | undefined> {
        const segments = this._buildVideoSegments();

        if (segments.length === 0) {
            logger.info("No video segments found, falling back to audio-only");
            return this._compileAudio();
        }

        const outputName = path.join(this._workingDir, `recording_${this._startedAt}.mp4`);
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return outputName;
        } catch {
            // File does not exist, continue
        }

        const audioPath = await this._compileAudio();
        const segmentFiles: string[] = [];

        for (let i = 0; i < segments.length; i++) {
            const segmentPath = await this._compileSegment(segments[i], i);
            if (segmentPath) {
                segmentFiles.push(segmentPath);
            }
        }

        if (segmentFiles.length === 0) {
            logger.warn("No video segments were successfully compiled");
            return audioPath;
        }

        return this._concatenateSegments(segmentFiles, audioPath, srt, outputName);
    }

    /**
     * Builds video segments from timestamps. Each segment represents a stable
     * configuration of active video files. Changes within SEGMENT_COALESCE_THRESHOLD
     * are merged to reduce fragmentation.
     */
    private _buildVideoSegments(): VideoSegment[] {
        const segments: VideoSegment[] = [];
        const activeFiles = new Map<string, VideoFileInfo>();
        const fileFirstActive = new Map<string, number>();

        const videoTimestamps = this._timeStamps.filter(
            (ts) =>
                ts.tag === TIME_TAG.FILE_STATE_CHANGE &&
                ts.info &&
                (ts.info.type === STREAM_TYPE.CAMERA || ts.info.type === STREAM_TYPE.SCREEN)
        );

        if (videoTimestamps.length === 0) {
            return [];
        }

        let currentSegmentStart = this._startedAt;
        let lastChangeTime = this._startedAt;

        const flushSegment = (endTime: number) => {
            if (activeFiles.size > 0 && endTime > currentSegmentStart) {
                segments.push({
                    startTime: currentSegmentStart,
                    endTime,
                    files: new Map(activeFiles)
                });
            }
            currentSegmentStart = endTime;
        };

        for (const ts of videoTimestamps) {
            const { filename, type, sessionId, active } = ts.info!;
            const timestamp = ts.timestamp;

            // Skip if timestamp is after recording stopped
            if (timestamp >= this._stoppedAt) {
                continue;
            }

            /**
             * Coalesceing: if change is far enough from last, flush the current segment.
             * This is to prevent creating too many small segments.
             */
            if (timestamp - lastChangeTime > SEGMENT_COALESCE_THRESHOLD && activeFiles.size > 0) {
                flushSegment(timestamp);
            }

            if (active) {
                if (!fileFirstActive.has(filename)) {
                    fileFirstActive.set(filename, timestamp);
                }
                activeFiles.set(filename, {
                    filename,
                    type: type as STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN,
                    sessionId,
                    fileStartTime: fileFirstActive.get(filename)!
                });
            } else {
                activeFiles.delete(filename);
            }

            lastChangeTime = timestamp;
        }

        flushSegment(this._stoppedAt);
        return segments;
    }

    /**
     * Compiles a single video segment using FFmpeg.
     * Shows ALL active video files. Layout rules:
     * - Screen + cameras: screen takes main area, cameras in bottom bar
     * - Only cameras: dynamic grid layout
     * - Only screen: fullscreen
     */
    private async _compileSegment(
        segment: VideoSegment,
        index: number
    ): Promise<string | undefined> {
        const files = Array.from(segment.files.values());
        if (files.length === 0) {
            return undefined;
        }

        const outputPath = path.join(this._workingDir, `segment_${index}.mp4`);
        const duration = (segment.endTime - segment.startTime) / 1000;

        const screenFiles = files.filter((f) => f.type === STREAM_TYPE.SCREEN);
        const cameraFiles = files.filter((f) => f.type === STREAM_TYPE.CAMERA);

        const inputs: string[] = [];
        const filterComplex: string[] = [];

        for (const file of screenFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            const filePath = path.join(this._workingDir, "screen", file.filename);
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push("-i", filePath);
        }

        for (const file of cameraFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            const filePath = path.join(this._workingDir, "camera", file.filename);
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push("-i", filePath);
        }

        let outputLabel: string;

        if (screenFiles.length > 0 && cameraFiles.length > 0) {
            // Screen + cameras: screen takes main area, cameras in bottom bar
            // Layout: 1280x720 total - screen: 1280x580 (top), cameras: 1280x140 (bottom bar)
            const screenHeight = 580;
            const barHeight = 140;
            const camWidth = Math.floor(1280 / cameraFiles.length);

            filterComplex.push(
                `[0:v]scale=1280:${screenHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=1280:${screenHeight}:(ow-iw)/2:(oh-ih)/2[screen]`
            );

            for (let i = 0; i < cameraFiles.length; i++) {
                const streamIdx = screenFiles.length + i;
                filterComplex.push(
                    `[${streamIdx}:v]scale=${camWidth}:${barHeight}:force_original_aspect_ratio=decrease,` +
                        `pad=${camWidth}:${barHeight}:(ow-iw)/2:(oh-ih)/2[cam${i}]`
                );
            }

            if (cameraFiles.length === 1) {
                filterComplex.push(`[cam0]pad=1280:${barHeight}:(1280-iw)/2:0[cambar]`);
            } else {
                const camLabels = cameraFiles.map((_, i) => `[cam${i}]`).join("");
                filterComplex.push(`${camLabels}hstack=inputs=${cameraFiles.length}[cambar]`);
            }

            filterComplex.push(`[screen][cambar]vstack=inputs=2[vout]`);
            outputLabel = "[vout]";
        } else if (screenFiles.length > 0) {
            // Only screen(s) - fullscreen (use first if multiple)
            filterComplex.push(
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                    `pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
            );
            outputLabel = "[vout]";
        } else if (cameraFiles.length > 0) {
            // Only cameras - dynamic grid layout
            outputLabel = this._buildCameraGrid(cameraFiles.length, filterComplex);
        } else {
            return undefined;
        }

        const args = [
            "-y",
            ...inputs,
            "-filter_complex",
            filterComplex.join(";"),
            "-map",
            outputLabel,
            "-t",
            duration.toFixed(3),
            "-c:v",
            recording.videoCodec,
            "-preset",
            recording.videoPreset,
            outputPath
        ];

        logger.debug(`Compiling segment ${index}: ffmpeg ${args.join(" ")}`);

        return new Promise<string>((resolve, reject) => {
            const proc = spawn("ffmpeg", args);
            let logStream: fs.WriteStream | undefined;

            if (isDebug) {
                logStream = fs.createWriteStream(`${outputPath}.log`);
                proc.stderr?.pipe(logStream, { end: false });
                proc.stdout?.pipe(logStream, { end: false });
            }

            proc.on("close", (code) => {
                logStream?.end();
                if (code === 0) {
                    resolve(outputPath);
                } else {
                    logger.error(`Segment ${index} compilation failed with code ${code}`);
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            proc.on("error", (err) => {
                logStream?.end();
                logger.error(`Failed to spawn FFmpeg for segment ${index}: ${err}`);
                reject(err);
            });
        });
    }

    /**
     * Builds a dynamic grid layout filter for cameras.
     * Arranges cameras in rows, with the number of columns based on camera count.
     */
    private _buildCameraGrid(cameraCount: number, filterComplex: string[]): string {
        if (cameraCount === 1) {
            filterComplex.push(
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                    `pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
            );
            return "[vout]";
        }

        const cols = Math.ceil(Math.sqrt(cameraCount));
        const rows = Math.ceil(cameraCount / cols);
        const cellWidth = Math.floor(1280 / cols);
        const cellHeight = Math.floor(720 / rows);

        for (let i = 0; i < cameraCount; i++) {
            filterComplex.push(
                `[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2[v${i}]`
            );
        }

        const rowLabels: string[] = [];
        for (let row = 0; row < rows; row++) {
            const startIdx = row * cols;
            const endIdx = Math.min(startIdx + cols, cameraCount);
            const rowCameras = endIdx - startIdx;

            if (rowCameras === 1) {
                filterComplex.push(`[v${startIdx}]pad=1280:${cellHeight}:(1280-iw)/2:0[row${row}]`);
            } else {
                const labels = Array.from(
                    { length: rowCameras },
                    (_, i) => `[v${startIdx + i}]`
                ).join("");
                filterComplex.push(`${labels}hstack=inputs=${rowCameras}[row${row}]`);
            }
            rowLabels.push(`[row${row}]`);
        }

        if (rows === 1) {
            return rowLabels[0].replace("[", "").replace("]", "") === "row0"
                ? "[row0]"
                : rowLabels[0];
        }
        filterComplex.push(`${rowLabels.join("")}vstack=inputs=${rows}[vout]`);
        return "[vout]";
    }

    /**
     * Concatenates all video segments with the audio track and optional subtitles.
     */
    private async _concatenateSegments(
        segmentFiles: string[],
        audioPath: string | undefined,
        srt: string | undefined,
        outputPath: string
    ): Promise<string> {
        const concatListPath = path.join(this._workingDir, "concat_list.txt");
        const concatContent = segmentFiles.map((f) => `file '${f}'`).join("\n");
        await writeFile(concatListPath, concatContent);

        let srtPath: string | undefined;
        if (srt) {
            srtPath = path.join(this._workingDir, "subtitles.srt");
            await writeFile(srtPath, srt);
        }

        const inputs: string[] = ["-f", "concat", "-safe", "0", "-i", concatListPath];

        if (audioPath) {
            inputs.push("-i", audioPath);
        }

        const filterComplex: string[] = [];
        let mapArgs: string[];

        if (srtPath) {
            inputs.push("-i", srtPath);
            const subtitleIdx = audioPath ? 2 : 1;
            filterComplex.push(`[0:v][${subtitleIdx}:s]overlay[vout]`);
            mapArgs = ["-map", "[vout]"];
        } else {
            mapArgs = ["-map", "0:v"];
        }

        if (audioPath) {
            mapArgs.push("-map", "1:a");
        }

        const args = [
            "-y",
            ...inputs,
            ...(filterComplex.length > 0 ? ["-filter_complex", filterComplex.join(";")] : []),
            ...mapArgs,
            "-c:v",
            recording.videoCodec,
            "-c:a",
            recording.audioCodec,
            "-preset",
            recording.videoPreset,
            outputPath
        ];

        logger.debug(`Concatenating segments: ffmpeg ${args.join(" ")}`);

        return new Promise<string>((resolve, reject) => {
            const proc = spawn("ffmpeg", args);
            let logStream: fs.WriteStream | undefined;

            if (isDebug) {
                logStream = fs.createWriteStream(`${outputPath}.log`);
                proc.stderr?.pipe(logStream, { end: false });
                proc.stdout?.pipe(logStream, { end: false });
            }

            proc.on("close", async (code) => {
                logStream?.end();
                try {
                    await unlink(concatListPath);
                    if (srtPath) {
                        await unlink(srtPath);
                    }
                    for (const segmentFile of segmentFiles) {
                        await unlink(segmentFile);
                    }
                } catch {
                    logger.error("Failed to cleanup temp video compilation files");
                }

                if (code === 0) {
                    logger.info(`Compiled video: ${outputPath}`);
                    resolve(outputPath);
                } else {
                    logger.error(`Final concatenation failed with code ${code}`);
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            proc.on("error", (err) => {
                logStream?.end();
                logger.error(`Failed to spawn FFmpeg for concatenation: ${err}`);
                reject(err);
            });
        });
    }
}
