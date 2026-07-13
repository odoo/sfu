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
const FFMPEG_LIFETIME = config.recording.maxDuration + FFMPEG_KILL_TIMEOUT * 2;

export type MediaWriterFailure = {
    filename: string;
    error: Error;
};

/**
 * Abstraction for a FFMPEG child process that captures RTP streams to disk.
 */
export class MediaWriter extends EventEmitter {
    static readonly Events = {
        FAILURE: "failure",
        PROCESS_CLOSE: "processClose"
    } as const;
    readonly extension: string;
    readonly filename: string;
    private readonly _rtp: RtpData;
    private _process?: ChildProcess;
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

    close(): Promise<void> {
        return (this._closePromise ??= this._closeProcess());
    }

    get isProcessClosed() {
        return !this._process || this._isProcessClosed;
    }

    private _waitForProcessClose(process: ChildProcess) {
        if (this._isProcessClosed) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const onClose = () => {
                clearTimeout(timeoutId);
                resolve(true);
            };
            const timeoutId = setTimeout(() => {
                process.off("close", onClose);
                resolve(false);
            }, FFMPEG_KILL_TIMEOUT);
            process.once("close", onClose);
        });
    }

    private async _closeProcess() {
        const process = this._process;
        if (!process || this._isProcessClosed) {
            return;
        }
        if (process.killed) {
            if (await this._waitForProcessClose(process)) {
                return;
            }
            throw new Error(`FFMPEG ${this.filename} remained alive after a termination signal`);
        }
        this._isCloseExpected = true;
        process.kill("SIGINT");
        if (await this._waitForProcessClose(process)) {
            return;
        }
        const error = new Error(`FFMPEG ${this.filename} did not close gracefully, force killing.`);
        logger.warn(error.message);
        this._emitFailure(error);
        if (!this._isProcessClosed) {
            process.kill("SIGKILL");
        }
        if (!(await this._waitForProcessClose(process))) {
            throw new Error(`FFMPEG ${this.filename} remained alive after force killing`);
        }
        throw error;
    }

    private _init() {
        try {
            const args = this._getCommandArgs();
            logger.debug(`spawning ffmpeg with args: ${args.join(" ")}`);
            this._process = spawn("ffmpeg", args, {
                stdio: config.FFMPEG_LOGGING
                    ? ["pipe", "pipe", "pipe"]
                    : ["pipe", "ignore", "ignore"],
                timeout: FFMPEG_LIFETIME,
                killSignal: "SIGKILL"
            });
            if (config.FFMPEG_LOGGING) {
                this._logStream = fs.createWriteStream(
                    `${path.join(this._directory, this.filename)}.log`
                );
                this._logStream.on("error", (error) => {
                    logger.error(`FFmpeg log failure: ${error}`);
                    this._process?.stderr?.unpipe(this._logStream);
                    this._process?.stdout?.unpipe(this._logStream);
                    this._process?.stderr?.resume();
                    this._process?.stdout?.resume();
                });
                this._process.stderr?.pipe(this._logStream, { end: false });
                this._process.stdout?.pipe(this._logStream, { end: false });
            }
            this._process.on("error", (error) => {
                logger.error(`ffmpeg ${this.filename} error: ${error.message}`);
                this._emitFailure(error);
                void this.close().catch((closeError) => {
                    logger.error(`Failed to close FFMPEG ${this.filename}: ${closeError}`);
                });
            });
            this._process.on("close", (code, signal) => {
                this._isProcessClosed = true;
                this.emit(MediaWriter.Events.PROCESS_CLOSE);
                this._logStream?.end();
                logger.verbose(`ffmpeg ${this.filename} exited with code ${code}`);
                if (!this._isCloseExpected) {
                    this._emitFailure(
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
            this._emitFailure(error instanceof Error ? error : new Error(String(error)));
            void this.close().catch((closeError) => {
                logger.error(`Failed to close FFMPEG ${this.filename}: ${closeError}`);
            });
        }
    }

    private _emitFailure(error: Error) {
        if (this._failure) {
            return;
        }
        this._failure = { filename: this.filename, error };
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
