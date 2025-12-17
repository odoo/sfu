import path from "node:path";
import { EventEmitter } from "node:events";

import { recording } from "#src/config.ts";
import { getFolder, type Folder } from "#src/services/resources.ts";
import { RecordingTask, type RecordingStates } from "#src/models/recording/recording_task.ts";
import { sign } from "#src/services/auth.ts";
import { Logger } from "#src/utils/utils.ts";

import { Channel } from "#src/models/channel.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import type { RecordingState } from "#src/shared/types.ts";
import type { SessionId } from "#src/models/session.ts";

export enum TIME_TAG {
    FILE_STATE_CHANGE = "file_state_change"
}
export enum RECORDER_STATE {
    STARTED = "started",
    STOPPING = "stopping",
    STOPPED = "stopped"
}
export type TimeTagInfo = {
    filename: string;
    type: STREAM_TYPE;
    /**
     * The file lasts for the whole duration of the client producer, which means that
     * it can represent a sequence of streams, with periods of inactivity (no packets).
     * active is set to true when the stream is active, which means that the producer is
     * actively broadcasting data, and false when it is not.
     */
    active: boolean;
    /**
     * marks the end of file, could instead of active: undefined/null, but not clear.
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
    routingAddress: string;
    startedAt?: number;
    stoppedAt?: number;
    timeStamps: TimeStampData[];
};

export type SealedMetaData = Metadata & {
    sealedAt: number;
    routingJwt: string;
    video: boolean;
    transcription: boolean;
};

const logger = new Logger("RECORDER");

/**
 * The recorder generates a "raw" file bundle, of recordings of individual
 * audio and video streams, accompanied with a metadata file describing the
 * recording (timestamps, ids,...).
 *
 * These raw recordings can then be used for further processing (transcription, compilation,...).
 *
 * {@link Recorder} acts at the channel level, managing the creation and closure
 * of sessions in that channel, whereas the {@link RecordingTask} acts at the
 * session level, managing the recording of an individual session and following
 * its producer lifecycle.
 *
 * Architecture Schematic:
 *
 * Recorder (Channel Level)
 *   |
 *   +-- RecordingTask (Session Level) [1 per Session]
 *         |
 *         +-- MediaOutput (Stream Level) [1 per Stream type: AUDIO, CAMERA, SCREEN]
 *               |
 *               +-- FFMPEG (Process Level) [1 per Active Stream Segment]
 *
 * - **Recorder**: Orchestrates the recording for a whole channel. It manages
 *   the lifecycle of `RecordingTask`s as users join or leave the channel.
 *
 * - **RecordingTask**: Bound to a specific `Session` (user). It monitors the
 *   user's streams (audio, camera, screen) and manages `MediaOutput` instances for each type.
 *
 * - **MediaOutput**: Handles a single media stream type for a session. It sets
 *   up the transport/consumer to receive RTP data and manages the `FFMPEG` wrapper.
 *
 * - **FFMPEG**: Represents the actual ffmpeg process that writes the RTP stream
 *   to a file. It is created when valid RTP data is available and the producer is active.
 */
export class Recorder extends EventEmitter {
    static Events = {
        UPDATE: "update"
    };

    /**
     * Plain recording means that we mark the recording to be saved as a audio/video file
     **/
    isRecording: boolean = false;
    /**
     * Whether video is recorded (camera and screen sharing)
     **/
    video: boolean = false;
    /**
     * Whether transcription is desired (metadata flag)
     **/
    transcription: boolean = false;
    private _state: RECORDER_STATE = RECORDER_STATE.STOPPED;
    private _folder?: Folder;
    private _timeout?: NodeJS.Timeout;
    private readonly _channel: Channel;
    private readonly _tasks = new Map<SessionId, RecordingTask>();
    /** Path to which the final recording will be uploaded to */
    private readonly _metaData: Metadata = {
        channelName: "",
        routingAddress: "",
        timeStamps: []
    };

    get isActive(): boolean {
        return this._state === RECORDER_STATE.STARTED;
    }

    get state(): RecordingState {
        return {
            recording: this.isRecording,
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
        this._metaData.routingAddress = routingAddress;
    }

    /**
     * Can be called again even if it has started to update the transcription state,
     * this applies to the whole recording.
     */
    async start(options: { video?: boolean; transcription?: boolean } = {}) {
        this.transcription = Boolean(options.transcription);
        if (this.isRecording) {
            this._emitStatus();
            return;
        }
        this.isRecording = true;
        this.video = Boolean(options.video);
        this._metaData.startedAt = Date.now();

        try {
            await this._init();
        } catch (error) {
            logger.error(`Failed to start recording for ${this._channel.name}: ${error}`);
            this.terminate({ save: false });
        }
        this._emitStatus();
    }

    async stop() {
        if (!this.isRecording) {
            return;
        }
        this.isRecording = false;
        this._metaData.stoppedAt = Date.now();
        this.terminate();
        this._emitStatus();
    }
    /* eslint-disable no-dupe-class-members */ // overloads
    mark(tag: TIME_TAG.FILE_STATE_CHANGE, info: TimeTagInfo): void;
    mark(tag: TIME_TAG, info?: TimeTagInfo) {
        this._metaData.timeStamps.push({
            tag,
            timestamp: Date.now(),
            info
        } as TimeStampData);
    }

    /**
     * @param param0
     * @param param0.save - whether to save the recording
     */
    terminate({ save = true }: { save?: boolean } = {}) {
        if (!this.isActive) {
            return;
        }
        this._state = RECORDER_STATE.STOPPING;
        clearTimeout(this._timeout);
        this._timeout = undefined;
        logger.verbose(`terminating recorder for channel ${this._channel.name}`);
        this._channel.off(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.off(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
        this.isRecording = false;
        this.video = false;
        this.transcription = false;
        const currentFolder = this._folder;
        const metaData = this._sealMetaData();
        /**
         * Not awaiting as FFMPEG can take arbitrarily long to complete
         * (several seconds, or more), and we don't want to block the
         * termination of the recorder as a new recording can be started
         * straight away, independently of the saving process of the
         * previous recording. The input delay for the user would also be too long.
         */
        this._stopRecordingTasks()
            .then((results) => {
                const failed = results.some((result) => result.status === "rejected");
                if (save && !failed) {
                    currentFolder!.add("metadata.json", metaData);
                    currentFolder!.seal(
                        path.join(recording.directory, `${this._channel.name}_${Date.now()}`)
                    );
                } else {
                    currentFolder!.delete();
                }
            })
            .catch((error) => {
                logger.error(
                    `Failed to save recording for channel ${this._channel.name}: ${error}`
                );
            });
        this._folder = undefined;
        this._state = RECORDER_STATE.STOPPED;
    }

    private _sealMetaData() {
        const routingJwt = sign(
            {
                aud: this._metaData.routingAddress,
                exp: Math.floor((Date.now() + recording.fileTTL) / 1000) + 60 * 60
            },
            this._channel.key!
        );
        const metadata = JSON.stringify({
            ...this._metaData,
            video: this.video,
            transcription: this.transcription,
            routingJwt,
            sealedAt: Date.now()
        });
        this._metaData.timeStamps = [];
        this._metaData.stoppedAt = undefined;
        this._metaData.startedAt = undefined;
        return metadata;
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

    private _emitStatus(cause?: string) {
        this.emit("update", {
            isRecording: this.isRecording,
            transcription: this.transcription,
            video: this.video,
            cause
        });
    }
    private async _init() {
        this._state = RECORDER_STATE.STARTED;
        this._folder = await getFolder(["audio", "camera", "screen"]);
        clearTimeout(this._timeout);
        this._timeout = setTimeout(() => {
            this.terminate();
            this._emitStatus("recording_timeout");
        }, recording.maxDuration);
        logger.verbose(`Initializing recorder for channel: ${this._channel.name}`);
        for (const [sessionId, session] of this._channel.sessions) {
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
            audio: this.isRecording,
            camera: this.isRecording && this.video,
            screen: this.isRecording && this.video
        };
    }
}
