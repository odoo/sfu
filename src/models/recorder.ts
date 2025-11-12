import { EventEmitter } from "node:events";

import { getFolder, type Folder } from "#src/services/resources.ts";
import { RecordingTask } from "#src/models/recording_task.ts";
import { Logger } from "#src/utils/utils.ts";

import type { Channel } from "#src/models/channel";
import type { SessionId } from "#src/models/session.ts";

export enum RECORDER_STATE {
    STARTED = "started",
    STOPPING = "stopping",
    STOPPED = "stopped"
}
const logger = new Logger("RECORDER");

export class Recorder extends EventEmitter {
    channel: Channel;
    folder: Folder | undefined;
    tasks = new Map<SessionId, RecordingTask>();
    /** Path to which the final recording will be uploaded to */
    recordingAddress: string;
    isPlainRecording: boolean = false;
    isTranscription: boolean = false;
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
        // TODO: for the transcription, we should play with isPlainRecording / isTranscription to see whether to stop or start or just disabled one of the features
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

    private async _start() {
        this.state = RECORDER_STATE.STARTED;
        this.folder = getFolder();
        logger.trace(`TO IMPLEMENT: recording channel ${this.channel.name}`);
        for (const [sessionId, session] of this.channel.sessions) {
            this.tasks.set(
                sessionId,
                new RecordingTask(session, { audio: true, camera: true, screen: true })
            );
        }
        this.channel.on("sessionJoin", (id) => {
            const session = this.channel.sessions.get(id);
            if (!session) {
                return;
            }
            this.tasks.set(
                session.id,
                new RecordingTask(session, { audio: true, camera: true, screen: true })
            );
        });
        this.channel.on("sessionLeave", (id) => {
            const task = this.tasks.get(id);
            if (task) {
                task.stop();
                this.tasks.delete(id);
            }
        });
    }

    private async _stop({ save = false }: { save?: boolean } = {}) {
        this.state = RECORDER_STATE.STOPPING;
        // remove all listener from the channel
        let failure = false;
        try {
            await this.stopTasks();
        } catch (error) {
            logger.error(`failed to kill ffmpeg: ${error}`);
            failure = true;
        }
        if (save && !failure) {
            await this.folder?.seal("test-name");
        } else {
            await this.folder?.delete();
        }
        this.folder = undefined;
        this.state = RECORDER_STATE.STOPPED;
    }

    private async stopTasks() {
        const proms = [];
        for (const task of this.tasks.values()) {
            proms.push(task.stop());
        }
        this.tasks.clear();
        await Promise.allSettled(proms);
    }
}
