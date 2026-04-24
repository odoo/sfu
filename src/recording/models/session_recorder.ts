import path from "node:path";
import { EventEmitter } from "node:events";

import { MediaSink } from "#src/recording/models/media_sink.ts";
import { Session, type SessionProducer } from "#src/core/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { TIME_TAG, type Recorder } from "#src/recording/models/recorder.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import { PortLimitReachedError } from "#src/utils/errors.ts";

export type RecordingStates = {
    audio: boolean;
    camera: boolean;
    screen: boolean;
};

export enum SESSION_RECORDER_EVENT {
    UPDATE = "update"
}

type RecordingData = {
    active: boolean;
    allowed: boolean;
    type: STREAM_TYPE;
    mediaSink?: MediaSink;
    fileStateChangeListener?: (payload: {
        active: boolean;
        available: boolean;
        filename: string;
        eof?: boolean;
    }) => void;
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
export class SessionRecorder extends EventEmitter {
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
        super();
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
        this._scheduleUpdateProcess(data, producer, type);
    }

    private _onSessionProducer({
        type,
        producer
    }: {
        type: STREAM_TYPE;
        producer: SessionProducer;
    }) {
        const data = this.recordingDataByStreamType[type];
        this._scheduleUpdateProcess(data, producer, type);
    }

    private _scheduleUpdateProcess(
        data: RecordingData,
        producer: SessionProducer,
        type: STREAM_TYPE
    ) {
        void this._updateProcess(data, producer, type).catch((error) => {
            logger.error(
                `unexpected recording update failure for ${this._session.name} ${type} - error: ${error}`
            );
        });
    }

    private async _updateProcess(
        data: RecordingData,
        producer: SessionProducer,
        type: STREAM_TYPE
    ) {
        if (data.active) {
            if (data.mediaSink) {
                // already recording
                return;
            }
            try {
                data.mediaSink = new MediaSink({
                    producer,
                    name: `${this._session.id}-${type}`,
                    directory: path.join(this._recorder.path!, type)
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
                    this._recorder.mark(TIME_TAG.FILE_STATE_CHANGE, {
                        active,
                        available,
                        filename,
                        type,
                        sessionId: this._session.id,
                        eof
                    });
                };
                data.mediaSink.on(MediaSink.Events.FILE_STATE_CHANGE, data.fileStateChangeListener);
                data.mediaSink.allowed = data.allowed;
                await data.mediaSink.ready;
                if (data.active) {
                    return;
                }
            } catch (error) {
                if (error instanceof PortLimitReachedError) {
                    logger.warn(
                        `no port available for recording ${this._session.name} ${data.type}`
                    );
                    // TODO: accepting partial recoding, or the whole recording should be discarded?
                } else {
                    logger.error(
                        `failed at starting the recording for ${this._session.name} ${data.type} - error: ${error}`
                    );
                }
            }
        }
        await this._clearData(data.type);
    }

    private async _clearData(type: STREAM_TYPE) {
        const data = this.recordingDataByStreamType[type];
        data.active = false;
        if (data.mediaSink && data.fileStateChangeListener) {
            data.mediaSink.off(MediaSink.Events.FILE_STATE_CHANGE, data.fileStateChangeListener);
        }
        data.fileStateChangeListener = undefined;
        await data.mediaSink?.close();
        data.mediaSink = undefined;
    }

    async stop() {
        this._session.off(Session.Events.PRODUCER, this._onSessionProducer);
        const proms = [];
        for (const type of Object.values(STREAM_TYPE)) {
            proms.push(this._clearData(type));
        }
        return Promise.all(proms);
    }
}
