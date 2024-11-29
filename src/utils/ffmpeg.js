import child_process from "node:child_process";
import { EventEmitter } from "node:events";

import { Logger } from "#src/utils/utils.js";
import { recording, LOG_LEVEL } from "#src/config.js";

const logger = new Logger("FFMPEG");

/**
 * hard-coded ffmpeg sdp fragments for layouts with 1...4 videos
 * TODO make the right resizing and vstack/hstack params
 */

const drawText = (label, index) => `[${index}:v]drawtext=text='${label}':x=10:y=h-30[v${index}]`;

const SCREEN_LAYOUT = {
    1: (labels) => `a=filter:complex ${drawText(labels[0], 0)}; -map [v0]`,
    2: (labels) =>
        `a=filter:complex ${drawText(labels[0], 0)};${drawText(
            labels[1],
            1
        )};[v0][v1]hstack=inputs=2[v]; -map [v]`,
    3: (labels) =>
        `a=filter:complex ${drawText(labels[0], 0)};${drawText(
            labels[1],
            1
        )};[v0][v1]hstack=inputs=2[top];${drawText(
            labels[2],
            2
        )};[top][v2]vstack=inputs=2[v]; -map [v]`,
    4: (labels) =>
        `a=filter:complex ${drawText(labels[0], 0)};${drawText(
            labels[1],
            1
        )};[v0][v1]hstack=inputs=2[top];${drawText(labels[2], 2)};${drawText(
            labels[3],
            3
        )};[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[v]; -map [v]`,
};

/**
 * TODO
 * @param {RtpData[]} audioRtps
 * @param {RtpData[]} cameraRtps
 * @param {RtpData[]} screenRtps
 * @return {string}
 */
function formatFfmpegSdp({ audioRtps, screenRtps, cameraRtps }) {
    logger.info(`TODO: ${screenRtps}`);
    const sdp = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=FFmpeg", "c=IN IP4 127.0.0.1", "t=0 0"];
    for (const audioRtp of audioRtps) {
        sdp.push(`m=audio ${audioRtp.port} RTP/AVP ${audioRtp.payloadType}`);
        sdp.push(`a=rtpmap:${audioRtp.payloadType} ${audioRtp.codec}/${audioRtp.clockRate}`);
        sdp.push(`a=sendonly`);
    }
    sdp.push(`-c:a aac -b:a 160k -ac 2 -filter_complex amerge=inputs=${audioRtps.length}`);
    if (cameraRtps.length > 0) {
        const layout = SCREEN_LAYOUT[cameraRtps.length];
        if (!layout) {
            throw new Error(`unsupported layout for ${cameraRtps.length} videos`);
        }
        sdp.push("-c:v", "mp4v");
        for (const videoRtp of cameraRtps) {
            sdp.push(`m=video ${videoRtp.port} RTP/AVP ${videoRtp.payloadType}`);
            sdp.push(`a=rtpmap:${videoRtp.payloadType} ${videoRtp.codec}/${videoRtp.clockRate}`);
            sdp.push(`a=sendonly`);
        }
        sdp.push(`-filter_complex`, layout(cameraRtps.map((rtp) => rtp.label)));
    }
    return sdp.join("\n");
}

/**
 * Wraps the FFMPEG process
 * TODO move in own file
 */
export class FFMPEG extends EventEmitter {
    /** @type {child_process.ChildProcess} */
    _process;
    /** @type {string} */
    _filePath;

    get _processArgs() {
        const args = [
            // TODO
            "-protocol_whitelist",
            "pipe,udp,rtp",
            "-fflags",
            "+genpts",
            "-f",
            "sdp",
            "-i",
            "pipe:0",
            "-f",
            recording.fileType,
            this._filePath,
        ];
        if (LOG_LEVEL === "debug") {
            args.unshift("-loglevel", "debug");
        }
        return args;
    }

    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        super();
        this._filePath = filePath;
    }

    /**
     * @param {Object} rtpInputs
     * @param {RtpData[]} rtpInputs.audioRtps
     * @param {RtpData[]} rtpInputs.screenRtps
     * @param {RtpData[]} rtpInputs.cameraRtps
     */
    async start(rtpInputs) {
        const sdp = formatFfmpegSdp(rtpInputs);
        this._process = child_process.spawn("ffmpeg", this._processArgs, {
            stdio: ["pipe", "pipe", process.stderr],
        });

        if (!this._process.stdin.writable) {
            throw new Error("FFMPEG stdin not writable.");
        }
        this._process.stdin.write(sdp); // TODO (maybe pass args earlier)
        this._process.stdin.end();
        this._process.on("close", (code) => {
            if (code === 0) {
                this.emit("success");
            }
        });

        logger.debug(
            `FFMPEG process (pid:${this._process.pid}) spawned, outputting to ${this._filePath}`
        );
    }

    kill() {
        this._process?.kill("SIGINT");
    }
}
