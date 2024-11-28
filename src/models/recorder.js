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
    UPDATING: "UPDATING",
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
    _destination;
    /** @type {number} */
    _limitTimeout;
    /** @type {string[]} */
    _tempFilePathAccumulator = [];
    /** @type {RECORDER_STATE[keyof RECORDER_STATE]} */
    _state = RECORDER_STATE.IDLE;

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
     */
    async start(ids) {
        if (this.ffmpeg) {
            logger.debug("Already recording");
            return;
        }
        this._limitTimeout = setTimeout(() => {
            this.upload();
        }, recording.maxDuration);
        this.uuid = crypto.randomUUID();
        return this._start_fragment(ids);
    }

    async _start_fragment(ids) {
        const oldProcess = this.ffmpeg;
        this.state = RECORDER_STATE.UPDATING;
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
        const tempPath = path.join(recording.directory, `call_${Date.now()}.${recording.fileType}`);
        this.ffmpeg = new FFMPEG(tempPath);
        try {
            await this.ffmpeg.spawn(audioRtps, videoRtps); // args should be base on the rtp transports
            this.state = RECORDER_STATE.RECORDING;
        } catch (error) {
            logger.error(`Failed to start recording: ${error.message}`);
            this.stop();
        }
        oldProcess?.kill();
        this._tempFilePathAccumulator.push(tempPath);
    }

    async update(ids) {
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
        await this._start_fragment(ids);
    }
    stop() {
        this.ffmpeg?.kill();
        this.uuid = undefined;
        this.ffmpeg = undefined;
        this._tempFilePathAccumulator = []; // TODO probably also delete all files here
        clearTimeout(this._limitTimeout);
        this.state = RECORDER_STATE.IDLE;
    }

    /**
     * @fires Recorder#ready
     */
    async upload() {
        const filePaths = this._tempFilePathAccumulator;
        this.stop();
        if (!this._destination) {
            logger.warn(`No upload destination set for ${this.uuid}`);
            return;
        }
        this.state = RECORDER_STATE.UPLOADING;
        let filePath;
        if (filePaths.length === 1) {
            filePath = filePaths[0];
        } else {
            filePath = await this._mergeFiles(filePaths);
        }
        Recorder.generatedFiles.set(this.uuid, filePath);
        /**
         * @event Recorder#ready
         * @type {string} `filePath`
         */
        this.emit("ready", filePath);
        const fileStream = fs.createReadStream(filePath);
        const { hostname, pathname, protocol } = new URL(this._destination);
        const options = {
            hostname,
            path: pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": fs.statSync(filePath).size,
            },
        };
        // TODO implement the route and route-passing in odoo/discuss
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
        this.state = RECORDER_STATE.IDLE;
    }

    /**
     * @param {string[]} filePaths
     */
    async _mergeFiles(filePaths) {
        // TODO
        return filePaths[1];
    }
}
