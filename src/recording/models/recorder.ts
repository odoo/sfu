import { EventEmitter } from "node:events";

import * as config from "#src/config.ts";
import { Folder } from "#src/core/services/resources.ts";
import { SessionRecorder, type RecordingStates } from "#src/recording/models/session_recorder.ts";
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
    partnerId?: number;
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
    private readonly _sessionRecorders = new Map<SessionId, SessionRecorder>();
    private readonly _sessionStops = new Set<Promise<void>>();
    private readonly _trackedVideoSessions: TrackedVideoSessions = {
        [STREAM_TYPE.CAMERA]: [],
        [STREAM_TYPE.SCREEN]: []
    };
    private _transition?: Promise<void>;
    private _hasFailed = false;
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
     * @param [options.partnerId] - partner that started the recording
     * @param [options.transcription] - whether to generate a transcription, this flags the
     * current recording for transcription, can be changed at runtime.
     */
    start(
        options: {
            audio?: boolean;
            video?: boolean;
            partnerId?: number;
            transcription?: boolean;
        } = {}
    ) {
        return this._enqueueTransition(async () => {
            this.transcription = options.transcription ?? this.transcription;
            this.audio = options.audio ?? this.audio;
            if (this.isRecording) {
                this._emitStatus();
                return;
            }
            if (!(options.audio || options.video || options.transcription)) {
                logger.warn(
                    `Cannot start recording for ${this._channel.name}: no audio, video or transcription requested`
                );
                return;
            }
            this.isRecording = true;
            this.video = Boolean(options.video);
            this._hasFailed = false;
            this._metaData.partnerId = options.partnerId;
            this._metaData.startedAt = Date.now();
            await this._startRecording();
        });
    }

    /**
     * Record a timestamp entry and updates runtime stream gating for camera/screen streams.
     */
    mark(tag: TIME_TAG, info: TimeTagInfo, sessionRecorder: SessionRecorder) {
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
        if (this._sessionRecorders.get(info.sessionId) !== sessionRecorder) {
            return;
        }
        this._trackVideoAvailability(info.type, info.sessionId, isAvailable);
        this._enforceVideoLimits();
    }

    /**
     * @param param0
     * @param param0.save - whether to save the recording, defaults to true
     */
    stop(options: StopOptions = {}): Promise<void> {
        return this._enqueueTransition(async () => {
            if (this.isRecording) {
                await this._stop(options);
            }
        });
    }

    private _enqueueTransition(callback: () => Promise<void>) {
        const transition = this._transition ? this._transition.then(callback) : callback();
        const tail = transition
            .catch(() => undefined)
            .finally(() => {
                if (this._transition === tail) {
                    this._transition = undefined;
                }
            });
        this._transition = tail;
        return transition;
    }

    async fail(error?: unknown): Promise<void> {
        if (!this.isRecording && !this._folder) {
            return;
        }
        this._hasFailed = true;
        if (error) {
            logger.error(`Recording failed for channel ${this._channel.name}: ${error}`);
        }
        if (this.isRecording) {
            await this.stop({ save: false, stopCode: STOP_CODE.RECORDING_FAILED });
        }
    }

    private async _stop({ save = true, stopCode = STOP_CODE.USER_REQUEST }: StopOptions) {
        const startedAt = this._metaData.startedAt;
        const stoppedAt = Date.now();
        const shouldSave =
            save && (startedAt ? stoppedAt - startedAt >= config.recording.minDuration : true);
        const finalState = {
            audio: this.audio,
            video: this.video,
            transcription: this.transcription,
            stoppedAt
        };
        this.isRecording = false;
        this.audio = false;
        this.video = false;
        this.transcription = false;
        this._emitStatus(stopCode);
        logger.verbose(`terminating recorder for channel ${this._channel.name}`);
        clearTimeout(this._timeout);
        this._timeout = undefined;
        this._channel.off(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.off(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
        this._resetTrackedVideoSessions();
        const currentFolder = this._folder;
        await this._stopSessionRecorders();
        this._folder = undefined;
        const failed = this._hasFailed;
        if (failed && stopCode !== STOP_CODE.RECORDING_FAILED) {
            this._emitStatus(STOP_CODE.RECORDING_FAILED);
        }
        try {
            if (shouldSave && !failed && currentFolder) {
                await currentFolder.add(
                    config.recording.metadataFileName,
                    this._sealMetaData(finalState)
                );
                await currentFolder.move(config.recording.directory);
                this._hasFailed = false;
                return;
            }
        } catch (error) {
            logger.error(
                `Failed to finalize recording for channel ${this._channel.name}: ${error}`
            );
            this._emitStatus(STOP_CODE.RECORDING_FAILED);
        } finally {
            this._metaData.timeStamps = [];
            this._metaData.partnerId = undefined;
            this._metaData.startedAt = undefined;
            this._metaData.labels = {};
        }
        await currentFolder?.delete();
        this._hasFailed = false;
    }

    private _sealMetaData({
        audio,
        video,
        transcription,
        stoppedAt
    }: {
        audio: boolean;
        video: boolean;
        transcription: boolean;
        stoppedAt: number;
    }) {
        const metadata = JSON.stringify({
            ...this._metaData,
            audio,
            video,
            transcription,
            channelKey: this._channel.key?.toString("base64") ?? "",
            stoppedAt
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
        this._stopSessionRecorder(id);
        this._removeTrackedVideoSession(id);
        this._metaData.labels[id] = session.label || "unknown";
        this._sessionRecorders.set(
            session.id,
            new SessionRecorder(this, session, this._getRecordingStates())
        );
        this._enforceVideoLimits();
    }

    private _onSessionLeave(id: SessionId) {
        this._stopSessionRecorder(id);
        this._removeTrackedVideoSession(id);
        this._enforceVideoLimits();
    }

    private _stopSessionRecorder(id: SessionId) {
        const sessionRecorder = this._sessionRecorders.get(id);
        if (!sessionRecorder) {
            return;
        }
        this._sessionRecorders.delete(id);
        const stopPromise = sessionRecorder.stop().catch((error) => {
            logger.error(`Failed to stop recorder for session ${id}: ${error}`);
            void this.fail(error).catch((failure) => {
                logger.error(`Failed to stop recording after session ${id} failure: ${failure}`);
            });
        });
        void stopPromise.finally(() => {
            this._sessionStops.delete(stopPromise);
        });
        this._sessionStops.add(stopPromise);
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

    private async _startRecording() {
        try {
            await this._start();
            this._emitStatus();
        } catch (error) {
            let stopOptions: StopOptions;
            if (error instanceof DiskSpaceLimitReachedError) {
                logger.warn(
                    `Recording blocked for ${this._channel.name}: insufficient available disk space`
                );
                stopOptions = {
                    save: false,
                    stopCode: STOP_CODE.DISK_SPACE_EXHAUSTED
                };
            } else {
                logger.error(`Failed to start recording for ${this._channel.name}: ${error}`);
                stopOptions = {
                    save: false,
                    stopCode: STOP_CODE.RECORDING_FAILED
                };
            }
            await this._stop(stopOptions);
        }
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
            for (const type of [STREAM_TYPE.CAMERA, STREAM_TYPE.SCREEN] as const) {
                const producer = session.producers[type];
                if (producer && !producer.paused) {
                    this._trackVideoAvailability(type, sessionId, true);
                }
            }
            this._sessionRecorders.set(
                sessionId,
                new SessionRecorder(this, session, this._getRecordingStates())
            );
        }
        this._enforceVideoLimits();
        this._channel.on(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.on(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
    }

    private async _stopSessionRecorders() {
        for (const id of this._sessionRecorders.keys()) {
            this._stopSessionRecorder(id);
        }
        await Promise.all(this._sessionStops);
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
        if (!available && index !== -1) {
            trackedSessions.splice(index, 1);
        } else if (available && index === -1) {
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

    private _getAllowedSessions(sessions: SessionId[], limit: number) {
        if (limit <= 0 || sessions.length === 0) {
            return new Set<SessionId>();
        }
        return new Set(sessions.slice(-limit));
    }

    /**
     * Applies the configured camera/screen limits to all session recorders
     */
    private _enforceVideoLimits() {
        const screensSessions = this._trackedVideoSessions[STREAM_TYPE.SCREEN];
        // Screen streams always take precedence over camera streams because screen sharing
        // contain important visual information, if we only showed a small screen share it would
        // be hard to see
        const hasScreenSharing = screensSessions.length > 0;
        // When screens are present, only the latest `screenLimit` screen sessions are allowed.
        const allowedScreenSessions = hasScreenSharing
            ? this._getAllowedSessions(screensSessions, config.recording.screenLimit)
            : new Set<SessionId>();
        // When screens are present, all cameras are hidden
        // When no screens are present, only the latest `cameraLimit` camera session are allowed
        const allowedCameraSessions = hasScreenSharing
            ? new Set<SessionId>()
            : this._getAllowedSessions(
                  this._trackedVideoSessions[STREAM_TYPE.CAMERA],
                  config.recording.cameraLimit
              );

        for (const [sessionId, sessionRecorder] of this._sessionRecorders) {
            sessionRecorder.setAllowed(STREAM_TYPE.CAMERA, allowedCameraSessions.has(sessionId));
            sessionRecorder.setAllowed(STREAM_TYPE.SCREEN, allowedScreenSessions.has(sessionId));
        }
    }
}
