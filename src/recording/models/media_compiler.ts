import fs from "node:fs";
import { spawn } from "node:child_process";
import { access, rename, writeFile, unlink, rm } from "node:fs/promises";
import path from "node:path";

import { TIME_TAG, type TimeStampData } from "#src/recording/models/recorder.ts";
import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";

const logger = new Logger("MEDIA_COMPILER");
const FILENAME_PREFIX = "recording_";
const COMPILATION_TIMEOUT = config.recording.maxDuration * 2;
const FFPROBE_TIMEOUT = 30_000;
const INPUT_RECOVERY_OPTIONS = ["-fflags", "+discardcorrupt"];

async function runFfmpeg(args: string[], outputPath: string, signal: AbortSignal): Promise<string> {
    const extension = path.extname(outputPath);
    const partialPath = path.join(
        path.dirname(outputPath),
        `${path.basename(outputPath, extension)}.partial${extension}`
    );
    const commandArgs = ["-y", ...args, partialPath];
    logger.debug(`Running FFmpeg: ffmpeg ${commandArgs.join(" ")}`);
    try {
        await new Promise<void>((resolve, reject) => {
            const proc = spawn("ffmpeg", commandArgs, {
                stdio: config.FFMPEG_LOGGING ? ["ignore", "pipe", "pipe"] : "ignore",
                signal,
                killSignal: "SIGKILL"
            });
            const logStream = config.FFMPEG_LOGGING
                ? fs.createWriteStream(`${outputPath}.log`)
                : undefined;
            if (logStream) {
                logStream.on("error", (error) => {
                    logger.error(`FFmpeg log failure: ${error}`);
                    proc.stderr?.unpipe(logStream);
                    proc.stdout?.unpipe(logStream);
                    proc.stderr?.resume();
                    proc.stdout?.resume();
                });
                proc.stderr?.pipe(logStream, { end: false });
                proc.stdout?.pipe(logStream, { end: false });
            }
            let processError: Error | undefined;
            proc.once("error", (error) => {
                processError = error;
            });
            proc.once("close", (code, exitSignal) => {
                logStream?.end();
                if (processError) {
                    reject(processError);
                } else if (code === 0) {
                    resolve();
                } else {
                    reject(
                        new Error(
                            `FFmpeg exited with ${
                                code === null ? `signal ${exitSignal}` : `code ${code}`
                            }`
                        )
                    );
                }
            });
        });
        await rename(partialPath, outputPath);
        return outputPath;
    } catch (error) {
        await unlink(partialPath).catch(() => undefined);
        throw error;
    }
}

async function validateMediaFile(
    filePath: string,
    stream: "a:0" | "v:0",
    signal: AbortSignal
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            "ffprobe",
            [
                "-v",
                "error",
                "-select_streams",
                stream,
                "-show_frames",
                "-show_entries",
                "frame=stream_index",
                "-read_intervals",
                "%+5",
                "-of",
                "csv=p=0",
                ...INPUT_RECOVERY_OPTIONS,
                filePath
            ],
            {
                stdio: ["ignore", "pipe", "ignore"],
                signal,
                timeout: FFPROBE_TIMEOUT,
                killSignal: "SIGKILL"
            }
        );
        let hasOutput = false;
        let processError: Error | undefined;
        proc.stdout?.on("data", () => {
            hasOutput = true;
        });
        proc.on("close", (code, exitSignal) => {
            if (signal.aborted) {
                reject(signal.reason);
            } else if (processError) {
                reject(processError);
            } else if (exitSignal) {
                reject(new Error(`FFprobe exited with signal ${exitSignal}`));
            } else {
                resolve(code === 0 && hasOutput);
            }
        });
        proc.on("error", (error) => {
            processError = error;
        });
    });
}

