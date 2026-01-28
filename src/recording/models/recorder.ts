import { EventEmitter } from "node:events";

import { recording } from "#src/config.ts";
import { Folder } from "#src/core/services/resources.ts";
import { RecordingTask, type RecordingStates } from "#src/recording/models/recording_task.ts";
import { encrypt } from "#src/core/services/auth.ts";
import { Logger } from "#src/utils/utils.ts";

import { Channel } from "#src/core/models/channel.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import type { RecordingState } from "#src/shared/types.ts";
import type { SessionId } from "#src/core/models/session.ts";

export enum TIME_TAG {
    FILE_STATE_CHANGE = "file_state_change"
}

export type TimeTagInfo = {
    filename: string;
    type: STREAM_TYPE;
    sessionId: SessionId;
    /**
     * The file lasts for the whole duration of the client producer,
     * which means that it can represent a sequence of streams,
     * with periods of inactivity (no packets). active is set to true
     * when the stream is active, which means that the recording
     * consumer is writing actual data on the file.
     */
    active: boolean;
    /**
     * Whether the stream is available, a rule may deny the recording
     * of a stream (active=false), but it may still be available
     * for recording if the rules were to change.
     */
    available: boolean;
    /**
     * marks the end of file
     */
    eof?: boolean;
};
export type TimeStampData = {
    tag: TIME_TAG;
    timestamp: number;
    info?: TimeTagInfo;
};
export type Metadata = {
    channelName: string;
    channelUUID: string;
    routingAddress: string;
    startedAt?: number;
    timeStamps: TimeStampData[];
    labels: Record<SessionId, string>;
};

export type SealedMetaData = Metadata & {
    channelKey: string;
    audio: boolean;
    video: boolean;
    startedAt: number;
    stoppedAt: number;
    transcription: boolean;
};

export type StopOptions = {
    save?: boolean;
    stopCode?: STOP_CODE;
};

export type UpdateData = {
    isRecording: boolean;
    audio: boolean;
    transcription: boolean;
    video: boolean;
    stopCode?: STOP_CODE;
};

export enum STOP_CODE {
    USER_REQUEST = "user_request",
    CHANNEL_CLOSED = "channel_closed",
    RECORDING_TIMEOUT = "recording_timeout",
    RECORDING_FAILED = "recording_failed"
}

const logger = new Logger("RECORDER");

/**
 * The recorder generates a "raw" file bundle, of recordings of individual
 * audio and video streams, accompanied with a metadata file describing the
 * recording (timestamps, ids,...).
 */
export class Recorder extends EventEmitter {
    static Events = {
        UPDATE: "update"
    };
    isRecording: boolean = false;
    /**
     * Whether audio is recorded
     */
    audio: boolean = false;
    /**
     * Whether video is recorded (camera and screen sharing)
     */
    video: boolean = false;
    /**
     * Whether transcription is desired (metadata flag)
     */
    transcription: boolean = false;
    private _folder?: Folder;
    private _timeout?: NodeJS.Timeout;
    private readonly _channel: Channel;
    private readonly _tasks = new Map<SessionId, RecordingTask>();
    private readonly _metaData: Metadata = {
        channelName: "",
        channelUUID: "",
        routingAddress: "",
        timeStamps: [],
        labels: {}
    };

    get state(): RecordingState {
        return {
            recording: this.isRecording,
            audio: this.audio,
            video: this.video,
            transcription: this.transcription
        };
    }

    get path(): string | undefined {
        return this._folder?.path;
    }

    /**
     * @param channel - the channel to record
     * @param routingAddress - the address to which the recording will be forwarded
     */
    constructor(channel: Channel, routingAddress: string) {
        super();
        this._onSessionJoin = this._onSessionJoin.bind(this);
        this._onSessionLeave = this._onSessionLeave.bind(this);
        this._channel = channel;
        this._metaData.channelName = channel.name;
        this._metaData.channelUUID = channel.uuid;
        this._metaData.routingAddress = routingAddress;
    }

    /**
     * Can be called again even if it has started to update the transcription state,
     * this applies to the whole recording.
     *
     * @param [options={}]
     * @param [options.video] - whether to record video
     * @param [options.transcription] - whether to transcribe the recording, this flags the
     * current recording for transcription, can be changed at runtime.
     */
    async start(options: { audio?: boolean; video?: boolean; transcription?: boolean } = {}) {
        this.transcription = Boolean(options.transcription);
        if (this.isRecording) {
            this._emitStatus();
            return;
        }
        this.isRecording = true;
        this.audio = Boolean(options.audio);
        this.video = Boolean(options.video);
        this._metaData.startedAt = Date.now();

        try {
            await this._start();
            this._emitStatus();
        } catch (error) {
            // if error is memory type (see resources), close code should be memory_full or something
            // then the channel may disable the feature until the resource is available again?
            // something like resourceService.diskAvailable < config.recording.expectedSize becoming a condition for "can record"?
            logger.error(`Failed to start recording for ${this._channel.name}: ${error}`);
            this.stop({ save: false, stopCode: STOP_CODE.RECORDING_FAILED });
        }
    }

