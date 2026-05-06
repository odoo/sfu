import { EventEmitter } from "node:events";

import type { Consumer, PlainTransport, MediaKind, Producer } from "mediasoup/node/lib/types";

import { DynamicPort } from "#src/core/services/resources.ts";
import * as config from "#src/config.ts";
import { MediaWriter, type MediaWriterFailure } from "#src/recording/models/media_writer.ts";
import { Logger } from "#src/utils/utils.ts";
import type { SessionAppData } from "#src/core/models/session.ts";

const logger = new Logger("MEDIA_SINK");

export type RtpData = {
    kind: MediaKind;
    payloadType: number;
    clockRate: number;
    codec: string;
    port: number;
    channels?: number;
};

export type MediaSinkFailure = MediaWriterFailure & {
    sinkName: string;
};

/**
 * Bridges a mediasoup producer through a RTP to an FFMPEG recording process.
 *
 * The class opens a plain transport/consumer pair on a dynamic port,
 * extracts the RTP parameters, and spawns FFMPEG only when the producer is
 * both available and allowed to record.
 */
export class MediaSink extends EventEmitter {
    static readonly Events = {
        FILE_STATE_CHANGE: "fileStateChange",
        FAILURE: "failure"
    } as const;

    name: string;
    readonly ready: Promise<void>;
    private _producer: Producer<SessionAppData>;
    private _transport?: PlainTransport;
    private _consumer?: Consumer;
    private _mediaWriter?: MediaWriter;
    private _rtpData?: RtpData;
    private _port?: DynamicPort;
    private _isClosed = false;
    private _closePromise?: Promise<void>;
    private _failure?: MediaSinkFailure;
    private _writerFailureListener?: (failure: MediaWriterFailure) => void;
    private _directory: string;
    private _allowed = true;
    private readonly _availabilityMarker: string;

    set allowed(value: boolean) {
        if (this._allowed === value) {
            return;
        }
        this._allowed = value;
        this._syncProcess();
    }

    get port() {
        return this._port?.number;
    }

    constructor({
        producer,
        name,
        directory
    }: {
        producer: Producer<SessionAppData>;
        name: string;
        directory: string;
    }) {
        super();
        this.name = name;
        this._producer = producer;
        this._directory = directory;
        this._availabilityMarker = `availability-${name}`;
        this.ready = this._init();
    }

    async close() {
        if (this._closePromise) {
            return this._closePromise;
        }
        this._isClosed = true;
        this._closePromise = this._cleanup();
        return this._closePromise;
    }

    private get _router() {
        return this._producer.appData.router;
    }

    private async _init() {
        try {
            this._port = new DynamicPort();
            this._transport = await this._router.createPlainTransport(
                config.rtc.plainTransportOptions
            );
            if (!this._transport) {
                throw new Error(`Failed at creating a plain transport for`);
            }
            this._transport.connect({
                ip: config.recording.routingInterface,
                port: this._port.number
            });
            this._consumer = await this._transport.consume({
                producerId: this._producer.id,
                rtpCapabilities: this._router.rtpCapabilities,
                paused: true
            });
            if (this._isClosed) {
                // may be closed by the time the consumer is created
                await this._cleanup();
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
                await this._cleanup();
                return;
            }
            const syncProcess = this._syncProcess.bind(this);
            this._consumer.on("producerresume", syncProcess);
            this._consumer.on("producerpause", syncProcess);
            this._syncProcess();
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    private _syncProcess() {
        if (this._isClosed || !this._rtpData) {
            return;
        }
        // equivalent to this._producer.paused, but the producer state seems to update after the event.
        if (this._consumer!.producerPaused) {
            this._updateConsumer(false);
        } else {
            if (!this._mediaWriter && this._allowed) {
                const fileName = `${Date.now()}-${this.name}`;
                logger.verbose(`new recording file${this._directory}/${fileName}`);
                this._mediaWriter = new MediaWriter(this._rtpData, this._directory, fileName);
                this._writerFailureListener = (failure: MediaWriterFailure) => {
                    this._handleWriterFailure(failure);
                };
                this._mediaWriter.once(MediaWriter.Events.FAILURE, this._writerFailureListener);
            }
            this._updateConsumer(true);
        }
    }

    private _handleWriterFailure(failure: MediaWriterFailure) {
        if (this._failure) {
            return;
        }
        this._failure = { ...failure, sinkName: this.name };
        void this._closeAfterFailure(this._failure);
    }

    private async _closeAfterFailure(failure: MediaSinkFailure) {
        try {
            await this.close();
        } catch (error) {
            logger.error(`failed to close media sink ${this.name}: ${error}`);
        }
        this.emit(MediaSink.Events.FAILURE, failure);
    }

    private _updateConsumer(available: boolean) {
        const active = available && this._allowed;
        if (active) {
            this._consumer?.resume();
            if (this._consumer?.kind === "video") {
                // need to request a keyframe so that the recording has a starting frame
                // otherwise it could have a back screen at the start
                this._consumer.requestKeyFrame();
            }
        } else {
            this._consumer?.pause();
        }
        this.emit(MediaSink.Events.FILE_STATE_CHANGE, {
            active,
            /**
             * this should be used by the recorder to know
             * when someone starts screen sharing.
             * then update this.allowed accordingly
             */
            available,
            filename: this._mediaWriter?.filename ?? this._availabilityMarker
        });
    }

    private async _cleanup() {
        const mediaWriter = this._mediaWriter;
        const writerFailureListener = this._writerFailureListener;
        if (mediaWriter) {
            this.emit(MediaSink.Events.FILE_STATE_CHANGE, {
                active: false,
                filename: mediaWriter.filename,
                eof: true
            });
        }
        const prom = mediaWriter?.close();
        this._consumer?.close();
        this._transport?.close();
        this._port?.release();
        try {
            await prom;
        } finally {
            if (mediaWriter && writerFailureListener) {
                mediaWriter.off(MediaWriter.Events.FAILURE, writerFailureListener);
            }
            this._mediaWriter = undefined;
            this._writerFailureListener = undefined;
        }
    }
}
