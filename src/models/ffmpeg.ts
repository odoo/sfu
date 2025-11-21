/* eslint-disable prettier/prettier */
import { EventEmitter } from "node:events";
import { Logger } from "#src/utils/utils.ts";
import type { STREAM_TYPE } from "#src/shared/enums.ts";

const logger = new Logger("FFMPEG");

// TODO may need to give more or less stuff here, will know later.
export type RtpData = {
    payloadType: number;
    clockRate: number;
    codec: string;
    channels: number | undefined;
    type: STREAM_TYPE;
};

let currentId = 0;

export class FFMPEG extends EventEmitter {
    readonly id: number;
    private readonly rtp: RtpData;
    constructor(rtp: RtpData) {
        super();
        this.rtp = rtp;
        this.id = currentId++;
        logger.trace(`creating FFMPEG for ${this.id} on ${this.rtp.type}`);
    }

    async kill() {
    }
}
