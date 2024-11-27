import child_process from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events"; // TODO remove if unnecessary

import { Logger, formatFfmpegSdp } from "#src/utils/utils.js";
import { STREAM_TYPE } from "#src/shared/enums.js";
import { LOG_LEVEL, recording } from "#src/config.js";
import * as config from "#src/config.js";
import * as https from "node:https";
import http from "node:http";

const logger = new Logger("RECORDER");

fs.mkdir(recording.directory, { recursive: true }, (err) => {
    if (err) {
        logger.error(err);
    }
});
export function clearDirectory() {
    const now = Date.now();
    fs.readdir(recording.directory, (err, files) => {
        if (err) {
            logger.error(err);
            return;
        }
        for (const file of files) {
            const stats = fs.statSync(path.join(recording.directory, file));
            if (stats.mtimeMs < now - config.recording.fileTTL) {
                fs.unlink(path.join(recording.directory, file), (err) => {
                    if (err) {
                        logger.error(err);
                    }
                    logger.info(`Deleted recording ${file}`);
                });
            }
            fs.unlink(path.join(recording.directory, file), (err) => {
                if (err) {
                    logger.error(err);
                }
            });
        }
    });
}
/**
 * Wraps the FFMPEG process
 * TODO move in own file
 */
class FFMPEG extends EventEmitter {
    /** @type {child_process.ChildProcess} */
    _process;
    /** @type {string} */
    _filePath;

    get _args() {
        const args = [
            // TODO
            "-protocol_whitelist",
            "pipe,udp,rtp",
            "-fflags",
            "+genpts",
            "-f",
            "sdp",
            "-i",
            "pipe:0",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof", // fragmented
            "-c:v",
            "libx264", // vid codec
            "-c:a",
            "aac", // audio codec
            "-f",
            recording.fileType,
            this._filePath,
        ];
        if (LOG_LEVEL === "debug") {
            args.unshift("-loglevel", "debug");
        }
        return args;
    }

    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        super();
        this._filePath = filePath;
    }

    /**
     * @param {String[]} [sdp]
     */
    async spawn(sdp) {
        this._process = child_process.spawn("ffmpeg", this._args, {
            stdio: ["pipe", "pipe", process.stderr],
        });

        if (!this._process.stdin.writable) {
            throw new Error("FFMPEG stdin not writable.");
        }
        this._process.stdin.write(sdp); // TODO (maybe pass args earlier)
        this._process.stdin.end();

        this._process.stdout.on("data", (chunk) => {
            this.emit("data", chunk); // Emit data chunks as they become available
            // may need to ues this to pipe to request if file stream does not work
        });

        this._process.on("close", (code) => {
            if (code === 0) {
                this.emit("success");
            }
        });

        logger.debug(
            `FFMPEG process (pid:${this._process.pid}) spawned, outputting to ${this._filePath}`
        );
    }

    kill() {
        this._process?.kill("SIGINT");
    }
}

export class Recorder extends EventEmitter {
    /** @type {Map<string, string>} */
    static generatedFiles = new Map();
    /** @type {string} */
    uuid;
    /** @type {import("#src/models/channel").Channel} */
    channel;
    /** @type {string} */
    state;
    /** @type {FFMPEG} */
    ffmpeg;
    /** @type {string} */
    filePath;
    /** @type {number} */
    _limitTimeout;
    /**
     * @param {string} uuid
     * @param {http.ServerResponse} res
     */
    static pipeToResponse(uuid, res) {
        // TODO check if this can be executed, otherwise end request, or throw error (http service will throw anyways)
        const fileStream = fs.createReadStream(Recorder.generatedFiles.get(uuid)); // may need to be explicitly closed?
        res.writeHead(200, {
            "Content-Type": `video/${recording.fileType}`,
            "Content-Disposition": "inline",
        });
        fileStream.pipe(res); // Pipe the file stream to the response
    }
    /**
     * @param {import("#src/models/channel").Channel} channel
     * @param {string} destination url to send the file to
     */
    constructor(channel, destination) {
        super();
        this.channel = channel;
        this._destination = destination;
    }

    /** @returns {number} */
    get videoCount() {
        return this._rtpTransports.camera.length + this._rtpTransports.screen.length;
    }

    /**
     * @param {Array} ids
     * @returns {string} filePath
     */
    async start(ids) {
        if (this.ffmpeg) {
            return this.filePath;
        }
        this.uuid = crypto.randomUUID();
        const audioRtps = [];
        const videoRtps = [];
        for (const id of ids) {
            const session = this.channel.sessions.get(id);
            const audioRtpData = session.getRtp(STREAM_TYPE.AUDIO);
            audioRtpData && audioRtps.push(audioRtpData);
            for (const type in [STREAM_TYPE.CAMERA, STREAM_TYPE.SCREEN]) {
                if (videoRtps.length < recording.videoLimit) {
                    const videoRtpData = session.getRtp(type);
                    videoRtpData && videoRtps.push(videoRtpData);
                }
            }
        }
        this.filePath = path.join(recording.directory, `call_${Date.now()}.${recording.fileType}`);
        this.ffmpeg = new FFMPEG(this.filePath);
        try {
            await this.ffmpeg.spawn(formatFfmpegSdp(audioRtps, videoRtps)); // args should be base on the rtp transports
        } catch (error) {
            logger.error(`Failed to start recording: ${error.message}`);
            this.ffmpeg?.kill();
            this.ffmpeg = undefined;
            return;
        }
        this._limitTimeout = setTimeout(() => {
            this.upload();
        }, recording.maxDuration);
        Recorder.generatedFiles.set(this.uuid, this.filePath);
        this.ffmpeg.once("success", () => {
            this.emit("download-ready", this.filePath);
        });
        return this.filePath;
    }
    update(ids) {
        // TODO see if ffmpeg input can be re-configured at runtime, otherwise no support or full restart
        return this.filePath;
    }
    stop() {
        this.ffmpeg?.kill();
        this.uuid = undefined;
        this.ffmpeg = undefined;
        clearTimeout(this._limitTimeout);
    }
    upload() {
        this.stop();
        if (!this._destination) {
            logger.warn(`No upload destination set for ${this.uuid}`);
            return;
        }
        const fileStream = fs.createReadStream(this.filePath);
        const { hostname, pathname, protocol } = new URL(this._destination);
        const options = {
            hostname,
            path: pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": fs.statSync(this.filePath).size,
            },
        };
        // TODO this  should be a special route that has a generous upload limit
        const request = (protocol === "https:" ? https : http).request(options, (res) => {
            if (res.statusCode === 200) {
                logger.info(`File uploaded to ${this._destination}`);
                // TODO delete file
            } else {
                logger.error(`Failed to upload file: ${res.statusCode}`);
            }
        });
        request.once("error", (error) => {
            logger.error(`Failed to upload file: ${error.message}`);
        });
        fileStream.pipe(request);
    }
}
