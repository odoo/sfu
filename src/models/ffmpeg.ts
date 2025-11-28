/* eslint-disable prettier/prettier */
import { spawn, ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { Logger } from "#src/utils/utils.ts";
import type { rtpData } from "#src/models/media_output";
import { recording } from "#src/config.ts";

const logger = new Logger("FFMPEG");

let currentId = 0;

export class FFMPEG {
    readonly id: number;
    private readonly rtp: rtpData;
    private _process?: ChildProcess;
    private _isClosed = false;
    private _filename: string;

    constructor(rtp: rtpData, filename: string) {
        this.rtp = rtp;
        this.id = currentId++;
        this._filename = filename;
        logger.verbose(`creating FFMPEG for ${this.id}`);
        this._init();
    }

    close() {
        if (this._isClosed) {
            return;
        }
        this._isClosed = true;
        logger.verbose(`closing FFMPEG ${this.id}`);
        if (this._process) {
            this._process.kill("SIGINT");
        }
        this._cleanup();
    }

    private _init() {
        if (this._isClosed) {
            this._cleanup();
            return;
        }
        
        try {
            const sdpString = this._createSdpText();
            logger.trace(`FFMPEG ${this.id} SDP:\n${sdpString}`);
            
            const sdpStream = Readable.from([sdpString]);
            const args = this._getCommandArgs();
            
            logger.verbose(`spawning ffmpeg with args: ${args.join(" ")}`);
            
            this._process = spawn("ffmpeg", args);
            
            if (this._process.stderr) {
                this._process.stderr.setEncoding("utf-8");
                this._process.stderr.on("data", (data) => {
                    logger.debug(`[ffmpeg ${this.id}] ${data}`);
                });
            }
            
            if (this._process.stdout) {
                 this._process.stdout.setEncoding("utf-8");
                 this._process.stdout.on("data", (data) => {
                     logger.debug(`[ffmpeg ${this.id} stdout] ${data}`);
                 });
            }

            this._process.on("error", (error) => {
                logger.error(`ffmpeg ${this.id} error: ${error.message}`);
                this.close();
            });

            this._process.on("close", (code) => {
                logger.verbose(`ffmpeg ${this.id} exited with code ${code}`);
                this.close();
            });

            sdpStream.on("error", (error) => {
                logger.error(`sdpStream error: ${error.message}`);
            });

            if (this._process.stdin) {
                sdpStream.pipe(this._process.stdin);
            }
        } catch (error) {
            logger.error(`Failed to initialize FFMPEG ${this.id}: ${error}`);
            this.close();
        }
    }

    private _cleanup() {
        this._process = undefined;
        logger.verbose(`FFMPEG ${this.id} closed`);
    }

    private _createSdpText(): string {
        const { port, payloadType, codec, clockRate, channels, kind } = this.rtp;

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
        sdp += `\na=recvonly\n`;
        return sdp;
    }

    private _getContainerExtension(): string {
        const codec = this.rtp.codec?.toLowerCase();
        
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
        let args = [
            "-loglevel", "debug", // TODO remove
            "-protocol_whitelist", "pipe,udp,rtp",
            "-fflags", "+genpts",
            "-f", "sdp",
            "-i", "pipe:0"
        ];
        if (this.rtp.kind === "audio") {
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
