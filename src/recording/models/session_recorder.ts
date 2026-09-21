import path from "node:path";

import { MediaSink, type MediaSinkFailure } from "#src/recording/models/media_sink.ts";
import { Session, type SessionProducer } from "#src/core/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { TIME_TAG, type Recorder } from "#src/recording/models/recorder.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";

export type RecordingStates = {
    audio: boolean;
    camera: boolean;
    screen: boolean;
};

type RecordingData = {
    active: boolean;
    allowed: boolean;
    type: STREAM_TYPE;
    /** identifies the producer bound to `mediaSink` so repeats and replacements are distinguished */
    producer?: SessionProducer;
    /** queues this stream's sink updates so asynchronous creation and cleanup cannot overlap */
    updatePromise?: Promise<void>;
    mediaSink?: MediaSink;
    fileStateChangeListener?: (payload: {
        active: boolean;
        available: boolean;
        filename: string;
        eof?: boolean;
    }) => void;
    failureListener?: (failure: MediaSinkFailure) => void;
};

type RecordingDataByStreamType = {
    [STREAM_TYPE.AUDIO]: RecordingData;
    [STREAM_TYPE.CAMERA]: RecordingData;
    [STREAM_TYPE.SCREEN]: RecordingData;
};

const logger = new Logger("SESSION_RECORDER");

/**
 * Tracks recording state per stream type and starts MediaSink instances
 * when producers become available for the current session.
 */
export class SessionRecorder {
    private _session: Session;
    private _recorder: Recorder;
    private readonly recordingDataByStreamType: RecordingDataByStreamType = {
        [STREAM_TYPE.AUDIO]: {
            active: false,
            allowed: true,
            type: STREAM_TYPE.AUDIO
        },
        [STREAM_TYPE.CAMERA]: {
            active: false,
            allowed: true,
            type: STREAM_TYPE.CAMERA
        },
        [STREAM_TYPE.SCREEN]: {
            active: false,
            allowed: true,
            type: STREAM_TYPE.SCREEN
        }
    };

    set audio(value: boolean) {
        this._setRecording(STREAM_TYPE.AUDIO, value);
    }
    set camera(value: boolean) {
        this._setRecording(STREAM_TYPE.CAMERA, value);
    }
    set screen(value: boolean) {
        this._setRecording(STREAM_TYPE.SCREEN, value);
    }

    /**
     * Toggles whether an already-recording video stream is allowed to be active.
     *
     * This is controlled by recorder-wide prioritization rules (screen-over-camera
     * and latest-N limits). The method does not create or destroy recording outputs;
     * it only forwards the allow/deny state to `MediaSink.allowed`, so availability
     * can continue to be observed while active writing is gated.
     */
    setAllowed(type: STREAM_TYPE.CAMERA | STREAM_TYPE.SCREEN, allowed: boolean) {
        const data = this.recordingDataByStreamType[type];
        if (data.allowed === allowed) {
            return;
        }
        data.allowed = allowed;
        if (data.mediaSink) {
            data.mediaSink.allowed = allowed;
        }
    }

    constructor(recorder: Recorder, session: Session, { audio, camera, screen }: RecordingStates) {
        this._session = session;
        this._recorder = recorder;
        this.audio = audio;
        this.camera = camera;
        this.screen = screen;
        this._onSessionProducer = this._onSessionProducer.bind(this);
        this._session.on(Session.Events.PRODUCER, this._onSessionProducer);
    }

    private _setRecording(type: STREAM_TYPE, state: boolean) {
        const data = this.recordingDataByStreamType[type];
        if (data.active === state) {
            return;
        }
        data.active = state;
        const producer = this._session.producers[type];
        if (!producer) {
            return; // will be handled later when the session starts producing
        }
        this._scheduleUpdateProcess(data, producer);
    }

    private _onSessionProducer({
        type,
        producer
    }: {
        type: STREAM_TYPE;
        producer: SessionProducer;
    }) {
        const data = this.recordingDataByStreamType[type];
        this._scheduleUpdateProcess(data, producer);
    }

