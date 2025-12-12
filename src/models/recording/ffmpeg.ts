import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

import { Logger, LogLevel } from "#src/utils/utils.ts";
import { recording, LOG_LEVEL } from "#src/config.ts";
import type { rtpData } from "#src/models/recording/media_output.ts";

const logger = new Logger("FFMPEG");
const isDebug = LOG_LEVEL === LogLevel.DEBUG;

/**
 * Abstraction for a FFMPEG child process
 */
export class FFMPEG {
    readonly extension: string;
    readonly filename: string;
    private readonly _rtp: rtpData;
    private _process?: ChildProcess;
    private _isClosed = false;
    private _logStream?: fs.WriteStream;
    private readonly _directory: string;

    constructor(rtp: rtpData, directory: string, filename: string) {
        this._rtp = rtp;
        this._directory = directory;
        this.extension = this._getContainerExtension();
        this.filename = `${filename}.${this.extension}`;
        this._init();
    }

    async close() {
        if (this._isClosed) {
            return;
        }
        this._isClosed = true;
        this._logStream?.end();
        if (this._process && !this._process.killed) {
            const closed = new Promise((resolve) => {
                this._process!.on("close", resolve);
            });
            this._process!.kill("SIGINT");
            await closed;
        }
    }

    private async _init() {
        try {
            /**
             * FFMPEG does not create the directory if it doesn't exist,
             * so it needs to be created before spawning the process.
             */
            await mkdir(this._directory, { recursive: true });
            if (this._isClosed) {
                return;
            }
            const sdpString = this._createSdpText();
            logger.debug(`FFMPEG ${this.filename} SDP:\n${sdpString}`);
            const sdpStream = Readable.from([sdpString]);
            const args = this._getCommandArgs();
            logger.debug(`spawning ffmpeg with args: ${args.join(" ")}`);
            this._process = spawn("ffmpeg", args);

            if (isDebug) {
                this._logStream = fs.createWriteStream(
                    `${path.join(this._directory, this.filename)}.log`
                );
                this._process.stderr?.pipe(this._logStream, { end: false });
                this._process.stdout?.pipe(this._logStream, { end: false });
            }

            this._process.on("error", (error) => {
                logger.error(`ffmpeg ${this.filename} error: ${error.message}`);
                this.close();
            });

            this._process.on("close", (code) => {
                logger.verbose(`ffmpeg ${this.filename} exited with code ${code}`);
            });

            sdpStream.on("error", (error) => {
                logger.error(`sdpStream error: ${error.message}`);
            });

            if (this._process.stdin) {
                sdpStream.pipe(this._process.stdin);
            }
        } catch (error) {
            logger.error(`Failed to initialize FFMPEG ${this.filename}: ${error}`);
            this.close();
        }
    }

    /**
     * Build a Session Description Protocol (SDP) payload describing the incoming RTP stream.
     * SDP informs ffmpeg about the media session negotiated elsewhere (port, codec, clock rate,
     * payload type, channels, and whether the track is audio or video) so ffmpeg can attach to
     * the RTP source. These lines are piped to ffmpeg stdin as a virtual `.sdp` file; they are
     * separate from the spawn arguments, which configure the ffmpeg process itself (loglevel,
     * input pipe, mapping, container, etc.).
     */
    private _createSdpText(): string {
        const { port, payloadType, codec, clockRate, channels, kind } = this._rtp;

        if (!port || !payloadType || !codec || !clockRate || !kind) {
            throw new Error("RTP missing required properties for SDP generation");
        }

        let sdp = `v=0\n`;
        sdp += `o=- 0 0 IN IP4 ${recording.routingInterface}\n`;
        sdp += `s=FFmpeg\n`;
        sdp += `c=IN IP4 ${recording.routingInterface}\n`;
        sdp += `t=0 0\n`;
        sdp += `m=${kind} ${port} RTP/AVP ${payloadType}\n`;
        sdp += `a=rtpmap:${payloadType} ${codec}/${clockRate}`;

        if (kind === "audio" && channels) {
            sdp += `/${channels}`;
        }
        sdp += `\na=rtcp-mux`;
        sdp += `\na=recvonly\n`;
        return sdp;
    }

    private _getContainerExtension(): string {
        const codec = this._rtp.codec?.toLowerCase();

        switch (codec) {
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
                // G.711 codecs - use WAV container for raw PCM audio
                return "wav";

            default:
                logger.warn(`Unknown codec "${codec}", using .mkv container as fallback`);
                return "mkv";
        }
    }

    /**
     * Build the ffmpeg CLI arguments used to consume the SDP from stdin and remux the
     * incoming RTP stream to disk.
     */
    private _getCommandArgs(): string[] {
        let args = [
            "-loglevel",
            isDebug ? "debug" : "error",
            "-protocol_whitelist",
            "pipe,udp,rtp",
            "-fflags",
            "+genpts", // preserve packet timestamps for deterministic output
            "-f",
            "sdp", // Force format to SDP (Session Description Protocol)
            "-i",
            "pipe:0" // Read SDP from stdin
        ];
        if (this._rtp.kind === "audio") {
            args = args.concat(["-map", "0:a:0", "-c:a", "copy"]);
        } else {
            args = args.concat(["-map", "0:v:0", "-c:v", "copy"]);
        }
        args.push(path.join(this._directory, this.filename));
        return args;
    }
}
