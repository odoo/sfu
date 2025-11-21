import { EventEmitter } from "node:events";

import { getFolder, type Folder } from "#src/services/resources.ts";
import { RecordingTask, type RecordingParameters } from "#src/models/recording_task.ts";
import { Logger } from "#src/utils/utils.ts";

import type { Channel } from "#src/models/channel";
import type { SessionId } from "#src/models/session.ts";

enum TIME_TAG {
    RECORDING_STARTED = "recording_started",
    RECORDING_STOPPED = "recording_stopped",
    TRANSCRIPTION_STARTED = "transcription_started",
    TRANSCRIPTION_STOPPED = "transcription_stopped"
}
export enum RECORDER_STATE {
    STARTED = "started",
    STOPPING = "stopping",
    STOPPED = "stopped"
}
export type Metadata = {
    uploadAddress: string;
    timeStamps: object;
};

const logger = new Logger("RECORDER");

/**
 * TODO some docstring
 * The recorder generates a "raw" file bundle, of recordings of individual audio and video streams,
 * accompanied with a metadata file describing the recording (timestamps, ids,...).
 *
 * These raw recordings can then be used for further processing (transcription, compilation,...).
 */
export class Recorder extends EventEmitter {
    /**
     * Plain recording means that we mark the recording to be saved as a audio/video file
     **/
    isRecording: boolean = false;
    /**
     * Transcribing means that we mark the audio for being transcribed later,
     * this captures only the audio of the call.
     **/
    isTranscribing: boolean = false;
    state: RECORDER_STATE = RECORDER_STATE.STOPPED;
    private folder?: Folder;
    private readonly channel: Channel;
    private readonly tasks = new Map<SessionId, RecordingTask>();
    /** Path to which the final recording will be uploaded to */
    private readonly metaData: Metadata = {
        uploadAddress: "",
        timeStamps: {}
    };

    get isActive(): boolean {
        return this.state === RECORDER_STATE.STARTED;
    }

    constructor(channel: Channel, recordingAddress: string) {
        super();
        this.channel = channel;
        this.metaData.uploadAddress = recordingAddress;
    }

    async start() {
        // TODO: for the transcription, we should play with isRecording / isTranscribing to see whether to stop or start or just disabled one of the features
        if (!this.isRecording) {
            this.isRecording = true;
            await this._refreshConfiguration();
            this._mark(TIME_TAG.RECORDING_STARTED);
        }
        return this.isRecording;
    }

    async stop() {
        if (this.isRecording) {
            this.isRecording = false;
            await this._refreshConfiguration();
            this._mark(TIME_TAG.RECORDING_STOPPED);
        }
        return this.isRecording;
    }

    async startTranscription() {
        if (!this.isTranscribing) {
            this.isTranscribing = true;
            await this._refreshConfiguration();
            this._mark(TIME_TAG.TRANSCRIPTION_STARTED);
        }
        return this.isTranscribing;
    }

    async stopTranscription() {
        if (this.isTranscribing) {
            this.isTranscribing = false;
            await this._refreshConfiguration();
            this._mark(TIME_TAG.TRANSCRIPTION_STOPPED);
        }
        return this.isTranscribing;
    }

    async terminate({ save = false }: { save?: boolean } = {}) {
        if (!this.isActive) {
            return;
        }
        this.channel.off("sessionJoin", this._onSessionJoin);
        this.channel.off("sessionLeave", this._onSessionLeave);
        this.isRecording = false;
        this.isTranscribing = false;
        this.state = RECORDER_STATE.STOPPING;
        // TODO name
        const name = "test-folder-name";
        const results = await this._stopTasks();
        const hasFailure = results.some((r) => r.status === "rejected");
        if (save && !hasFailure) {
            // TODO turn this.metadata to JSON, then add it as a file in the folder.
            await this.folder?.seal(name);
        } else {
            logger.error(`failed at generating recording: ${name}`);
            await this.folder?.delete();
        }
        this.folder = undefined;
        this.metaData.timeStamps = {};
        this.state = RECORDER_STATE.STOPPED;
    }

    private _onSessionJoin(id: SessionId) {
        const session = this.channel.sessions.get(id);
        if (!session) {
            return;
        }
        this.tasks.set(session.id, new RecordingTask(session, this._getTaskParameters()));
    }

    private _onSessionLeave(id: SessionId) {
        const task = this.tasks.get(id);
        if (task) {
            task.stop();
            this.tasks.delete(id);
        }
    }

    private _mark(tag: TIME_TAG) {
        logger.trace(`TO IMPLEMENT: mark ${tag}`);
        // TODO we basically add an entry to the timestamp object.
    }

    private async _refreshConfiguration() {
        if (this.isRecording || this.isTranscribing) {
            if (this.isActive) {
                await this._update().catch(async () => {
                    logger.warn(`Failed to update recording or ${this.channel.name}`);
                    await this.terminate();
                });
            } else {
                await this._init().catch(async () => {
                    logger.error(`Failed to start recording or ${this.channel.name}`);
                    await this.terminate();
                });
            }
        } else {
            await this.terminate();
        }
        this.emit("update", { isRecording: this.isRecording, isTranscribing: this.isTranscribing });
    }

    private async _update() {
        const params = this._getTaskParameters();
        for (const task of this.tasks.values()) {
            Object.assign(task, params);
        }
    }

    private async _init() {
        this.state = RECORDER_STATE.STARTED;
        this.folder = getFolder();
        logger.trace(`TO IMPLEMENT: recording channel ${this.channel.name}`);
        for (const [sessionId, session] of this.channel.sessions) {
            this.tasks.set(sessionId, new RecordingTask(session, this._getTaskParameters()));
        }
        this.channel.on("sessionJoin", this._onSessionJoin);
        this.channel.on("sessionLeave", this._onSessionLeave);
    }

    private async _stopTasks() {
        const proms = [];
        for (const task of this.tasks.values()) {
            proms.push(task.stop());
        }
        this.tasks.clear();
        return Promise.allSettled(proms);
    }

    private _getTaskParameters(): RecordingParameters {
        return {
            audio: this.isRecording || this.isTranscribing,
            camera: this.isRecording,
            screen: this.isRecording
        };
    }
}
