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
        logger.verbose(`creating FFMPEG for ${this.id} on ${this.rtp.type}`);
        this._init();
    }

    close() {
        this._isClosed = true;
        this.emit("close", this.id); // maybe different event if fail/saved properly
        this._cleanup();
    }

    private async _init() {
        await this.rtp.isReady;
        if (this._isClosed) {
            this._cleanup();
            return;
        }
        logger.trace(`To implement: FFMPEG start process ${this.id} for ${this.rtp.type}`);
        // build FFMPEG params with rtp properties, start the process
    }

    private _cleanup() {
        logger.trace(`FFMPEG ${this.id} closed for ${this.rtp.type}`);
    }
}
