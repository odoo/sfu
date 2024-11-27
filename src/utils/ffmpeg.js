import child_process from "node:child_process";
import { EventEmitter } from "node:events";

import { Logger } from "#src/utils/utils.js";
import { recording, LOG_LEVEL } from "#src/config.js";

const logger = new Logger("FFMPEG");

/**
 * hard-coded ffmpeg sdp fragments for layouts with 1...4 videos
 * TODO make the right resizing and vstack/hstack params
 */
const LAYOUT = {
    1: "",
    2: "a=filter:complex [0:v][1:v]hstack=inputs=2[v]; -map [v]",
    3: "a=filter:complex [0:v][1:v]hstack=inputs=2[top];[top][2:v]vstack=inputs=2[v]; -map [v]",
    4: "a=filter:complex [0:v][1:v]hstack=inputs=2[top];[2:v][3:v]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[v]; -map [v]",
};

/**
 * TODO
 * @param {RtpData[]} audioRtps
 * @param {RtpData[]} videoRtps
 * @return {string}
 */
function formatFfmpegSdp(audioRtps, videoRtps) {
    const sdp = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=FFmpeg", "c=IN IP4 127.0.0.1", "t=0 0"];
    const layout = LAYOUT[videoRtps.length];
    if (!layout) {
        throw new Error(`unsupported layout for ${videoRtps.length} videos`);
    }
    for (const audioRtp of audioRtps) {
        sdp.push(`m=audio ${audioRtp.port} RTP/AVP ${audioRtp.payloadType}`);
        sdp.push(`a=rtpmap:${audioRtp.payloadType} ${audioRtp.codec}/${audioRtp.clockRate}`);
        sdp.push(`a=sendonly`);
    }
    sdp.push(`-c:a aac -b:a 160k -ac 2 -filter_complex amerge=inputs=${audioRtps.length}`);
    if (videoRtps.length > 0) {
        sdp.push(
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof", // fragmented for streaming although could use another format if dropping the pipe feature
            "-c:v",
            "mp4v"
        );
        for (const videoRtp of videoRtps) {
            sdp.push(`m=video ${videoRtp.port} RTP/AVP ${videoRtp.payloadType}`);
            sdp.push(`a=rtpmap:${videoRtp.payloadType} ${videoRtp.codec}/${videoRtp.clockRate}`);
            sdp.push(`a=sendonly`);
        }
    }
    // TODO, layout only a small part of the full SDP.
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

    get _args() {
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
     * @param {RtpData[]} audioRtps
     * @param {RtpData[]} videoRtps
     */
    async spawn(audioRtps, videoRtps) {
        const sdp = formatFfmpegSdp(audioRtps, videoRtps);
        this._process = child_process.spawn("ffmpeg", this._args, {
            stdio: ["pipe", "pipe", process.stderr],
        });

        if (!this._process.stdin.writable) {
            throw new Error("FFMPEG stdin not writable.");
        }
        this._process.stdin.write(sdp); // TODO (maybe pass args earlier)
        this._process.stdin.end();

        this._process.stdout.on("data", (chunk) => {
            this.emit("data", chunk); // Emit data chunks as they become available
            // may need to ues this to pipe to request if file stream does not work
        });

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
