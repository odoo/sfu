import { EventEmitter } from "node:events";
import { getFolder, type Folder } from "#src/services/resources.ts";
import { Logger } from "#src/utils/utils.ts";

import type { Channel } from "./channel";

export enum RECORDER_STATE {
    STARTED = "started",
    STOPPED = "stopped"
}
const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;
    folder: Folder | undefined;
    ffmpeg = null;
    /** Path to which the final recording will be uploaded to */
    recordingAddress: string;
    private _state: RECORDER_STATE = RECORDER_STATE.STOPPED;

    constructor(channel: Channel, recordingAddress: string) {
        super();
        this.channel = channel;
        this.recordingAddress = recordingAddress;
    }

    async start() {
        if (this.state === RECORDER_STATE.STOPPED) {
            this.folder = getFolder();
            this.state = RECORDER_STATE.STARTED;
            logger.trace("TO IMPLEMENT");
            // TODO ffmpeg instance creation for recording to folder.path with proper name, start, build timestamps object
        }
        this._record();
        return { state: this.state };
    }

    async stop() {
        if (this.state === RECORDER_STATE.STARTED) {
            logger.trace("TO IMPLEMENT");
            try {
                await this.folder!.seal("test-name");
            } catch {
                logger.verbose("failed to save the recording"); // TODO maybe warn and give more info
            }
            this.folder = undefined;
            // TODO ffmpeg instance stop, cleanup,
            // only resolve promise and switch state when completely ready to start a new recording.
            this.state = RECORDER_STATE.STOPPED;
        }
        return { state: this.state };
    }

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

    /**
     * @param video whether we want to record videos or not (will always record audio)
     */
    _record(video: boolean = false) {
        logger.trace(`TO IMPLEMENT: recording channel ${this.channel.name}, video: ${video}`);
        // iterate all producers on all sessions of the channel, create a ffmpeg for each,
        // save them on a map by session id+type.
        // check if recording for that session id+type is already in progress
        // add listener to the channel for producer creation (and closure).
    }
}
