import type { Router, Producer, Consumer, PlainTransport } from "mediasoup/node/lib/types";
import { getPort, type DynamicPort } from "#src/services/resources.ts";
import { rtc } from "#src/config.ts";
import { Deferred } from "#src/utils/utils.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";

export class RTP {
    isReady = new Deferred<void>();
    payloadType?: number;
    clockRate?: number;
    codec?: string;
    channels?: number;
    type: STREAM_TYPE;
    private _router: Router;
    private _producer: Producer;
    private _transport?: PlainTransport;
    private _consumer?: Consumer;
    private _port?: DynamicPort;
    private _isClosed = false;

    get port() {
        return this._port?.number;
    }

    constructor({
        producer,
        router,
        type
    }: {
        producer: Producer;
        router: Router;
        type: STREAM_TYPE;
    }) {
        this._router = router;
        this._producer = producer;
        this.type = type;
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
                // may be closed by the time the consume is created
                this._cleanup();
                return;
            }
            // TODO may want to use producer.getStats() to get the codec info
            // for val of producer.getStats().values() { if val.type === "codec": val.minetype, val.clockRate,... }
            //const codecData = this._channel.router.rtpCapabilities.codecs.find(
            //    (codec) => codec.kind === producer.kind
            //);
            const codecData = this._producer.rtpParameters.codecs[0];
            this.payloadType = codecData.payloadType;
            this.clockRate = codecData.clockRate;
            this.codec = codecData.mimeType.replace(`${this._producer.kind}`, "");
            this.channels = this._producer.kind === "audio" ? codecData.channels : undefined;
            this.isReady.resolve();
        } catch {
            this.close();
            this.isReady.reject(new Error(`Failed at creating a plain transport for ${this.type}`));
        }
    }

    private _cleanup() {
        this._consumer?.close();
        this._transport?.close();
        this._port?.release();
    }
}
