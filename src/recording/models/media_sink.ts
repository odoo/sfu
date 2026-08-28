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

export type MediaSinkFailure = MediaWriterFailure;

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
    readonly ready: Promise<boolean>;
    private _producer: Producer<SessionAppData>;
    private _transport?: PlainTransport;
    private _consumer?: Consumer;
    private _mediaWriter?: MediaWriter;
    private _rtpData?: RtpData;
    private _port?: DynamicPort;
    private _isClosed = false;
    private _closePromise?: Promise<void>;
    private _failure?: MediaSinkFailure;
    private _syncPromise = Promise.resolve();
    private _writerFailureListener?: (failure: MediaWriterFailure) => void;
    private _directory: string;
    private _allowed = true;
    private readonly _availabilityMarker: string;
    private _firstPacketListener?: () => void;

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

    close(): Promise<void> {
        this._isClosed = true;
        return (this._closePromise ??= this._close());
    }

    private get _router() {
        return this._producer.appData.router;
    }

    private async _init() {
        this._port = new DynamicPort();
        this._transport = await this._router.createPlainTransport(config.rtc.plainTransportOptions);
        if (this._isClosed) {
            return false;
        }
        await this._transport.connect({
            ip: config.recording.routingInterface,
            port: this._port.number
        });
        if (this._isClosed) {
            return false;
        }
        this._consumer = await this._transport
            .consume({
                producerId: this._producer.id,
                rtpCapabilities: this._router.rtpCapabilities,
                paused: true
            })
            .catch((error: unknown) => {
                if (!this._producer.closed) {
                    throw error;
                }
                return undefined;
            });
        if (!this._consumer) {
            this._transport.close();
            this._transport = undefined;
            this._port.release();
            this._port = undefined;
            return false;
        }
        if (this._isClosed) {
            return false;
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
        const syncProcess = this._syncProcess.bind(this);
        this._consumer.on("producerresume", syncProcess);
        this._consumer.on("producerpause", syncProcess);
        this._consumer.on("producerclose", () => {
            void this.close().catch((error) => {
                this._handleFailure({
                    filename: this._mediaWriter?.filename ?? this._availabilityMarker,
                    error: error instanceof Error ? error : new Error(String(error))
                });
            });
        });
        this._syncProcess();
        await this._syncPromise;
        return true;
    }

    private _syncProcess() {
        this._syncPromise = this._syncPromise
            .then(() => this._sync())
            .catch((error) => {
                if (this._isClosed) {
                    return;
                }
                this._handleFailure({
                    filename: this._mediaWriter?.filename ?? this._availabilityMarker,
                    error: error instanceof Error ? error : new Error(String(error))
                });
            });
    }

    private async _sync() {
        if (this._isClosed || !this._rtpData) {
            return;
        }
        // equivalent to this._producer.paused, but the producer state seems to update after the event.
        if (this._consumer!.producerPaused) {
            await this._updateConsumer(false);
        } else {
            if (!this._mediaWriter && this._allowed) {
                const fileName = `${Date.now()}-${this.name}`;
                logger.verbose(`new recording file${this._directory}/${fileName}`);
                this._mediaWriter = new MediaWriter(this._rtpData, this._directory, fileName);
                this._writerFailureListener = (failure: MediaWriterFailure) => {
                    this._handleFailure(failure);
                };
                this._mediaWriter.once(MediaWriter.Events.FAILURE, this._writerFailureListener);
            }
            await this._updateConsumer(true);
        }
    }

    private _handleFailure(failure: MediaSinkFailure) {
        if (this._failure) {
            return;
        }
        this._failure = failure;
        void this._closeAfterFailure(failure);
    }

    private async _closeAfterFailure(failure: MediaSinkFailure) {
        try {
            await this.close();
        } catch (error) {
            logger.error(`failed to close media sink ${this.name}: ${error}`);
        }
        this.emit(MediaSink.Events.FAILURE, failure);
    }

    private async _updateConsumer(available: boolean) {
        const consumer = this._consumer;
        if (!consumer) {
            return;
        }
        if (!available || !this._allowed) {
            this._stopAwaitingFirstPacket();
            await consumer.pause();
            if (!this._isClosed) {
                this._emitState(false, available);
            }
            return;
        }
        if (!consumer.paused || this._firstPacketListener) {
            return; // already recording, or already waiting for the first packet
        }
        // Activation is timestamped from the first RTP packet the consumer
        // forwards, not from resume(): a video stream only starts flowing once its
        // keyframe request has completed a round-trip, so resuming would leave it
        // misaligned against audio in the compiled output.
        await this._awaitFirstPacket(consumer);
        if (this._isClosed || !this._allowed || consumer.producerPaused) {
            this._stopAwaitingFirstPacket();
            return;
        }
        await consumer.resume();
        if (consumer.kind === "video") {
            // request a keyframe so the recording opens on a full frame instead of
            // a gray screen until the producer's next periodic keyframe
            await consumer.requestKeyFrame();
        }
    }

    /**
     * Marks the stream active once the consumer forwards its first RTP packet.
     */
    private async _awaitFirstPacket(consumer: Consumer) {
        this._firstPacketListener = () => {
            this._stopAwaitingFirstPacket();
            if (!this._isClosed) {
                this._emitState(true, true);
            }
        };
        consumer.once("trace", this._firstPacketListener);
        await consumer.enableTraceEvent(["rtp"]);
    }

    private _stopAwaitingFirstPacket() {
        const listener = this._firstPacketListener;
        if (!listener) {
            return;
        }
        this._firstPacketListener = undefined;
        this._consumer?.off("trace", listener);
        // Best-effort: leaving the trace on only costs an unused event per packet.
        void this._consumer?.enableTraceEvent().catch((error: unknown) => {
            if (!this._isClosed) {
                logger.warn(`failed to disable RTP trace for ${this.name}: ${error}`);
            }
        });
    }

    private _emitState(active: boolean, available: boolean) {
        this.emit(MediaSink.Events.FILE_STATE_CHANGE, {
            active,
            available,
            filename: this._mediaWriter?.filename ?? this._availabilityMarker
        });
    }

    private async _close() {
        await this.ready.catch(() => {});
        await this._syncPromise;
        await this._cleanup();
    }

    private async _cleanup() {
        const mediaWriter = this._mediaWriter;
        const writerFailureListener = this._writerFailureListener;
        if (this._firstPacketListener) {
            this._consumer?.off("trace", this._firstPacketListener);
            this._firstPacketListener = undefined;
        }
        this.emit(MediaSink.Events.FILE_STATE_CHANGE, {
            active: false,
            available: false,
            filename: mediaWriter?.filename ?? this._availabilityMarker,
            eof: true
        });
        const prom = mediaWriter?.close();
        this._consumer?.close();
        this._transport?.close();
        this._consumer = undefined;
        this._transport = undefined;
        this._rtpData = undefined;
        try {
            await prom;
        } finally {
            if (!mediaWriter || mediaWriter.isProcessClosed) {
                this._releasePort();
            } else {
                mediaWriter.once(MediaWriter.Events.PROCESS_CLOSE, () => this._releasePort());
            }
            if (mediaWriter && writerFailureListener) {
                mediaWriter.off(MediaWriter.Events.FAILURE, writerFailureListener);
            }
            this._mediaWriter = undefined;
            this._writerFailureListener = undefined;
        }
    }

    private _releasePort() {
        this._port?.release();
        this._port = undefined;
    }
}
