import { Session } from "#src/models/session.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("RECORDING_TASK");

export class RecordingTask {
    private session: Session;
    private _audio: boolean = false;
    private _camera: boolean = false;
    private _screen: boolean = false;

    // TODO when set, start/stop recording process
    set audio(value: boolean) {
        this._audio = value;
    }
    set camera(value: boolean) {
        this._camera = value;
    }
    set screen(value: boolean) {
        this._screen = value;
    }

    constructor(
        session: Session,
        { audio, camera, screen }: { audio?: boolean; camera?: boolean; screen?: boolean } = {}
    ) {
        this.session = session;
        this._audio = audio ?? false;
        this._camera = camera ?? false;
        this._screen = screen ?? false;
        logger.trace(
            `TO IMPLEMENT: recording task for session ${this.session.id} - audio: ${this._audio}, camera: ${this._camera}, screen: ${this._screen}`
        );
    }

    async stop() {}
}