    private _scheduleUpdateProcess(data: RecordingData, producer: SessionProducer) {
        data.updatePromise = (data.updatePromise ?? Promise.resolve())
            .then(() => this._updateProcess(data, producer))
            .catch((error) => {
                logger.error(
                    `unexpected recording update failure for ${this._session.name} ${data.type} - error: ${error}`
                );
                void this._recorder.fail(error).catch((failure) => {
                    logger.error(
                        `failed to stop recording after ${this._session.name} ${data.type} update failure - error: ${failure}`
                    );
                });
            });
    }

    private async _updateProcess(data: RecordingData, producer: SessionProducer) {
        if (data.active) {
            if (data.mediaSink) {
                if (data.producer === producer) {
                    return;
                }
                await this._clearData(data.type, false);
                if (!data.active) {
                    return;
                }
            }
            data.producer = producer;
            data.mediaSink = new MediaSink({
                producer,
                name: `${encodeURIComponent(String(this._session.id))}-${data.type}`,
                directory: path.join(this._recorder.path!, data.type)
            });
            data.fileStateChangeListener = ({
                active,
                available,
                filename,
                eof
            }: {
                active: boolean;
                available: boolean;
                filename: string;
                eof?: boolean;
            }) => {
                this._recorder.mark(
                    TIME_TAG.FILE_STATE_CHANGE,
                    {
                        active,
                        available,
                        filename,
                        type: data.type,
                        sessionId: this._session.id,
                        eof
                    },
                    this
                );
            };
            data.mediaSink.on(MediaSink.Events.FILE_STATE_CHANGE, data.fileStateChangeListener);
            data.failureListener = (failure: MediaSinkFailure) => {
                void this._handleSinkFailure(data, failure).catch((error) => {
                    logger.error(
                        `failed to handle recording failure for ${this._session.name} ${data.type} - error: ${error}`
                    );
                });
            };
            data.mediaSink.once(MediaSink.Events.FAILURE, data.failureListener);
            data.mediaSink.allowed = data.allowed;
            const ready = await data.mediaSink.ready;
            if (!ready) {
                await this._clearData(data.type, false);
                return;
            }
            if (data.active) {
                return;
            }
        }
        await this._clearData(data.type);
    }

    private async _handleSinkFailure(data: RecordingData, failure: MediaSinkFailure) {
        logger.error(
            `recording failed for ${this._session.name} ${data.type} through ${failure.filename}: ${failure.error.message}`
        );
        try {
            await this._clearData(data.type);
        } catch (error) {
            logger.error(
                `failed to clear failed recording stream for ${this._session.name} ${data.type} - error: ${error}`
            );
        }
        await this._recorder.fail(failure.error);
    }

    private async _clearData(type: STREAM_TYPE, deactivate = true) {
        const data = this.recordingDataByStreamType[type];
        const producer = data.producer;
        const mediaSink = data.mediaSink;
        const fileStateChangeListener = data.fileStateChangeListener;
        const failureListener = data.failureListener;
        if (deactivate) {
            data.active = false;
        }
        try {
            await mediaSink?.close();
        } finally {
            if (mediaSink && fileStateChangeListener) {
                mediaSink.off(MediaSink.Events.FILE_STATE_CHANGE, fileStateChangeListener);
            }
            if (mediaSink && failureListener) {
                mediaSink.off(MediaSink.Events.FAILURE, failureListener);
            }
            if (data.mediaSink === mediaSink) {
                data.mediaSink = undefined;
            }
            if (data.producer === producer) {
                data.producer = undefined;
            }
            if (data.failureListener === failureListener) {
                data.failureListener = undefined;
            }
            if (data.fileStateChangeListener === fileStateChangeListener) {
                data.fileStateChangeListener = undefined;
            }
        }
    }

    async stop(): Promise<void> {
        this._session.off(Session.Events.PRODUCER, this._onSessionProducer);
        const proms = [];
        for (const type of Object.values(STREAM_TYPE)) {
            const data = this.recordingDataByStreamType[type];
            const stopPromise = (data.updatePromise ?? Promise.resolve()).then(() =>
                this._clearData(type)
            );
            data.updatePromise = stopPromise;
            proms.push(stopPromise);
        }
        const results = await Promise.allSettled(proms);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) {
            throw failure.reason;
        }
    }
}
