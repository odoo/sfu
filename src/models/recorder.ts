import { EventEmitter } from "node:events";
import path from "node:path";

import { recording } from "#src/config.ts";
import { getFolder, type Folder } from "#src/services/resources.ts";
import { RecordingTask, type RecordingStates } from "#src/models/recording_task.ts";
import { Logger } from "#src/utils/utils.ts";

import type { Channel } from "#src/models/channel";
import type { SessionId } from "#src/models/session.ts";

export enum TIME_TAG {
    RECORDING_STARTED = "recording_started",
    RECORDING_STOPPED = "recording_stopped",
    TRANSCRIPTION_STARTED = "transcription_started",
    TRANSCRIPTION_STOPPED = "transcription_stopped",
    NEW_FILE = "new_file"
}
export enum RECORDER_STATE {
    STARTED = "started",
    STOPPING = "stopping",
    STOPPED = "stopped"
}
export type Metadata = {
    forwardAddress: string;
    timeStamps: Array<{ tag: TIME_TAG; timestamp: number; value: object }>;
};

const logger = new Logger("RECORDER");

/**
 * TODO some docstring
 * The recorder generates a "raw" file bundle, of recordings of individual audio and video streams,
 * accompanied with a metadata file describing the recording (timestamps, ids,...).
 *
 * These raw recordings can then be used for further processing (transcription, compilation,...).
 *
 * Recorder acts at the channel level, managing the creation and closure of sessions in that channel,
 * whereas the recording_task acts at the session level, managing the recording of an individual session
 * and following its producer lifecycle.
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
    private _folder?: Folder;
    private readonly _channel: Channel; // TODO rename with private prefix
    private readonly _tasks = new Map<SessionId, RecordingTask>();
    /** Path to which the final recording will be uploaded to */
    private readonly _metaData: Metadata = {
        forwardAddress: "",
        timeStamps: []
    };

    get isActive(): boolean {
        return this.state === RECORDER_STATE.STARTED;
    }

    get path(): string | undefined {
        return this._folder?.path;
    }

    /**
     * @param channel - the channel to record
     * @param forwardAddress - the address to which the recording will be forwarded
     */
    constructor(channel: Channel, forwardAddress: string) {
        super();
        this._onSessionJoin = this._onSessionJoin.bind(this);
        this._onSessionLeave = this._onSessionLeave.bind(this);
        this._channel = channel;
        this._metaData.forwardAddress = forwardAddress;
    }

    async start() {
        // TODO: for the transcription, we should play with isRecording / isTranscribing to see whether to stop or start or just disabled one of the features
        if (!this.isRecording) {
            this.isRecording = true;
            this.mark(TIME_TAG.RECORDING_STARTED);
            await this._refreshConfiguration();
        }
        return this.isRecording;
    }

    async stop() {
        if (this.isRecording) {
            this.isRecording = false;
            this.mark(TIME_TAG.RECORDING_STOPPED);
            await this._refreshConfiguration();
        }
        return this.isRecording;
    }

    async startTranscription() {
        if (!this.isTranscribing) {
            this.isTranscribing = true;
            this.mark(TIME_TAG.TRANSCRIPTION_STARTED);
            await this._refreshConfiguration();
        }
        return this.isTranscribing;
    }

    async stopTranscription() {
        if (this.isTranscribing) {
            this.isTranscribing = false;
            this.mark(TIME_TAG.TRANSCRIPTION_STOPPED);
            await this._refreshConfiguration();
        }
        return this.isTranscribing;
    }

    mark(tag: TIME_TAG, value: object = {}) {
        this._metaData.timeStamps.push({
            tag,
            timestamp: Date.now(),
            value
        });
    }

    /**
     * @param param0
     * @param param0.save - whether to save the recording
     */
    async terminate({ save = false }: { save?: boolean } = {}) {
        if (!this.isActive) {
            return;
        }
        logger.verbose(`terminating recorder for channel ${this._channel.name}`);
        this._channel.off("sessionJoin", this._onSessionJoin);
        this._channel.off("sessionLeave", this._onSessionLeave);
        this.isRecording = false;
        this.isTranscribing = false;
        this.state = RECORDER_STATE.STOPPING;
        this._stopTasks(); // may want to make it async (resolve on child process close/exit) so we can wait for the end of ffmpeg, when files are no longer written on. to check.
        if (save) {
            await this._folder?.add("metadata.json", JSON.stringify(this._metaData));
            await this._folder?.seal(
                path.join(recording.directory, `${this._channel.name}_${Date.now()}`)
            );
        } else {
            await this._folder?.delete();
        }
        this._folder = undefined;
        this._metaData.timeStamps = [];
        this.state = RECORDER_STATE.STOPPED;
    }

    private _onSessionJoin(id: SessionId) {
        const session = this._channel.sessions.get(id);
        if (!session) {
            return;
        }
        this._tasks.set(session.id, new RecordingTask(this, session, this._getRecordingStates()));
    }

    private _onSessionLeave(id: SessionId) {
        const task = this._tasks.get(id);
        if (task) {
            task.stop();
            this._tasks.delete(id);
        }
    }

    private async _refreshConfiguration() {
        if (this.isRecording || this.isTranscribing) {
            if (this.isActive) {
                await this._update().catch(async () => {
                    logger.warn(`Failed to update recording or ${this._channel.name}`);
                    await this.terminate();
                });
            } else {
                await this._init().catch(async () => {
                    logger.error(`Failed to start recording or ${this._channel.name}`);
                    await this.terminate();
                });
            }
        } else {
            await this.terminate({ save: true }); // todo check if we always want to save here
        }
        this.emit("update", { isRecording: this.isRecording, isTranscribing: this.isTranscribing });
    }

    private async _update() {
        const params = this._getRecordingStates();
        for (const task of this._tasks.values()) {
            Object.assign(task, params);
        }
    }

    private async _init() {
        this.state = RECORDER_STATE.STARTED;
        this._folder = await getFolder();
        logger.verbose(`Initializing recorder for channel: ${this._channel.name}`);
        for (const [sessionId, session] of this._channel.sessions) {
            this._tasks.set(
                sessionId,
                new RecordingTask(this, session, this._getRecordingStates())
            );
        }
        this._channel.on("sessionJoin", this._onSessionJoin);
        this._channel.on("sessionLeave", this._onSessionLeave);
    }

    private _stopTasks() {
        for (const task of this._tasks.values()) {
            task.stop();
        }
        this._tasks.clear();
    }

    private _getRecordingStates(): RecordingStates {
        return {
            audio: this.isRecording || this.isTranscribing,
            camera: this.isRecording,
            screen: this.isRecording
        };
    }
}
