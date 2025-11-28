/* eslint-disable @typescript-eslint/no-unused-vars */
import { EventEmitter } from "node:events";

import type { Producer } from "mediasoup/node/lib/types";

import { MediaOutput } from "#src/models/media_output.ts";
import { Session } from "#src/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { TIME_TAG, type Recorder } from "#src/models/recorder.ts";

import { STREAM_TYPE } from "#src/shared/enums.ts";

export type RecordingStates = {
    audio: boolean;
    camera: boolean;
    screen: boolean;
};

export enum RECORDING_TASK_EVENT {
    UPDATE = "update"
}

type RecordingData = {
    active: boolean; // active is different from boolean(ffmpeg) so we can flag synchronously and avoid race conditions
    type: STREAM_TYPE;
    mediaOutput?: MediaOutput;
};

type RecordingDataByStreamType = {
    [STREAM_TYPE.AUDIO]: RecordingData;
    [STREAM_TYPE.CAMERA]: RecordingData;
    [STREAM_TYPE.SCREEN]: RecordingData;
};

const logger = new Logger("RECORDING_TASK");

export class RecordingTask extends EventEmitter {
    private _session: Session;
    private _recorder: Recorder;
    private readonly recordingDataByStreamType: RecordingDataByStreamType = {
        [STREAM_TYPE.AUDIO]: {
            active: false,
            type: STREAM_TYPE.AUDIO
        },
        [STREAM_TYPE.CAMERA]: {
            active: false,
            type: STREAM_TYPE.CAMERA
        },
        [STREAM_TYPE.SCREEN]: {
            active: false,
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

    constructor(recorder: Recorder, session: Session, { audio, camera, screen }: RecordingStates) {
        super();
        this._onSessionProducer = this._onSessionProducer.bind(this);
        this._session = session;
        this._recorder = recorder;
        this._session.on("producer", this._onSessionProducer);
        this.audio = audio;
        this.camera = camera;
        this.screen = screen;
    }

    private async _setRecording(type: STREAM_TYPE, state: boolean) {
        const data = this.recordingDataByStreamType[type];
        if (data.active === state) {
            return;
        }
        data.active = state;
        const producer = this._session.producers[type];
        if (!producer) {
            return; // will be handled later when the session starts producing
        }
        this._updateProcess(data, producer, type);
    }

    private async _onSessionProducer({
        type,
        producer
    }: {
        type: STREAM_TYPE;
        producer: Producer;
    }) {
        const data = this.recordingDataByStreamType[type];
        if (!data.active) {
            return;
        }
        this._updateProcess(data, producer, type);
    }

    private async _updateProcess(data: RecordingData, producer: Producer, type: STREAM_TYPE) {
        if (data.active) {
            if (data.mediaOutput) {
                // already recording
                return;
            }
            try {
                data.mediaOutput = new MediaOutput({
                    producer,
                    router: this._session.router!,
                    name: `${this._session.id}-${type}`,
                    directory: this._recorder.path!
                });
                data.mediaOutput.on("file", (filename: string) => {
                    this._recorder.mark(TIME_TAG.NEW_FILE, { filename, type });
                });
                if (data.active) {
                    return;
                }
            } catch {
                logger.warn(
                    `failed at starting the recording for ${this._session.name} ${data.type}`
                );
            }
        }
        await this._clearData(data.type);
    }

    private async _clearData(type: STREAM_TYPE) {
        const data = this.recordingDataByStreamType[type];
        data.active = false;
        await data.mediaOutput?.close();
        data.mediaOutput = undefined;
    }

    async stop() {
        this._session.off("producer", this._onSessionProducer);
        const proms = [];
        for (const type of Object.values(STREAM_TYPE)) {
            proms.push(this._clearData(type));
        }
        await Promise.all(proms);
    }
}
