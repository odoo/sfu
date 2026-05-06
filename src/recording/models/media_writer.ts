import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

import { Logger } from "#src/utils/utils.ts";
import * as config from "#src/config.ts";
import type { RtpData } from "#src/recording/models/media_sink.ts";

const logger = new Logger("FFMPEG");
/**
 * We need to move forward with the recording even if ffmpeg does not close gracefully.
 * If ffmpeg does not close gracefully, force kill it after this timeout.
 */
const FFMPEG_KILL_TIMEOUT = 30_000;

export type MediaWriterFailureReason =
    | "initialization_error"
    | "process_error"
    | "process_exit"
    | "force_kill";

export type MediaWriterFailure = {
    filename: string;
    reason: MediaWriterFailureReason;
    error: Error;
};

/**
 * Abstraction for a FFMPEG child process that captures RTP streams to disk.
 */
export class MediaWriter extends EventEmitter {
    static readonly Events = {
        FAILURE: "failure"
    } as const;
    readonly extension: string;
    readonly filename: string;
    private readonly _rtp: RtpData;
    private _process?: ChildProcess;
    private _isClosed = false;
    private _isProcessClosed = false;
    private _isCloseExpected = false;
    private _failure?: MediaWriterFailure;
    private _closePromise?: Promise<void>;
    private _logStream?: fs.WriteStream;
    private readonly _directory: string;

    constructor(rtp: RtpData, directory: string, filename: string) {
        super();
        this._rtp = rtp;
        this._directory = directory;
        this.extension = this._getContainerExtension();
        this.filename = `${filename}.${this.extension}`;
        this._init();
    }

    async close() {
        if (this._closePromise) {
            return this._closePromise;
        }
        if (this._isClosed) {
            return;
        }
        this._isClosed = true;
        this._logStream?.end();
        this._closePromise = this._closeProcess();
        return this._closePromise;
    }

    private async _closeProcess() {
        if (this._process && !this._isProcessClosed && !this._process.killed) {
            let timeoutId: NodeJS.Timeout;
            const closed = new Promise<void>((resolve) => {
                this._process!.once("close", () => resolve());
            });

            this._isCloseExpected = true;
            this._process.kill("SIGINT");
            const timeoutResult = await Promise.race([
                closed.then(() => "closed"),
                new Promise<string>((resolve) => {
                    timeoutId = setTimeout(() => resolve("timeout"), FFMPEG_KILL_TIMEOUT);
                })
            ]);
            clearTimeout(timeoutId!);
            if (timeoutResult === "timeout") {
                const error = new Error(
                    `FFMPEG ${this.filename} did not close gracefully, force killing.`
                );
                logger.warn(error.message);
                this._emitFailure("force_kill", error);
                this._process.kill("SIGKILL");
                throw error;
            }
        }
    }

    private _init() {
        try {
            const args = this._getCommandArgs();
            logger.debug(`spawning ffmpeg with args: ${args.join(" ")}`);
            this._process = spawn("ffmpeg", args);
            if (config.FFMPEG_LOGGING) {
                this._logStream = fs.createWriteStream(
                    `${path.join(this._directory, this.filename)}.log`
                );
                this._process.stderr?.pipe(this._logStream, { end: false });
                this._process.stdout?.pipe(this._logStream, { end: false });
            }
            this._process.on("error", (error) => {
                logger.error(`ffmpeg ${this.filename} error: ${error.message}`);
                this._emitFailure("process_error", error);
                void this.close().catch((closeError) => {
                    logger.error(`Failed to close FFMPEG ${this.filename}: ${closeError}`);
                });
            });
            this._process.on("close", (code, signal) => {
                this._isProcessClosed = true;
                logger.verbose(`ffmpeg ${this.filename} exited with code ${code}`);
                if (!this._isCloseExpected && code !== 0) {
                    this._emitFailure(
                        "process_exit",
                        new Error(
                            `FFMPEG ${this.filename} exited with code ${code}` +
                                (signal ? ` and signal ${signal}` : "")
                        )
                    );
                }
            });
            const sdpString = this._getSdpText();
            logger.debug(`FFMPEG ${this.filename} SDP:\n${sdpString}`);
            const sdpStream = Readable.from([sdpString]);
            sdpStream.on("error", (error) => {
                logger.error(`sdpStream error: ${error.message}`);
            });
            if (this._process.stdin) {
                sdpStream.pipe(this._process.stdin);
            }
        } catch (error) {
            logger.error(`Failed to initialize FFMPEG ${this.filename}: ${error}`);
            this._emitFailure(
                "initialization_error",
                error instanceof Error ? error : new Error(String(error))
            );
            void this.close().catch((closeError) => {
                logger.error(`Failed to close FFMPEG ${this.filename}: ${closeError}`);
            });
        }
    }

    private _emitFailure(reason: MediaWriterFailureReason, error: Error) {
        if (this._failure) {
            return;
        }
        this._failure = { filename: this.filename, reason, error };
        this.emit(MediaWriter.Events.FAILURE, this._failure);
    }

    private _getContainerExtension(): string {
        const codec = this._rtp.codec?.toLowerCase();
        switch (codec) {
            /**
             *  TODO maybe only use robust formats that can survive abrupt termination,
             *  so maybe not MP4?
             */
            case "h264":
            case "h265":
                return "mp4";
            case "vp8":
            case "vp9":
            case "av1":
            case "opus":
            case "vorbis":
                return "webm";
            case "pcmu":
            case "pcma":
                return "wav";
            default:
                logger.warn(`Unknown codec "${codec}", using .mkv container as fallback`);
                return "mkv";
        }
    }

    private _getCommandArgs(): string[] {
        let args = [
            "-loglevel",
            config.FFMPEG_LOGGING ? "debug" : "error",
            // Input options for RTP stream
            "-reorder_queue_size",
            "500", // larger reorder queue to handle out-of-order RTP packets
            "-analyzeduration",
            "5000000", // 5 seconds to properly detect stream properties and wait for keyframe TODO: maybe not necessary anymore since we force request keyframe on start
            "-probesize",
            "10000000", // 10 MB probe size for better codec detection
            "-protocol_whitelist",
            "pipe,udp,rtp",
            "-fflags",
            "+genpts+discardcorrupt", // generate PTS, drop corrupt packets (removed nobuffer to allow buffering)
            "-f",
            "sdp",
            "-i",
            "pipe:0"
        ];
        // Output options - normalize timestamps to start from 0
        args.push("-start_at_zero");
        args.push("-copyts"); // preserve timestamps during copy
        if (this._rtp.kind === "audio") {
            args = args.concat(["-map", "0:a:0", "-c:a", "copy"]);
        } else {
            args = args.concat([
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-vsync",
                "passthrough" // preserve frame timing without dropping/duplicating
            ]);
        }
        // Reset timestamps in the output container
        args.push("-output_ts_offset", "0");
        args.push(path.join(this._directory, this.filename));
        return args;
    }

    private _getSdpText(): string {
        const { port, payloadType, codec, clockRate, channels, kind } = this._rtp;
        const channelStr = kind === "audio" && channels ? `/${channels}` : "";
        return [
            "v=0",
            `o=- 0 0 IN IP4 ${config.recording.routingInterface}`,
            "s=FFmpeg",
            `c=IN IP4 ${config.recording.routingInterface}`,
            "t=0 0",
            `m=${kind} ${port} RTP/AVP ${payloadType}`,
            `a=rtpmap:${payloadType} ${codec}/${clockRate}${channelStr}`,
            "a=rtcp-mux",
            "a=recvonly",
            ""
        ].join("\n");
    }
}
