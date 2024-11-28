import path from "node:path";
import fs from "node:fs";
import * as https from "node:https";
import http from "node:http";
import { EventEmitter } from "node:events"; // TODO remove if unnecessary

import { Logger } from "#src/utils/utils.js";
import { STREAM_TYPE } from "#src/shared/enums.js";
import { FFMPEG } from "#src/utils/ffmpeg.js";
import { recording } from "#src/config.js";
import * as config from "#src/config.js";

const logger = new Logger("RECORDER");

export const RECORDER_STATE = {
    IDLE: "IDLE",
    RECORDING: "RECORDING",
    UPLOADING: "UPLOADING",
};

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

export class Recorder extends EventEmitter {
    /** @type {Map<string, string>} */
    static generatedFiles = new Map();
    /** @type {string} */
    uuid;
    /** @type {import("#src/models/channel").Channel} */
    channel;
    /** @type {FFMPEG} */
    ffmpeg;
    /** @type {string} */
    filePath;
    /** @type {string} */
    _destination;
    /** @type {number} */
    _limitTimeout;
    /** @type {RECORDER_STATE[keyof RECORDER_STATE]} */
    _state = RECORDER_STATE.IDLE;
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

    /**
     * @param {RECORDER_STATE[keyof RECORDER_STATE]} state
     * @fires Recorder#stateChange
     */
    set state(state) {
        this._state = state;
        /**
         * stateChange event.
         * @event Recorder#stateChange
         * @type {string} `RECORDER_STATE`
         */
        this.emit("stateChange", state);
    }

    /**
     * @param {Array} ids TODO may specify more than just ids, maybe we want specific streams. could be some tuple [id, mediaTypes]
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
            await this.ffmpeg.spawn(audioRtps, videoRtps); // args should be base on the rtp transports
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
        /** TODO see if ffmpeg input can be re-configured at runtime, otherwise full restart
         * Possibilities for hot-swap:
         * - ffmpeg stdin is writable, so it may be possible to write new sdp (with new inputs) to it
         * - could see if the consumer of the RtpTransport can be swapped at runtime, in which case, RtpTransport should
         *   be owned by the Recorder (4 RtpTransport per recorder, and consume on demand).
         * If hot-swap is not possible:
         *   Kill the ffmpeg process and register the path in a queue (array).
         *   Keep killing and starting processes as update is called,
         *   kill should happen as late as possible (when next process has started) to avoid losses.
         *   When "upload" is called, first use ffmpeg again to merge all the files in the queue.
         *   then upload that real file. (if queue.length === 1, just upload that file).
         */
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
