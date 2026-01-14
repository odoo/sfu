import { EventEmitter } from "node:events";

import type {
    Router,
    Producer,
    Consumer,
    PlainTransport,
    MediaKind
} from "mediasoup/node/lib/types";

import { DynamicPort } from "#src/core/services/resources.ts";
import { recording, rtc } from "#src/config.ts";
import { MediaWriter } from "#src/recording/models/media_writer.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA_OUTPUT");

export type RtpData = {
    kind: MediaKind;
    payloadType: number;
    clockRate: number;
    codec: string;
    port: number;
    channels?: number;
};

/**
 * Bridges a mediasoup producer through a RTP to an FFMPEG recording process.
 *
 * The class opens a plain transport/consumer pair on a dynamic port,
 * extracts the RTP parameters, and spawns FFMPEG when the producer is active.
 * Construction calls {@link _init}, which provisions the mediasoup
 * transport/consumer, caches RTP metadata, and subscribes to producer pause/resume
 * events to drive {@link _refreshProcess}.
 */
export class MediaOutput extends EventEmitter {
    static Events = {
        FILE_STATE_CHANGE: "fileStateChange"
    };

    name: string;
    private _router: Router;
    private _producer: Producer;
    private _transport?: PlainTransport;
    private _consumer?: Consumer;
    private _mediaWriter?: MediaWriter;
    private _rtpData?: RtpData;
    private _port?: DynamicPort;
    private _isClosed = false;
    private _directory: string;
    private _allowed = true;

    set allowed(value: boolean) {
        if (this._allowed === value) {
            return;
        }
        this._allowed = value;
        this._refreshProcess();
    }

    get port() {
        return this._port?.number;
    }

    constructor({
        producer,
        router,
        name,
        directory
    }: {
        producer: Producer;
        router: Router;
        name: string;
        directory: string;
    }) {
        super();
        this._router = router;
        this._producer = producer;
        this.name = name;
        this._directory = directory;
        this._init();
    }

    async close() {
        this._isClosed = true;
        await this._cleanup();
    }

    private async _init() {
        try {
            this._port = new DynamicPort();
            this._transport = await this._router?.createPlainTransport(rtc.plainTransportOptions);
            if (!this._transport) {
                throw new Error(`Failed at creating a plain transport for`);
            }
            this._transport.connect({
                ip: recording.routingInterface,
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
            const codecData = this._consumer.rtpParameters.codecs[0];
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

    /**
     * Refreshes the MediaWriter process based on the producer state.
     */
    private async _refreshProcess() {
        if (this._isClosed || !this._rtpData) {
            return;
        }
        // equivalent to this._producer.paused, but the producer state seems to update after the event.
        if (this._consumer!.producerPaused) {
            this._updateConsumer(false);
        } else {
            if (!this._mediaWriter) {
                const fileName = `${Date.now()}-${this.name}`;
                logger.verbose(`new recording file${this._directory}/${fileName}`);
                this._mediaWriter = new MediaWriter(this._rtpData, this._directory, fileName);
            }
            this._updateConsumer(true);
        }
    }

    private _updateConsumer(available: boolean) {
        const active = available && this._allowed;
        if (active) {
            this._consumer?.resume();
        } else {
            this._consumer?.pause();
        }
        if (!this._mediaWriter) {
            return;
        }
        this.emit(MediaOutput.Events.FILE_STATE_CHANGE, {
            active,
            /**
             * this should be used by the recorder to know
             * when someone starts screen sharing.
             * then update this.allowed accordingly
             */
            available,
            filename: this._mediaWriter.filename
        });
    }

    private async _cleanup() {
        if (this._mediaWriter) {
            this.emit(MediaOutput.Events.FILE_STATE_CHANGE, {
                active: false,
                filename: this._mediaWriter.filename,
                eof: true
            });
        }
        const prom = this._mediaWriter?.close();
        this._consumer?.close();
        this._transport?.close();
        this._port?.release();
        await prom;
    }
}
