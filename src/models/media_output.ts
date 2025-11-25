import { EventEmitter } from "node:events";
import type {
    Router,
    Producer,
    Consumer,
    PlainTransport,
    MediaKind
} from "mediasoup/node/lib/types";
import { getPort, type DynamicPort } from "#src/services/resources.ts";
import { rtc } from "#src/config.ts";
import { FFMPEG } from "#src/models/ffmpeg.ts";

export type rtpData = {
    payloadType?: number;
    clockRate?: number;
    codec?: string;
    kind?: MediaKind;
    channels?: number;
    port: number;
};
export class MediaOutput extends EventEmitter {
    name: string;
    private _router: Router;
    private _producer: Producer;
    private _transport?: PlainTransport;
    private _consumer?: Consumer;
    private _ffmpeg?: FFMPEG;
    private _rtpData?: rtpData;
    private _port?: DynamicPort;
    private _isClosed = false;

    get port() {
        return this._port?.number;
    }

    constructor({ producer, router, name }: { producer: Producer; router: Router; name: string }) {
        super();
        this._router = router;
        this._producer = producer;
        this.name = name;
        this._init();
    }

    close() {
        this._isClosed = true;
        this._cleanup();
    }

    private async _init() {
        try {
            this._port = getPort();
            this._transport = await this._router?.createPlainTransport(rtc.plainTransportOptions);
            if (!this._transport) {
                throw new Error(`Failed at creating a plain transport for`);
            }
            this._transport.connect({
                ip: "0.0.0.0",
                port: this._port.number
            });
            this._consumer = await this._transport.consume({
                producerId: this._producer.id,
                rtpCapabilities: this._router!.rtpCapabilities,
                paused: true
            });
            if (this._isClosed) {
                // may be closed by the time the consumer is created
                this._cleanup();
                return;
            }
            const codecData = this._producer.rtpParameters.codecs[0];
            this._rtpData = {
                kind: this._producer.kind,
                payloadType: codecData.payloadType,
                clockRate: codecData.clockRate,
                port: this._port.number,
                codec: codecData.mimeType.split("/")[1],
                channels: this._producer.kind === "audio" ? codecData.channels : undefined
            };
            if (this._isClosed) {
                this._cleanup();
                return;
            }
            const refreshProcess = this._refreshProcess.bind(this);
            this._consumer.on("producerresume", refreshProcess);
            this._consumer.on("producerpause", refreshProcess);
            this._refreshProcess();
        } catch {
            this.close();
        }
    }

    private _refreshProcess() {
        if (this._isClosed || !this._rtpData) {
            return;
        }
        if (this._producer.paused) {
            this._ffmpeg?.close();
            this._ffmpeg = undefined;
        } else {
            const fileName = `${this.name}-${Date.now()}`;
            this._ffmpeg = new FFMPEG(this._rtpData, fileName);
            this.emit("file", fileName);
        }
    }

    private _cleanup() {
        this._ffmpeg?.close();
        this._consumer?.close();
        this._transport?.close();
        this._port?.release();
    }
}