/**
 * Minimum time gap (ms) between segment boundaries. Changes occurring within
 * this threshold are merged to avoid excessive segment fragmentation.
 *
 * Example: 10 different people start their webcam within 500ms of each other,
 * that would naively generate 10 different layout segments. This threshold
 * merges them into a single segment, at the cost of missing a few ms of some videos.
 */
const SEGMENT_COALESCE_THRESHOLD = 500;

type VideoFileInfo = {
    filename: string;
    type: STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN;
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
    private readonly _signal = AbortSignal.timeout(COMPILATION_TIMEOUT);
    private _audioPromise?: Promise<string | undefined>;
    private _videoPromise?: Promise<string | undefined>;
    private async _concatenateSegments({
        concatListPath,
        segmentFiles,
        audioPath,
        outputPath
    }: {
        concatListPath: string;
        segmentFiles: string[];
        audioPath: string | undefined;
        outputPath: string;
    }): Promise<string> {
        const concatContent = segmentFiles.map((f) => `file '${f}'`).join("\n");
        await writeFile(concatListPath, concatContent);
        const inputs: string[] = ["-f", "concat", "-safe", "0", "-i", concatListPath];
        if (audioPath) {
            inputs.push("-i", audioPath);
        }
        const mapArgs = ["-map", "0:v"];
        if (audioPath) {
            mapArgs.push("-map", "1:a");
        }
        const args = [...inputs, ...mapArgs, "-c", "copy", "-movflags", "+faststart"];
        return runFfmpeg(args, outputPath, this._signal);
    }

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

    //////////////////////////////////
    //////////// AUDIO ///////////////
    //////////////////////////////////

    /**
     * Compiles the raw recording into a single file.
     * @returns The full path to the compiled file, or undefined if no audio files were found.
     */
    getAudio(): Promise<string | undefined> {
        return (this._audioPromise ??= this._compileAudio());
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
            if (startTime >= this._stoppedAt) {
                continue;
            }
            const filePath = path.join(this._workingDir, "audio", filename);
            if (!(await validateMediaFile(filePath, "a:0", this._signal))) {
                logger.warn(`Skipping corrupted audio file: ${filePath}`);
                continue;
            }
            relevantFiles.push({
                path: filePath,
                offset: startTime - this._startedAt
            });
        }
        if (relevantFiles.length === 0) {
            logger.warn("No audio files found");
            return;
        }
        const outputName = path.join(
            this._workingDir,
            `${FILENAME_PREFIX}${this._startedAt}.${config.recording.audio.ext}`
        );
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
            inputs.push(...INPUT_RECOVERY_OPTIONS, "-i", file.path);
            filterComplex.push(`[${index}:a]adelay=${delay}|${delay}[a${index}]`);
        });

        const mixInputs = relevantFiles.map((_, i) => `[a${i}]`).join("");
        filterComplex.push(
            `${mixInputs}amix=inputs=${relevantFiles.length}:dropout_transition=0[out]`
        );
        const args = [
            ...inputs,
            "-filter_complex",
            filterComplex.join(";"),
            "-map",
            "[out]",
            "-t",
            duration.toFixed(3),
            "-c:a",
            config.recording.audio.codec,
            "-b:a",
            config.recording.audio.bitRate
        ];
        return runFfmpeg(args, outputName, this._signal);
    }

    //////////////////////////////////
    //////////// VIDEO ///////////////
    //////////////////////////////////
    // TODO document somewhere that the output is 1280x720, currently hard-coded

    getVideo(): Promise<string | undefined> {
        return (this._videoPromise ??= this._compileVideo());
    }

    private async _compileVideo(): Promise<string | undefined> {
        const segments = this._buildVideoSegments();
        if (segments.length === 0) {
            logger.info("No video segments found, falling back to audio-only");
            return;
        }
        const validVideoPaths = await this._getValidVideoPaths(segments);
        if (validVideoPaths.size === 0) {
            logger.warn("No valid video files found, falling back to audio-only");
            return;
        }
        const outputName = path.join(
            this._workingDir,
            `${FILENAME_PREFIX}${this._startedAt}.${config.recording.video.ext}`
        );
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return outputName;
        } catch {
            // File does not exist, continue
        }
        const segmentFiles: string[] = [];
        const concatListPath = path.join(this._workingDir, "concat_list.txt");
        try {
            for (let i = 0; i < segments.length; i++) {
                segmentFiles.push(await this._compileSegment(segments[i], i, validVideoPaths));
            }
            return await this._concatenateSegments({
                concatListPath,
                segmentFiles,
                audioPath: await this.getAudio(),
                outputPath: outputName
            });
        } finally {
            const cleanup = await Promise.allSettled(
                [concatListPath, ...segmentFiles].map((file) => rm(file, { force: true }))
            );
            if (cleanup.some((result) => result.status === "rejected")) {
                logger.error("Failed to cleanup temporary video compilation files");
            }
        }
    }

    /**
     * Builds video segments from timestamps. Each segment represents a video "layout"
     * ( a group if videos that are active at the same time)
     */
    private _buildVideoSegments(): VideoSegment[] {
        const segments: VideoSegment[] = [];
        const activeFiles = new Map<string, VideoFileInfo>();
        const fileFirstActive = new Map<string, number>();
        const videoTimestamps = this._timeStamps
            .filter(
                (ts) =>
                    ts.timestamp < this._stoppedAt &&
                    ts.tag === TIME_TAG.FILE_STATE_CHANGE &&
                    ts.info &&
                    (ts.info.type === STREAM_TYPE.CAMERA || ts.info.type === STREAM_TYPE.SCREEN)
            )
            .sort((a, b) => a.timestamp - b.timestamp);
        if (videoTimestamps.length === 0) {
            return [];
        }
        let currentSegmentStart = this._startedAt;
        const flushSegment = (endTime: number) => {
            if (endTime <= currentSegmentStart) {
                return;
            }
            segments.push({
                startTime: currentSegmentStart,
                endTime,
                files: new Map(activeFiles)
            });
            currentSegmentStart = endTime;
        };
        let index = 0;
        while (index < videoTimestamps.length) {
            const batchStart = videoTimestamps[index].timestamp;
            flushSegment(Math.max(this._startedAt, batchStart));
            const batchEnd = batchStart + SEGMENT_COALESCE_THRESHOLD;
            while (index < videoTimestamps.length && videoTimestamps[index].timestamp <= batchEnd) {
                const timestamp = videoTimestamps[index];
                const { filename, type, active } = timestamp.info!;
                if (active) {
                    const fileStartTime = fileFirstActive.get(filename) ?? timestamp.timestamp;
                    fileFirstActive.set(filename, fileStartTime);
                    activeFiles.set(filename, {
                        filename,
                        type: type as STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN,
                        fileStartTime
                    });
                } else {
                    activeFiles.delete(filename);
                }
                index++;
            }
        }
        flushSegment(this._stoppedAt);
        return segments.some((segment) => segment.files.size > 0) ? segments : [];
    }

    private async _getValidVideoPaths(segments: VideoSegment[]) {
        const paths = new Set(
            segments.flatMap((segment) =>
                [...segment.files.values()].map((file) =>
                    path.join(this._workingDir, file.type, file.filename)
                )
            )
        );
        const validPaths = new Set<string>();
        for (const filePath of paths) {
            if (await validateMediaFile(filePath, "v:0", this._signal)) {
                validPaths.add(filePath);
            } else {
                logger.warn(`Skipping corrupted video file: ${filePath}`);
            }
        }
        return validPaths;
    }

    private async _compileSegment(
        segment: VideoSegment,
        index: number,
        validVideoPaths: Set<string>
    ): Promise<string> {
        const files = Array.from(segment.files.values());
        const outputPath = path.join(
            this._workingDir,
            `segment_${index}.${config.recording.video.ext}`
        );
        const duration = (segment.endTime - segment.startTime) / 1000;
        const validFiles = files.flatMap((file) => {
            const filePath = path.join(this._workingDir, file.type, file.filename);
            return validVideoPaths.has(filePath) ? [{ file, filePath }] : [];
        });
        const validScreenFiles = validFiles.filter(({ file }) => file.type === STREAM_TYPE.SCREEN);
        const validCameraFiles = validFiles.filter(({ file }) => file.type === STREAM_TYPE.CAMERA);
        if (validFiles.length === 0) {
            if (files.length > 0) {
                logger.warn(`Segment ${index}: all video files are corrupted, using black video`);
            }
            return runFfmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    `color=c=black:s=1280x720:r=${config.recording.video.frameRate}`,
                    "-t",
                    duration.toFixed(3),
                    "-c:v",
                    config.recording.video.codec,
                    "-preset",
                    config.recording.video.preset,
                    "-movflags",
                    "+faststart"
                ],
                outputPath,
                this._signal
            );
        }
        const inputs: string[] = [];
        const filterComplex: string[] = [];
        for (const { file, filePath } of validScreenFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push(...INPUT_RECOVERY_OPTIONS, "-i", filePath);
        }
        for (const { file, filePath } of validCameraFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push(...INPUT_RECOVERY_OPTIONS, "-i", filePath);
        }
        let outputLabel: string;
        if (validScreenFiles.length > 0 && validCameraFiles.length > 0) {
            const screenHeight = 580;
            const barHeight = 140;
            const camWidth = Math.floor(1280 / validCameraFiles.length);
            filterComplex.push(
                `[0:v]scale=1280:${screenHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=1280:${screenHeight}:(ow-iw)/2:(oh-ih)/2[screen]`
            );
            for (let i = 0; i < validCameraFiles.length; i++) {
                const streamIdx = validScreenFiles.length + i;
                filterComplex.push(
                    `[${streamIdx}:v]scale=${camWidth}:${barHeight}:force_original_aspect_ratio=decrease,` +
                        `pad=${camWidth}:${barHeight}:(ow-iw)/2:(oh-ih)/2[cam${i}]`
                );
            }
            if (validCameraFiles.length === 1) {
                filterComplex.push(`[cam0]pad=1280:${barHeight}:(1280-iw)/2:0[cambar]`);
            } else {
                const camLabels = validCameraFiles.map((_, i) => `[cam${i}]`).join("");
                filterComplex.push(`${camLabels}hstack=inputs=${validCameraFiles.length}[cambar]`);
            }
            filterComplex.push(`[screen][cambar]vstack=inputs=2[vout]`);
            outputLabel = "[vout]";
        } else if (validScreenFiles.length > 0) {
            filterComplex.push(
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                    `pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
            );
            outputLabel = "[vout]";
        } else {
            outputLabel = this._buildCameraGrid(validCameraFiles.length, filterComplex);
        }
        const args = [
            ...inputs,
            "-filter_complex",
            filterComplex.join(";"),
            "-map",
            outputLabel,
            "-t",
            duration.toFixed(3),
            "-r",
            config.recording.video.frameRate,
            "-c:v",
            config.recording.video.codec,
            "-preset",
            config.recording.video.preset,
            // Moves the moov atom to the front so segment files can be
            // read sequentially during concatenation without seeking.
            "-movflags",
            "+faststart"
        ];
        return runFfmpeg(args, outputPath, this._signal);
    }

    /**
     * Builds a dynamic grid layout filter for cameras.
     *
     * @returns The FFmpeg filter label for the final combined video stream.
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
        // scaling
        for (let i = 0; i < cameraCount; i++) {
            filterComplex.push(
                `[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2[v${i}]`
            );
        }
        // horizontal
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
            return rowLabels[0];
        }
        filterComplex.push(`${rowLabels.join("")}vstack=inputs=${rows}[vout]`);
        return "[vout]";
    }
}
