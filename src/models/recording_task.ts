/* eslint-disable @typescript-eslint/no-unused-vars */
import { EventEmitter } from "node:events";

import type { Producer, Consumer, PlainTransport } from "mediasoup/node/lib/types";

import { Session } from "#src/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { FFMPEG, type RtpData } from "#src/models/ffmpeg.ts";
import { rtc } from "#src/config";
import { getPort, type DynamicPort } from "#src/services/resources";

import { STREAM_TYPE } from "#src/shared/enums";

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
    transport?: PlainTransport;
    consumer?: Consumer;
    ffmpeg?: FFMPEG;
    port?: DynamicPort;
    type: STREAM_TYPE;
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
        this._updateProcess(data, producer);
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
        this._clearData(type); // in case we already had a process for an outdated producer
        this._updateProcess(data, producer);
    }

    private async _updateProcess(data: RecordingData, producer: Producer) {
        if (data.active) {
            if (data.ffmpeg) {
                return;
            }
            data.port = getPort();
            try {
                data.ffmpeg = new FFMPEG(await this._createRtp(producer, data));
                if (data.active) {
                    if (data.ffmpeg) {
                        // TODO emit starting
                    }
                    logger.verbose(
                        `starting recording process for ${this._session.name} ${data.type}`
                    );
                    return;
                }
                return;
            } catch {
                logger.warn(
                    `failed at starting the recording for ${this._session.name} ${data.type}`
                );
            }
        }
        // TODO emit ending
        this._clearData(data.type);
    }

    async _createRtp(producer: Producer, data: RecordingData): Promise<RtpData> {
        const transport = await this._session.router?.createPlainTransport(
            rtc.plainTransportOptions
        );
        data.transport = transport;
        if (!transport) {
            throw new Error(`Failed at creating a plain transport for`);
        }
        transport.connect({
            ip: "0.0.0.0",
            port: data.port!.number
        });
        data.consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: this._session.router!.rtpCapabilities,
            paused: true
        });
        // TODO may want to use producer.getStats() to get the codec info
        // for val of producer.getStats().values() { if val.type === "codec": val.minetype, val.clockRate,... }
        //const codecData = this._channel.router.rtpCapabilities.codecs.find(
        //    (codec) => codec.kind === producer.kind
        //);
        const codecData = producer.rtpParameters.codecs[0];
        return {
            payloadType: codecData.payloadType,
            clockRate: codecData.clockRate,
            codec: codecData.mimeType.replace(`${producer.kind}`, ""),
            channels: producer.kind === "audio" ? codecData.channels : undefined,
            type: data.type
        };
    }

    private _clearData(type: STREAM_TYPE) {
        const data = this.recordingDataByStreamType[type];
        data.active = false;
        data.ffmpeg?.kill();
        data.ffmpeg = undefined;
        data.transport?.close();
        data.transport = undefined;
        data.consumer?.close();
        data.consumer = undefined;
        data.port?.release();
        data.port = undefined;
    }

    async stop() {
        this._session.off("producer", this._onSessionProducer);
        for (const type of Object.values(STREAM_TYPE)) {
            this._clearData(type);
        }
    }
}
