import { EventEmitter } from "node:events";

import * as config from "#src/config.ts";
import { Folder } from "#src/core/services/resources.ts";
import { RecordingTask, type RecordingStates } from "#src/recording/models/recording_task.ts";
import { encrypt } from "#src/core/services/auth.ts";
import { Logger } from "#src/utils/utils.ts";
import { DiskSpaceLimitReachedError } from "#src/utils/errors.ts";
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
    RECORDING_FAILED = "recording_failed",
    DISK_SPACE_EXHAUSTED = "disk_space_exhausted"
}

const logger = new Logger("RECORDER");
type LimitedVideoStreamType = STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN;
type TrackedVideoSessions = {
    [STREAM_TYPE.CAMERA]: SessionId[];
    [STREAM_TYPE.SCREEN]: SessionId[];
};

/**
 * The recorder generates a "raw" file bundle, of recordings of individual
 * audio and video streams, accompanied with a metadata file describing the
 * recording (timestamps, ids,...).
 */
export class Recorder extends EventEmitter {
    static readonly Events = {
        UPDATE: "update"
    } as const;
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
    private readonly _trackedVideoSessions: TrackedVideoSessions = {
        [STREAM_TYPE.CAMERA]: [],
        [STREAM_TYPE.SCREEN]: []
    };
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
     * @param [options.audio] - whether to generate an audio file
     * @param [options.video] - whether to generate a video file
     * @param [options.transcription] - whether to generate a transcription, this flags the
     * current recording for transcription, can be changed at runtime.
     */
    async start(options: { audio?: boolean; video?: boolean; transcription?: boolean } = {}) {
        this.transcription = options.transcription ?? this.transcription;
        this.audio = options.audio ?? this.audio;
        if (this.isRecording) {
            this._emitStatus();
            return;
        }
        if (!(options.audio || options.video || options.transcription)) {
            // TODO handle when we only have video
            logger.warn(
                `Cannot start recording for ${this._channel.name}: no audio, video or transcription requested`
            );
            return;
        }
        this.isRecording = true;
        this.video = Boolean(options.video);
        this._metaData.startedAt = Date.now();

        try {
            await this._start();
            this._emitStatus();
        } catch (error) {
            if (error instanceof DiskSpaceLimitReachedError) {
                logger.warn(
                    `Recording blocked for ${this._channel.name}: insufficient available disk space`
                );
                await this.stop({ save: false, stopCode: STOP_CODE.DISK_SPACE_EXHAUSTED });
            } else {
                logger.error(`Failed to start recording for ${this._channel.name}: ${error}`);
                await this.stop({ save: false, stopCode: STOP_CODE.RECORDING_FAILED });
            }
        }
    }

    /**
     * Record a timestamp entry and updates runtime stream gating for camera/screen streams.
     */
    mark(tag: TIME_TAG, info: TimeTagInfo) {
        const available = info.eof ? false : info.available;
        const isAvailable = available === true;
        this._metaData.timeStamps.push({
            tag,
            timestamp: Date.now(),
            info: {
                ...info,
                available: isAvailable
            }
        } as TimeStampData);
        if (tag !== TIME_TAG.FILE_STATE_CHANGE) {
            return;
        }
        if (info.type !== STREAM_TYPE.CAMERA && info.type !== STREAM_TYPE.SCREEN) {
            return;
        }
        this._trackVideoAvailability(info.type, info.sessionId, isAvailable);
        this._enforceVideoLimits();
    }

    /**
     * @param param0
     * @param param0.save - whether to save the recording
     */
    async stop({ save = true, stopCode = STOP_CODE.USER_REQUEST }: StopOptions = {}) {
        if (!this.isRecording) {
            return;
        }
        const startedAt = this._metaData.startedAt;
        const shouldSave =
            save && (startedAt ? Date.now() - startedAt >= config.recording.minDuration : true);
        const finalState = {
            audio: this.audio,
            video: this.video,
            transcription: this.transcription
        };
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
        const sealedMetadata = shouldSave ? this._sealMetaData(finalState) : undefined;
        this._metaData.timeStamps = [];
        this._metaData.startedAt = undefined;
        this._metaData.labels = {};
        this._resetTrackedVideoSessions();
        const currentFolder = this._folder;
        this._folder = undefined;
        const results = await this._stopRecordingTasks();
        const failed = results.some((result) => result.status === "rejected");
        if (shouldSave && !failed && currentFolder) {
            try {
                await currentFolder.add(config.recording.metadataFileName, sealedMetadata!);
                await currentFolder.move(config.recording.directory);
                return;
            } catch (error) {
                logger.error(
                    `Failed to finalize recording for channel ${this._channel.name}: ${error}`
                );
            }
        }
        await currentFolder?.delete();
    }

