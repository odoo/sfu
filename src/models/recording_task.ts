/* eslint-disable @typescript-eslint/no-unused-vars */
import { EventEmitter } from "node:events";

import { Session } from "#src/models/session.ts";
import { Logger } from "#src/utils/utils.ts";
import { FFMPEG } from "#src/models/ffmpeg.ts";

import type { PlainTransport } from "mediasoup/node/lib/PlainTransportTypes";

const logger = new Logger("RECORDING_TASK");

export class RecordingTask extends EventEmitter {
    /**
     * Whether or not the recording process has been stopped. Used as termination/cleanup condition for async processes
     */
    isStopped = false;
    private session: Session;
    private _audio: boolean = false;
    private _camera: boolean = false;
    private _screen: boolean = false;
    private _audioRTP?: PlainTransport = undefined;
    private _cameraRTP?: PlainTransport = undefined;
    private _screenRTP?: PlainTransport = undefined;
    private _audioFFFMPEG?: FFMPEG = undefined;
    private _cameraFFMPEG?: FFMPEG = undefined;
    private _screenFFMPEG?: FFMPEG = undefined;

    // TODO when set, start/stop recording process (create a RTP, create FFMPEG/Gstreamer process, pipe RTP to FFMPEG/Gstreamer)
    // The initialization process will likely be async and prone to race conditions, once the process has started, we should
    // remember to check if this.isStopped, and if so, stop the process.
    set audio(value: boolean) {
        if (value === this._audio || this.isStopped) {
            return;
        }
        this._audio = value;
        logger.trace(
            `TO IMPLEMENT: recording task for session ${this.session.id} - audio: ${value}`
        );
        logger.debug(`rtp: ${this._audioRTP}, ffmpeg: ${this._audioFFFMPEG}`);
        // await record(audio)
        // if (this.isStopped) { cleanup(audio) };
    }
    set camera(value: boolean) {
        if (value === this._camera || this.isStopped) {
            return;
        }
        this._camera = value;
        logger.trace(
            `TO IMPLEMENT: recording task for session ${this.session.id} - camera: ${value}`
        );
        logger.debug(`rtp: ${this._cameraRTP}, ffmpeg: ${this._cameraFFMPEG}`);
    }
    set screen(value: boolean) {
        if (value === this._screen || this.isStopped) {
            return;
        }
        this._screen = value;
        logger.trace(
            `TO IMPLEMENT: recording task for session ${this.session.id} - screen: ${value}`
        );
        logger.debug(`rtp: ${this._screenRTP}, ffmpeg: ${this._screenFFMPEG}`);
    }

    constructor(
        session: Session,
        { audio, camera, screen }: { audio?: boolean; camera?: boolean; screen?: boolean } = {}
    ) {
        super();
        this.session = session;
        this._audio = audio ?? false;
        this._camera = camera ?? false;
        this._screen = screen ?? false;
        logger.trace(
            `TO IMPLEMENT: recording task for session ${this.session.id} - audio: ${this._audio}, camera: ${this._camera}, screen: ${this._screen}`
        );
    }

    async stop() {
        this.isStopped = true;
    }
}
