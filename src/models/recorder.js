import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { EventEmitter } from "node:events"; // TODO remove if unnecessary
import { Logger } from "#src/utils/utils.js";
import { STREAM_TYPE } from "#src/shared/enums.js";
import { RECORDING_FILE_TYPE } from "#src/config.js";

const logger = new Logger("RECORDER");
const temp = os.tmpdir();
const VIDEO_LIMIT = 4;

/**
 * @typedef {Object} RTPTransports
 * @property {Array<import("mediasoup").types.Transport>} audio
 * @property {Array<import("mediasoup").types.Transport>} camera
 * @property {Array<import("mediasoup").types.Transport>} screen
 */

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
        return [
            "-loglevel",
            "debug", // TODO warning in prod
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
            RECORDING_FILE_TYPE,
            this._filePath,
        ];
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
        this._process.stdin.write(sdp);
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
    static records = new Map();

    /** @type {string} */
    uuid = crypto.randomUUID();
    /** @type {import("#src/models/channel").Channel} */
    channel;
    /** @type {string} */
    state;
    ffmpeg;
    /** @type {RTPTransports} */
    _rtpTransports;
    /** @type {string} */
    filePath;
    /**
     * @param {import("#src/models/channel").Channel} channel
     */
    constructor(channel) {
        super();
        this.channel = channel;
        this.filePath = path.join(temp, `${this.uuid}.${RECORDING_FILE_TYPE}`);
        Recorder.records.set(this.uuid, this);
    }

    /** @returns {number} */
    get videoCount() {
        return this._rtpTransports.camera.length + this._rtpTransports.screen.length;
    }

    /**
     * @param {Array} ids
     * @returns {string} filePath
     */
    start(ids) {
        // maybe internal state and check if already recording (recording = has ffmpeg child process).
        this.stop();
        for (const id of ids) {
            const session = this.channel.sessions.get(id);
            const audioRtp = this._createRtp(
                session.producers[STREAM_TYPE.AUDIO],
                STREAM_TYPE.AUDIO
            );
            // TODO maybe some logic for priority on session id or stream type
            audioRtp && this._rtpTransports.audio.push(audioRtp);
            for (const type in [STREAM_TYPE.CAMERA, STREAM_TYPE.SCREEN]) {
                if (this.videoCount < VIDEO_LIMIT) {
                    const rtp = this._createRtp(session.producers[type], type);
                    rtp && this._rtpTransports[type].push(rtp);
                }
            }
        }
        this.ffmpeg = new FFMPEG(this.filePath);
        this.ffmpeg.spawn(); // args should be base on the rtp transports
        this.ffmpeg.once("success", () => {
            this.emit("download-ready", this.filePath);
        });
        return this.filePath;
    }
    pause() {
        // TODO maybe shouldn't be able to pause
    }
    stop() {
        // TODO
        // cleanup all rtp transports
        // stop ffmpeg process
        Recorder.records.delete(this.uuid);
    }

    /**
     * @param {http.ServerResponse} res
     */
    pipeToResponse(res) {
        // TODO check if this can be executed, otherwise end request, or throw error
        const fileStream = fs.createReadStream(this._filePath); // may need to be explicitly closed?
        res.writeHead(200, {
            "Content-Type": `video/${RECORDING_FILE_TYPE}`,
            "Content-Disposition": "inline",
        });
        fileStream.pipe(res); // Pipe the file stream to the response
    }

    /**
     * @param {import("mediasoup").types.Producer} producer
     * @param {STREAM_TYPE[keyof STREAM_TYPE]} type
     * @return {Promise<void>} probably just create transport with right ports and return that,
     */
    async _createRtp(producer, type) {
        // TODO
    }
}