    /**
     * Adds the final entries to the metadata, encrypts it and resets its state.
     *
     * @returns encrypted metadata
     */
    private _sealMetaData({
        audio,
        video,
        transcription
    }: {
        audio: boolean;
        video: boolean;
        transcription: boolean;
    }) {
        const metadata = JSON.stringify({
            ...this._metaData,
            audio,
            video,
            transcription,
            channelKey: this._channel.key,
            stoppedAt: Date.now()
        });
        /**
         * As the metadata can contain sensitive information,
         * like routing information or the channel key,
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
        if (this._hasTrackedVideoSessions()) {
            this._enforceVideoLimits();
        }
    }

    private _onSessionLeave(id: SessionId) {
        const task = this._tasks.get(id);
        if (task) {
            task.stop();
            this._tasks.delete(id);
        }
        this._removeTrackedVideoSession(id);
        this._enforceVideoLimits();
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
        this._resetTrackedVideoSessions();
        this._folder = await Folder.create(`${Date.now()}-${this._channel.uuid}`, [
            "audio",
            "camera",
            "screen"
        ]);
        clearTimeout(this._timeout);
        this._timeout = setTimeout(() => {
            this.stop({ stopCode: STOP_CODE.RECORDING_TIMEOUT });
        }, config.recording.maxDuration);
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
            audio: this.isRecording, // we always record audio as transcription can be requested at any time.
            camera: this.isRecording && this.video,
            screen: this.isRecording && this.video
        };
    }

    /**
     * Updates the recency-ordered list of available sessions for a given video type.
     *
     * The list behaves like an ordered set:
     * - A session appears at most once.
     * - Re-availability moves the session to the end (most recent).
     * - Unavailability removes the session.
     */
    private _trackVideoAvailability(
        type: LimitedVideoStreamType,
        sessionId: SessionId,
        available: boolean
    ) {
        const trackedSessions = this._trackedVideoSessions[type];
        const index = trackedSessions.indexOf(sessionId);
        if (index !== -1) {
            trackedSessions.splice(index, 1);
        }
        if (available) {
            trackedSessions.push(sessionId);
        }
    }

    private _removeTrackedVideoSession(sessionId: SessionId) {
        this._trackVideoAvailability(STREAM_TYPE.CAMERA, sessionId, false);
        this._trackVideoAvailability(STREAM_TYPE.SCREEN, sessionId, false);
    }

    private _resetTrackedVideoSessions() {
        this._trackedVideoSessions[STREAM_TYPE.CAMERA].length = 0;
        this._trackedVideoSessions[STREAM_TYPE.SCREEN].length = 0;
    }

    private _hasTrackedVideoSessions() {
        return (
            this._trackedVideoSessions[STREAM_TYPE.CAMERA].length > 0 ||
            this._trackedVideoSessions[STREAM_TYPE.SCREEN].length > 0
        );
    }

    private _getAllowedSessions(sessions: SessionId[], limit: number) {
        if (limit <= 0 || sessions.length === 0) {
            return new Set<SessionId>();
        }
        return new Set(sessions.slice(-limit));
    }

    /**
     * Applies the configured camera/screen limits across all current recording tasks.
     *
     * Policy:
     * - Screen streams always take precedence over camera streams.
     * - When screens are present, only the latest `screenLimit` screen sessions are allowed,
     *   and all cameras are disallowed.
     * - When no screens are present, only the latest `cameraLimit` camera sessions are allowed.
     *
     * A non-positive limit is treated as "allow none" for that stream category.
     */
    private _enforceVideoLimits() {
        const screens = this._trackedVideoSessions[STREAM_TYPE.SCREEN];
        const hasScreenSharing = screens.length > 0;
        const allowedScreenSessions = hasScreenSharing
            ? this._getAllowedSessions(screens, config.recording.screenLimit)
            : new Set<SessionId>();
        const allowedCameraSessions = hasScreenSharing
            ? new Set<SessionId>()
            : this._getAllowedSessions(
                  this._trackedVideoSessions[STREAM_TYPE.CAMERA],
                  config.recording.cameraLimit
              );

        for (const [sessionId, task] of this._tasks) {
            task.setAllowed(STREAM_TYPE.CAMERA, allowedCameraSessions.has(sessionId));
            task.setAllowed(STREAM_TYPE.SCREEN, allowedScreenSessions.has(sessionId));
        }
    }
}