    mark(tag: TIME_TAG, info: TimeTagInfo) {
        this._metaData.timeStamps.push({
            tag,
            timestamp: Date.now(),
            info
        } as TimeStampData);
        /**
         * TODO, version 2.
         *
         * Enforce config.recording.cameraLimit and config.recording.screenLimit.
         * screen limit is at 1:
         *
         * A recording that has multiple screen share is not useful, as the
         * content of the screen may become unreadable due to the lowered resolution.
         * Thus, a logic that decides which screen share to keep, and that stops
         * the recording of the superfluous streams (other cameras and screens)
         * should be implemented.
         *
         * When recording video, we should
         * only record the latest x screens, and record cameras only if there is no
         * screen being shared (and only up to the limit). That is because in the compiled
         * version, the screen takes precedence over the camera, and all the visual space.
         * That is because when a screen is shared it should be the focus of the attention
         * and is only useful when taking all of the visual space (it wouldn't make
         * sense to divide the space available in the final video between multiple
         * screens, or between screens and cameras).
         *
         * Therefore a mechanism to track the latest screens/cameras produced should be
         * implemented. We can extract that information from the
         * TIME_TAG.FILE_STATE_CHANGE events, where `type` and `available` is all
         * we need to know when and if a screen or a camera is being shared, then we can
         * control which streams are recorded by swapping the "allowed" flag of the MediaOutput
         * of each stream.
         *
         * example: someone starts screen sharing => his session id is added to a stack of screensharing sessions
         *          someone starts camera sharing => his session id is added to a stack of camerasharing sessions
         * if screen sharing stack is not empty, then all camera have allowed set to false. and only the last N
         * (config.recording.screenLimit) have the allowed flag for their screen share.
         * if screen sharing stack is empty, then we can consider cameras, and only the N
         * (config.recording.cameraLimit) have the allowed flag for their camera share.
         *
         * A new nechanism to control that allowed flag should be implemented, similar to _getRecordingStates
         * but it's not the same as it acts in parallel and does not cut the output (otherwise we couldn't know
         * if a stream becomes available if it is not allowed, that's what dinstinguishes allowed and active)
         */
    }

    /**
     * @param param0
     * @param param0.save - whether to save the recording
     */
    async stop({ save = true, stopCode = STOP_CODE.USER_REQUEST }: StopOptions = {}) {
        if (!this.isRecording) {
            return;
        }
        this.isRecording = false;
        this.audio = false;
        this.video = false;
        this.transcription = false;
        this._emitStatus(stopCode);
        // At this point we may wait a few minutes / seconds in case they want to
        // restart the recording, they we just restore the current one.
        logger.verbose(`terminating recorder for channel ${this._channel.name}`);
        clearTimeout(this._timeout);
        this._timeout = undefined;
        this._channel.off(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.off(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
        const metaData = save ? this._sealMetaData() : undefined;
        this._metaData.timeStamps = [];
        this._metaData.startedAt = undefined;
        this._metaData.labels = {};
        const currentFolder = this._folder;
        this._folder = undefined;
        const results = await this._stopRecordingTasks();
        const failed = results.some((result) => result.status === "rejected");
        if (save && !failed && currentFolder) {
            currentFolder.add(recording.metadataFileName, metaData!);
            currentFolder.move(recording.directory);
        } else {
            currentFolder?.delete();
        }
    }

    /**
     * Adds the final entries to the metadata, encrypts it and resets its state.
     *
     * @returns encrypted metadata
     */
    private _sealMetaData() {
        const metadata = JSON.stringify({
            ...this._metaData,
            audio: this.audio,
            video: this.video,
            transcription: this.transcription,
            channelKey: this._channel.key,
            stoppedAt: Date.now()
        });
        /**
         * As the metadata can contain sensitive information,
         * like routing with tokens, or the channel key,
         * or information (names) on the call participants,
         * it is encrypted before being saved on the disk.
         */
        return encrypt(metadata);
    }

    private _onSessionJoin(id: SessionId) {
        const session = this._channel.sessions.get(id);
        if (!session) {
            return;
        }
        this._metaData.labels[id] = session.label || "unknown";
        this._tasks.set(session.id, new RecordingTask(this, session, this._getRecordingStates()));
    }

    private _onSessionLeave(id: SessionId) {
        const task = this._tasks.get(id);
        if (task) {
            task.stop();
            this._tasks.delete(id);
        }
    }

    private _emitStatus(stopCode?: STOP_CODE) {
        this.emit(Recorder.Events.UPDATE, {
            isRecording: this.isRecording,
            audio: this.audio,
            transcription: this.transcription,
            video: this.video,
            stopCode
        } as UpdateData);
    }
    private async _start() {
        this._folder = await Folder.create(`${Date.now()}-${this._channel.uuid}`, [
            "audio",
            "camera",
            "screen"
        ]);
        clearTimeout(this._timeout);
        this._timeout = setTimeout(() => {
            this.stop({ stopCode: STOP_CODE.RECORDING_TIMEOUT });
        }, recording.maxDuration);
        logger.verbose(`Initializing recorder for channel: ${this._channel.name}`);
        for (const [sessionId, session] of this._channel.sessions) {
            this._metaData.labels[sessionId] = session.label || "unknown";
            this._tasks.set(
                sessionId,
                new RecordingTask(this, session, this._getRecordingStates())
            );
        }
        this._channel.on(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.on(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
    }

    private async _stopRecordingTasks() {
        const proms = [];
        for (const task of this._tasks.values()) {
            proms.push(task.stop());
        }
        this._tasks.clear();
        return Promise.allSettled(proms);
    }

    private _getRecordingStates(): RecordingStates {
        return {
            audio: this.isRecording && this.audio,
            camera: this.isRecording && this.video,
            screen: this.isRecording && this.video
        };
    }
}
