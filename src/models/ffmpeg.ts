/* eslint-disable prettier/prettier */
import { EventEmitter } from "node:events";
import { Logger } from "#src/utils/utils.ts";
import { RTP } from "#src/models/rtp.ts";

const logger = new Logger("FFMPEG");

let currentId = 0;

export class FFMPEG extends EventEmitter {
    readonly id: number;
    private readonly rtp: RTP;
    private _isClosed = false;
    constructor(rtp: RTP) {
        super();
        this.rtp = rtp;
        this.id = currentId++;
        logger.trace(`creating FFMPEG for ${this.id} on ${this.rtp.type}`);
        this._init();
    }

    close() {
        this._isClosed = true;
        this._cleanup();
    }

    private async _init() {
        await this.rtp.isReady;
        if (this._isClosed) {
            this._cleanup();
            return;
        }
        logger.trace(`FFMPEG ${this.id} is ready for ${this.rtp.type}`);
    }

    private _cleanup() {
        logger.trace(`FFMPEG ${this.id} closed for ${this.rtp.type}`);
    }
}
