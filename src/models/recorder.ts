import {EventEmitter} from "node:events";
import type { Channel } from "./channel";
import {Logger} from "#src/utils/utils.ts";

const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;

    constructor(channel: Channel) {
        super();
        this.channel = channel;
    }

    todo() {
        logger.warn("TODO: Everything");
    }
}
