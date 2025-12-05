/* eslint-disable prettier/prettier */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";

import { Logger } from "#src/utils/utils.ts";
import type { rtpData } from "#src/models/media_output";
import { recording } from "#src/config.ts";

const logger = new Logger("FFMPEG");
export class FFMPEG {
    private readonly _rtp: rtpData;
    private _process?: ChildProcess;
    private _isClosed = false;
    private readonly _filename: string;
    private _logStream?: fs.WriteStream;

    constructor(rtp: rtpData, filename: string) {
        this._rtp = rtp;
        this._filename = filename;
        logger.verbose(`creating FFMPEG for ${this._filename}`);
        this._init();
    }

    async close() {
        if (this._isClosed) {
            return;
        }
        this._isClosed = true;
        this._logStream?.end();
        logger.verbose(`closing FFMPEG ${this._filename}`);
        if (this._process && !this._process.killed) {
            const closed = new Promise((resolve) => {
                this._process!.on("close", resolve);
                logger.verbose(`FFMPEG ${this._filename} closed`);
            });
            this._process!.kill("SIGINT");
            logger.verbose(`FFMPEG ${this._filename} SIGINT sent`);
            await closed;
        }
    }

    private _init() {
        try {
            const sdpString = this._createSdpText();
            logger.verbose(`FFMPEG ${this._filename} SDP:\n${sdpString}`);
            const sdpStream = Readable.from([sdpString]);
            const args = this._getCommandArgs();
            logger.debug(`spawning ffmpeg with args: ${args.join(" ")}`);
            this._process = spawn("ffmpeg", args);

            this._logStream = fs.createWriteStream(`${this._filename}.log`);
            this._process.stderr?.pipe(this._logStream, { end: false });
            this._process.stdout?.pipe(this._logStream, { end: false });

            this._process.on("error", (error) => {
                logger.error(`ffmpeg ${this._filename} error: ${error.message}`);
                this.close();
            });

            this._process.on("close", (code) => {
                logger.verbose(`ffmpeg ${this._filename} exited with code ${code}`);
            });

            sdpStream.on("error", (error) => {
                logger.error(`sdpStream error: ${error.message}`);
            });

            if (this._process.stdin) {
                sdpStream.pipe(this._process.stdin);
            }
        } catch (error) {
            logger.error(`Failed to initialize FFMPEG ${this._filename}: ${error}`);
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
        args.push(`${this._filename}.${extension}`);
        return args;
    }
}
