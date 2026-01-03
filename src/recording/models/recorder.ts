import path from "node:path";
import { EventEmitter } from "node:events";

import { recording } from "#src/config.ts";
import { getFolder, type Folder } from "#src/core/services/resources.ts";
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
     * when the stream is active, which means that the producer is
     * actively broadcasting data, and false when it is not.
     */
    active: boolean;
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
    routingAddress: string;
    startedAt?: number;
    timeStamps: TimeStampData[];
    labels: Record<SessionId, string>;
};

export type SealedMetaData = Metadata & {
    channelKey: string;
    video: boolean;
    stoppedAt?: number;
    transcription: boolean;
};

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
        routingAddress: "",
        timeStamps: [],
        labels: {}
    };

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
        this.terminate();
        this._emitStatus();
    }

    mark(tag: TIME_TAG, info: TimeTagInfo) {
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
        if (!this.isRecording) {
            return;
        }
        this.isRecording = false;
        clearTimeout(this._timeout);
        this._timeout = undefined;
        logger.verbose(`terminating recorder for channel ${this._channel.name}`);
        this._channel.off(Channel.Events.SESSION_JOIN, this._onSessionJoin);
        this._channel.off(Channel.Events.SESSION_LEAVE, this._onSessionLeave);
        const metaData = save ? this._sealMetaData() : undefined;
        this._metaData.timeStamps = [];
        this._metaData.startedAt = undefined;
        this._metaData.labels = {};
        this.video = false;
        this.transcription = false;
        const currentFolder = this._folder;
        this._folder = undefined;
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
                    currentFolder!.add(recording.metadataFileName, metaData!);
                    currentFolder!.seal(
                        path.join(recording.directory, `${Date.now()}-${this._channel.name}`)
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
    }

    /**
     * Adds the final entries to the metadata, encrypts it and resets its state.
     *
     * @returns encrypted metadata
     */
    private _sealMetaData() {
        const metadata = JSON.stringify({
            ...this._metaData,
            video: this.video,
            transcription: this.transcription,
            channelKey: this._channel.key,
            stoppedAt: Date.now()
        });
        /**
         * As the metadata can contain sensitive information, like routing
         * with tokens, or the channel key, it is encrypted before being
         * saved on the disk.
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

    private _emitStatus(cause?: string) {
        this.emit("update", {
            isRecording: this.isRecording,
            transcription: this.transcription,
            video: this.video,
            cause
        });
    }
    private async _init() {
        this._folder = await getFolder(["audio", "camera", "screen"]);
        clearTimeout(this._timeout);
        this._timeout = setTimeout(() => {
            this.terminate();
            this._emitStatus("recording_timeout");
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
        /**
         * TODO
         * This will need to be much smarter. When recording video, we should
         * only record the latest screen, and record cameras only if there is no
         * screen being shared. That is because in the compiled version, the screen
         * takes precedence over the camera, and all the visual space. That is
         * because when a screen is shared it should be the focus of the attention
         * and is only useful when taking all of the visual space (it wouldn't make
         * sense to divide the space available in the final video between multiple
         * screens, or between screens and cameras).
         *
         * Therefore a mechanism to track the latest screen shared should be
         * implemented. We can extract that information from the
         * TIME_TAG.FILE_STATE_CHANGE events, where `type` and `available` is all
         * we need to know when and if a screen is being shared, then we can swap the "allowed" flag
         * of the media outputs that should be on or off.
         */
        return {
            audio: this.isRecording,
            camera: this.isRecording && this.video,
            screen: this.isRecording && this.video
        };
    }
}
