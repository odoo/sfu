/* eslint-disable prettier/prettier */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

import { Logger } from "#src/utils/utils.ts";
import type { rtpData } from "#src/models/media_output";
import { recording } from "#src/config.ts";

const logger = new Logger("FFMPEG");
export class FFMPEG {
    readonly filename: string;
    private readonly _rtp: rtpData;
    private _process?: ChildProcess;
    private _isClosed = false;
    private _logStream?: fs.WriteStream;
    private readonly _directory: string;

    constructor(rtp: rtpData, directory: string, filename: string) {
        this._rtp = rtp;
        this.filename = filename;
        this._directory = directory;
        logger.verbose(`creating FFMPEG for ${this.filename}`);
        this._init();
    }

    async close() {
        if (this._isClosed) {
            return;
        }
        this._isClosed = true;
        this._logStream?.end();
        logger.verbose(`closing FFMPEG ${this.filename}`);
        if (this._process && !this._process.killed) {
            const closed = new Promise((resolve) => {
                this._process!.on("close", resolve);
                logger.verbose(`FFMPEG ${this.filename} closed`);
            });
            this._process!.kill("SIGINT");
            logger.verbose(`FFMPEG ${this.filename} SIGINT sent`);
            await closed;
        }
    }

    private _init() {
        try {
            const sdpString = this._createSdpText();
            logger.verbose(`FFMPEG ${this.filename} SDP:\n${sdpString}`);
            const sdpStream = Readable.from([sdpString]);
            const args = this._getCommandArgs();
            logger.debug(`spawning ffmpeg with args: ${args.join(" ")}`);
            this._process = spawn("ffmpeg", args);

            this._logStream = fs.createWriteStream(`${this.filename}.log`);
            this._process.stderr?.pipe(this._logStream, { end: false });
            this._process.stdout?.pipe(this._logStream, { end: false });

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

    private _createSdpText(): string {
        // TODO docstring on sdp text
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

    private _getCommandArgs(): string[] {
        // TODO docstring on command args
        let args = [
            "-loglevel", "debug", // TODO remove
            "-protocol_whitelist", "pipe,udp,rtp",
            "-fflags", "+genpts",
            "-f", "sdp",
            "-i", "pipe:0"
        ];
        if (this._rtp.kind === "audio") {
             args = args.concat([
                 "-map", "0:a:0",
                 "-c:a", "copy"
             ]);
        } else {
             args = args.concat([
                 "-map", "0:v:0",
                 "-c:v", "copy"
             ]);
        }
        const extension = this._getContainerExtension();
        args.push(`${path.join(this._directory, this.filename)}.${extension}`);
        return args;
    }
}
