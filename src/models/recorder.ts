import { EventEmitter } from "node:events";
import { getFolder, type Folder } from "#src/services/resources.ts";
import { Logger } from "#src/utils/utils.ts";

import type { Channel } from "./channel";
import { FFMPEG } from "#src/models/ffmpeg.ts";

export enum RECORDER_STATE {
    STARTED = "started",
    STOPPING = "stopping",
    STOPPED = "stopped"
}
const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;
    folder: Folder | undefined;
    ffmpeg: FFMPEG | undefined;
    /** Path to which the final recording will be uploaded to */
    recordingAddress: string;
    private _state: RECORDER_STATE = RECORDER_STATE.STOPPED;

    get isRecording(): boolean {
        return this.state === RECORDER_STATE.STARTED;
    }
    get state(): RECORDER_STATE {
        return this._state;
    }
    set state(state: RECORDER_STATE) {
        this._state = state;
        this.emit("stateChange", state);
    }

    constructor(channel: Channel, recordingAddress: string) {
        super();
        this.channel = channel;
        this.recordingAddress = recordingAddress;
    }

    async start() {
        if (!this.isRecording) {
            try {
                await this._start();
            } catch {
                await this._stop();
            }
        }
        return this.isRecording;
    }

    async stop() {
        if (this.isRecording) {
            try {
                await this._stop({ save: true });
            } catch {
                logger.verbose("failed to save the recording"); // TODO maybe warn and give more info
            }
        }
        return this.isRecording;
    }

    /**
     * @param video whether we want to record videos or not (will always record audio)
     */
    private async _start({ video = true }: { video?: boolean } = {}) {
        this.state = RECORDER_STATE.STARTED;
        this.folder = getFolder();
        logger.trace(`TO IMPLEMENT: recording channel ${this.channel.name}, video: ${video}`);
        this.ffmpeg = new FFMPEG();
        // iterate all producers on all sessions of the channel, create a ffmpeg for each,
        // save them on a map by session id+type.
        // check if recording for that session id+type is already in progress
        // add listener to the channel for producer creation (and closure).
    }

    private async _stop({ save = false }: { save?: boolean } = {}) {
        this.state = RECORDER_STATE.STOPPING;
        // remove all listener from the channel
        let failure = false;
        try {
            await this.ffmpeg?.kill();
        } catch (error) {
            logger.error(`failed to kill ffmpeg: ${error}`);
            failure = true;
        }
        this.ffmpeg = undefined;
        if (save && !failure) {
            await this.folder?.seal("test-name");
        } else {
            await this.folder?.delete();
        }
        this.folder = undefined;
        this.state = RECORDER_STATE.STOPPED;
    }
}
