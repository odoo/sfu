/* eslint-disable @typescript-eslint/no-unused-vars */
import { EventEmitter } from "node:events";

import { RTP } from "#src/models/rtp.ts";
import { Producer } from "mediasoup/node/lib/types";

import { Session } from "#src/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { FFMPEG } from "#src/models/ffmpeg.ts";

import { STREAM_TYPE } from "#src/shared/enums.ts";

export type RecordingParameters = {
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
    rtp?: RTP;
    ffmpeg?: FFMPEG;
};

type RecordingDataByStreamType = {
    [STREAM_TYPE.AUDIO]: RecordingData;
    [STREAM_TYPE.CAMERA]: RecordingData;
    [STREAM_TYPE.SCREEN]: RecordingData;
};

const logger = new Logger("RECORDING_TASK");

export class RecordingTask extends EventEmitter {
    private _session: Session;
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

    constructor(session: Session, { audio, camera, screen }: RecordingParameters) {
        super();
        this._onSessionProducer = this._onSessionProducer.bind(this);
        this._session = session;
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
            if (data.ffmpeg) {
                return;
            }
            try {
                data.rtp = data.rtp || new RTP({ producer, router: this._session.router!, type });
                data.ffmpeg = new FFMPEG(data.rtp);
                if (data.active) {
                    logger.verbose(
                        `starting recording process for ${this._session.name} ${data.type}`
                    );
                    return;
                }
            } catch {
                logger.warn(
                    `failed at starting the recording for ${this._session.name} ${data.type}`
                );
            }
        }
        // TODO emit ending
        this._clearData(data.type, { preserveRTP: true });
    }

    private _clearData(
        type: STREAM_TYPE,
        { preserveRTP }: { preserveRTP?: boolean } = { preserveRTP: false }
    ) {
        const data = this.recordingDataByStreamType[type];
        data.active = false;
        if (!preserveRTP) {
            data.rtp?.close();
            data.rtp = undefined;
        }
        data.ffmpeg?.close();
        data.ffmpeg = undefined;
    }

    async stop() {
        this._session.off("producer", this._onSessionProducer);
        for (const type of Object.values(STREAM_TYPE)) {
            this._clearData(type);
        }
    }
}
