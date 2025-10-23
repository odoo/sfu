import {EventEmitter} from "node:events";
import type { Channel } from "./channel";
import {Logger} from "#src/utils/utils.ts";

const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;
    state: "started" | "stopped" = "stopped";
    ffmpeg = null;
    /** Path to which the final recording will be uploaded to */
    recordingAddress: string;

    constructor(channel: Channel, recordingAddress: string) {
        super();
        this.channel = channel;
        this.recordingAddress = recordingAddress;
    }

    async start() {
        this.state = "started";
        logger.trace("TO IMPLEMENT");
        // TODO ffmpeg instance creation, start
        return { state: this.state };
    }

    async stop() {
        this.state = "stopped";
        logger.trace("TO IMPLEMENT");
        // TODO ffmpeg instance stop, cleanup, save,...
        return { state: this.state };
    }
}
