import type { TimeStampData } from "#src/models/recording/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

const logger = new Logger("MEDIA_COMPILER");

export class MediaCompiler {
    private readonly _workingDir: string;
    private readonly _timeStamps: TimeStampData[];
    constructor(workingDir: string, timeStamps: TimeStampData[]) {
        this._workingDir = workingDir;
        this._timeStamps = timeStamps;
    }
    compile() {
        logger.debug("TO IMPLEMENT");
        logger.debug(`Working dir: ${this._workingDir}`);
        for (const timestamp of this._timeStamps) {
            logger.debug(
                `Timestamp: ${timestamp.tag} at ${timestamp.timestamp} info: ${JSON.stringify(
                    timestamp.info
                )}`
            );
        }
    }
}
