import { EventEmitter } from "node:events";
import type { Channel } from "./channel";
import { getFolder } from "#src/services/resources.ts";
import { Logger } from "#src/utils/utils.ts";

export enum RECORDER_STATE {
    STARTED = "started",
    STOPPED = "stopped",
}
const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;
    state: RECORDER_STATE = RECORDER_STATE.STOPPED;
    ffmpeg = null;
    destPath: string | undefined;
    /** Path to which the final recording will be uploaded to */
    recordingAddress: string;

    constructor(channel: Channel, recordingAddress: string) {
        super();
        this.channel = channel;
        this.recordingAddress = recordingAddress;
    }

    async start() {
        if (this.state === RECORDER_STATE.STOPPED) {
            const { path, sealFolder }  = getFolder();
            this.destPath = path;
            this.once("stopped", sealFolder);
            this.state = RECORDER_STATE.STARTED;
             logger.trace("TO IMPLEMENT");
             // TODO ffmpeg instance creation for recording to destPath with proper name, start, build timestamps object
        }

        return { state: this.state };
    }

    async stop() {
        if (this.state === RECORDER_STATE.STARTED) {

            logger.trace("TO IMPLEMENT");
            this.emit("stopped");
            // TODO ffmpeg instance stop, cleanup,
            // only resolve promise and switch state when completely ready to start a new recording.
            this.state = RECORDER_STATE.STOPPED;
        }

        return { state: this.state };
    }
}
