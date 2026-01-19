import fs from "node:fs";
import { spawn } from "node:child_process";
import { access, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import { TIME_TAG, type TimeStampData } from "#src/recording/models/recorder.ts";
import { recording, FFMPEG_LOGGING } from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import type { SessionId } from "#src/core/models/session.ts";

const logger = new Logger("MEDIA_COMPILER");
const FILENAME_PREFIX = "recording_";

/**
 * Validates that a video file can be read by FFmpeg.
 * Uses ffprobe to check file headers and stream info.
 * @returns true if the file is valid and readable, false otherwise
 */
async function validateVideoFile(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn("ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            filePath
        ]);

        let hasOutput = false;

        proc.stdout.on("data", () => {
            hasOutput = true;
        });

        proc.on("close", (code) => {
            // Valid if ffprobe exits 0 and found a video stream
            resolve(code === 0 && hasOutput);
        });

        proc.on("error", () => {
            resolve(false);
        });
    });
}

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

    /**
     * TODO make public for meta concatenation (concatenate different recordings of same channel)
     * Concatenates all video segments with the audio track and optional subtitles.
     */
    static async concatenateSegments({
        workingDir,
        segmentFiles,
        audioPath,
        srt,
        outputPath
    }: {
        workingDir: string;
        segmentFiles: string[];
        audioPath: string | undefined;
        srt: string | undefined;
        outputPath: string;
    }): Promise<string> {
        const concatListPath = path.join(workingDir, "concat_list.txt");
        const concatContent = segmentFiles.map((f) => `file '${f}'`).join("\n");
        await writeFile(concatListPath, concatContent);

        let srtPath: string | undefined;
        if (srt) {
            srtPath = path.join(workingDir, "subtitles.srt");
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

            if (FFMPEG_LOGGING) {
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
    async getAudio(): Promise<string | undefined> {
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

        const outputName = path.join(
            this._workingDir,
            `${FILENAME_PREFIX}${this._startedAt}.${recording.audioExt}`
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

            if (FFMPEG_LOGGING) {
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

    async getVideo(srtFile?: string): Promise<string | undefined> {
        if (!this._videoPath) {
            this._videoPath = await this._compileVideo(srtFile);
        }
        return this._videoPath;
    }

    private async _compileVideo(srt?: string): Promise<string | undefined> {
        const segments = this._buildVideoSegments();

        if (segments.length === 0) {
            logger.info("No video segments found, falling back to audio-only");
            return;
        }

        const outputName = path.join(
            this._workingDir,
            `${FILENAME_PREFIX}${this._startedAt}.${recording.videoExt}`
        );
        try {
            await access(outputName);
            logger.info(`Output file ${outputName} already exists, skipping compilation`);
            return outputName;
        } catch {
            // File does not exist, continue
        }

        const segmentFiles: string[] = [];
        for (let i = 0; i < segments.length; i++) {
            const segmentPath = await this._compileSegment(segments[i], i);
            if (segmentPath) {
                segmentFiles.push(segmentPath);
            }
        }

        if (segmentFiles.length === 0) {
            logger.warn("No video segments were successfully compiled");
            return;
        }

        return MediaCompiler.concatenateSegments({
            workingDir: this._workingDir,
            segmentFiles,
            audioPath: await this.getAudio(),
            srt,
            outputPath: outputName
        });
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

        const outputPath = path.join(this._workingDir, `segment_${index}.${recording.videoExt}`);
        const duration = (segment.endTime - segment.startTime) / 1000;

        const screenFiles = files.filter((f) => f.type === STREAM_TYPE.SCREEN);
        const cameraFiles = files.filter((f) => f.type === STREAM_TYPE.CAMERA);

        // Validate files and filter out corrupted ones
        const validScreenFiles: { file: VideoFileInfo; filePath: string }[] = [];
        const validCameraFiles: { file: VideoFileInfo; filePath: string }[] = [];

        for (const file of screenFiles) {
            const filePath = path.join(this._workingDir, "screen", file.filename);
            if (await validateVideoFile(filePath)) {
                validScreenFiles.push({ file, filePath });
            } else {
                logger.warn(`Skipping corrupted screen file: ${file.filename}`);
            }
        }

        for (const file of cameraFiles) {
            const filePath = path.join(this._workingDir, "camera", file.filename);
            if (await validateVideoFile(filePath)) {
                validCameraFiles.push({ file, filePath });
            } else {
                logger.warn(`Skipping corrupted camera file: ${file.filename}`);
            }
        }

        // If all files were corrupted, skip this segment
        if (validScreenFiles.length === 0 && validCameraFiles.length === 0) {
            logger.warn(`Segment ${index}: all video files are corrupted, skipping`);
            return undefined;
        }

        const inputs: string[] = [];
        const filterComplex: string[] = [];

        for (const { file, filePath } of validScreenFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push("-i", filePath);
        }

        for (const { file, filePath } of validCameraFiles) {
            const offset = (segment.startTime - file.fileStartTime) / 1000;
            if (offset > 0) {
                inputs.push("-ss", offset.toFixed(3));
            }
            inputs.push("-i", filePath);
        }

        let outputLabel: string;

        if (validScreenFiles.length > 0 && validCameraFiles.length > 0) {
            // Screen + cameras: screen takes main area, cameras in bottom bar
            // Layout: 1280x720 total - screen: 1280x580 (top), cameras: 1280x140 (bottom bar)
            const screenHeight = 580;
            const barHeight = 140;
            const camWidth = Math.floor(1280 / validCameraFiles.length);

            /**
             * Stage 1 - Scale screen share:
             *   - `[0:v]`: selects video stream from the first input (screen share)
             *   - `scale=1280:580:force_original_aspect_ratio=decrease`: scales to fit within
             *     1280x580 while preserving aspect ratio (may be smaller on one axis)
             *   - `pad=1280:580:(ow-iw)/2:(oh-ih)/2`: adds black bars to center the video
             *     within the target 1280x580 area. `(ow-iw)/2` and `(oh-ih)/2` compute
             *     horizontal and vertical offsets for centering
             *   - `[screen]`: labels the output for later reference
             */
            filterComplex.push(
                `[0:v]scale=1280:${screenHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=1280:${screenHeight}:(ow-iw)/2:(oh-ih)/2[screen]`
            );

            /**
             * Stage 2 - Scale each camera stream:
             *   - `[N:v]`: selects video stream from input N (camera inputs come after screen)
             *   - Same scale + pad logic as stage 1, but for each camera input
             *   - `camWidth` divides 1280px equally among all cameras
             *   - Each camera output is labeled `[cam0]`, `[cam1]`, etc.
             */
            for (let i = 0; i < validCameraFiles.length; i++) {
                const streamIdx = validScreenFiles.length + i;
                filterComplex.push(
                    `[${streamIdx}:v]scale=${camWidth}:${barHeight}:force_original_aspect_ratio=decrease,` +
                        `pad=${camWidth}:${barHeight}:(ow-iw)/2:(oh-ih)/2[cam${i}]`
                );
            }

            /**
             * Stage 3 - Combine cameras into horizontal bar:
             *   - Single camera: `[cam0]pad=1280:140:(1280-iw)/2:0[cambar]`
             *     Centers the lone camera in a 1280px-wide bar
             *   - Multiple cameras: `[cam0][cam1]...hstack=inputs=N[cambar]`
             *     Horizontally stacks all camera streams side-by-side
             */
            if (validCameraFiles.length === 1) {
                filterComplex.push(`[cam0]pad=1280:${barHeight}:(1280-iw)/2:0[cambar]`);
            } else {
                const camLabels = validCameraFiles.map((_, i) => `[cam${i}]`).join("");
                filterComplex.push(`${camLabels}hstack=inputs=${validCameraFiles.length}[cambar]`);
            }

            /**
             * Stage 4 - Stack screen and camera bar vertically:
             *   - `[screen][cambar]vstack=inputs=2[vout]`
             *   - Places screen (580px) on top, camera bar (140px) on bottom = 720px total
             */
            filterComplex.push(`[screen][cambar]vstack=inputs=2[vout]`);
            outputLabel = "[vout]";
        } else if (validScreenFiles.length > 0) {
            // Only screen(s) - fullscreen (use first if multiple)
            // TODO upstream (recorder) should implement the logic that discriminates screen shares
            filterComplex.push(
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                    `pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
            );
            outputLabel = "[vout]";
        } else if (validCameraFiles.length > 0) {
            // Only cameras - dynamic grid layout
            outputLabel = this._buildCameraGrid(validCameraFiles.length, filterComplex);
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
            "-r",
            recording.frameRate,
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

            if (FFMPEG_LOGGING) {
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
     *
     * @returns The FFmpeg filter label for the final combined video stream.
     */
    private _buildCameraGrid(cameraCount: number, filterComplex: string[]): string {
        /**
         * Single camera shortcut:
         *   - If only one camera, scale it to fill the entire 1280x720 frame
         *   - `force_original_aspect_ratio=decrease`: preserves aspect ratio
         *   - `pad`: centers the video with black bars if needed
         *   - Returns `[vout]` immediately, no grid logic needed
         */
        if (cameraCount === 1) {
            filterComplex.push(
                `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                    `pad=1280:720:(ow-iw)/2:(oh-ih)/2[vout]`
            );
            return "[vout]";
        }

        /**
         * Calculate grid dimensions:
         *   - `cols = ceil(sqrt(cameraCount))`: optimal columns for near-square grid
         *   - `rows = ceil(cameraCount / cols)`: rows needed to fit all cameras
         *   - Example: 5 cameras → 3 cols × 2 rows (last row has 2 cameras)
         *   - Cell dimensions divide 1280x720 evenly among grid cells
         */
        const cols = Math.ceil(Math.sqrt(cameraCount));
        const rows = Math.ceil(cameraCount / cols);
        const cellWidth = Math.floor(1280 / cols);
        const cellHeight = Math.floor(720 / rows);

        /**
         * Scale each camera into a cell:
         *   - `[i:v]`: selects video stream from input i
         *   - Scales to cell dimensions while preserving aspect ratio
         *   - Pads with black bars to center within the cell
         *   - Labels output as `[v0]`, `[v1]`, etc.
         */
        for (let i = 0; i < cameraCount; i++) {
            filterComplex.push(
                `[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2[v${i}]`
            );
        }

        /**
         * Assemble cells into rows:
         *   - Groups cells by row and combines them horizontally
         *   - Single cell in row: pads to full width (1280px) and centers
         *   - Multiple cells: uses `hstack` to join side-by-side
         *   - Each row labeled as `[row0]`, `[row1]`, etc.
         */
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

        /**
         * Stack rows vertically:
         *   - If only one row exists, return `[row0]` directly (no vstack needed)
         *   - Otherwise, `vstack` all rows into final `[vout]`
         */
        if (rows === 1) {
            return rowLabels[0];
        }
        filterComplex.push(`${rowLabels.join("")}vstack=inputs=${rows}[vout]`);
        return "[vout]";
    }
}
