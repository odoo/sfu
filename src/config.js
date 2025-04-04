import os from "node:os";

const FALSY_INPUT = new Set(["disable", "false", "none", "no", "0"]);

// ------------------------------------------------------------
// ------------------   ENV VARIABLES   -----------------------
// ------------------------------------------------------------

/**
 * This env variable is <<REQUIRED>>, the base64 encoded key used
 * for HMAC/SHA256 signing/verification of the JWTs used for authentication.
 * e.g: AUTH_KEY=u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=
 *
 * @type {string}
 */
export const AUTH_KEY = process.env.AUTH_KEY;
if (!AUTH_KEY && !process.env.JEST_WORKER_ID) {
    throw new Error(
        "AUTH_KEY env variable is required, it is not possible to authenticate requests without it"
    );
}
/**
 * This env variable is <<REQUIRED>>, the server needs to communicate its public IP to the clients as this is the IP
 * address that will be used for RTC connections. It can the local IP when testing locally.
 * e.g: PUBLIC_IP=190.165.1.70
 *
 * @type {string}
 */
export const PUBLIC_IP = process.env.PUBLIC_IP;
if (!PUBLIC_IP && !process.env.JEST_WORKER_ID) {
    throw new Error(
        "PUBLIC_IP env variable is required, clients cannot establish webRTC connections without it"
    );
}
/**
 * The RTC listening interface
 * e.g: RTC_INTERFACE=0.0.0.0
 *
 * @type {string}
 */
export const RTC_INTERFACE = process.env.RTC_INTERFACE || "0.0.0.0";
/**
 * Whether the server is behind a proxy,
 * If true, the server will use the headers "x-forwarded-for", "x-forwarded-proto" and "x-forwarded-host".
 *
 * e.g: PROXY=1
 *
 * @type {boolean}
 */
export const PROXY = Boolean(process.env.PROXY);
/**
 * The HTTP/WS interface
 * e.g: IP=localhost
 *
 * @type {string}
 */
export const HTTP_INTERFACE = process.env.HTTP_INTERFACE || "0.0.0.0";
/**
 * Port of HTTP and Websocket, defaults to standard port 8070.
 *
 * @type {number}
 */
export const PORT = Number(process.env.PORT) || 8070;
/**
 * The number of workers to spawn (up to core limits) to manage RTC servers.
 * 0 < NUM_WORKERS <= os.availableParallelism()
 *
 * @type {number}
 */
export const NUM_WORKERS = Math.min(
    Number(process.env.NUM_WORKERS) || Infinity,
    os.availableParallelism()
);
/**
 * A comma separated list of the audio codecs to use, if not provided the server will support all available codecs (listed below).
 * eg: AUDIO_CODECS=opus,PCMU,PCMA
 *
 * @type {string}
 */
export const AUDIO_CODECS = process.env.AUDIO_CODECS;

/**
 * A comma separated list of the video codecs to use, if not provided the server will support all available codecs (listed below).
 * eg: VIDEO_CODECS=VP8,H264,H264_1_2cb
 *
 * @type {string}
 */
export const VIDEO_CODECS = process.env.VIDEO_CODECS;
/**
 * Lower bound for the range of ports that the SFU server can use for UDP and TCP communication
 *
 * @type {number}
 */
export const RTC_MIN_PORT = (process.env.RTC_MIN_PORT && Number(process.env.RTC_MIN_PORT)) || 40000;
/**
 * Upper bound for the range of ports that the SFU server can use for UDP and TCP communication
 *
 * @type {number}
 */
export const RTC_MAX_PORT = (process.env.RTC_MAX_PORT && Number(process.env.RTC_MAX_PORT)) || 49999;
/**
 * The maximum size of the buffer in byes for incoming messages per session
 *
 * @type {number}
 */
export const MAX_BUF_IN = (process.env.MAX_BUF_IN && Number(process.env.MAX_BUF_IN)) || 0;
/**
 * The maximum size of the buffer in byes for outgoing messages per session
 *
 * @type {number}
 */
export const MAX_BUF_OUT = (process.env.MAX_BUF_OUT && Number(process.env.MAX_BUF_OUT)) || 0;
/**
 * The maximum incoming bitrate in bps per session,
 * This is what each user can upload.
 *
 * @type {number}
 */
export const MAX_BITRATE_IN =
    (process.env.MAX_BITRATE_IN && Number(process.env.MAX_BITRATE_IN)) || 8_000_000;
/**
 * The maximum outgoing bitrate in bps per session,
 * this is what each user can download.
 *
 * @type {number}
 */
export const MAX_BITRATE_OUT =
    (process.env.MAX_BITRATE_OUT && Number(process.env.MAX_BITRATE_OUT)) || 10_000_000;
/**
 * The maximum bitrate (in bps) for the highest encoding layer (simulcast) per video producer (= per video stream).
 * see: `maxBitrate` @ https://www.w3.org/TR/webrtc/#dictionary-rtcrtpencodingparameters-members
 *
 * @type {number}
 */
export const MAX_VIDEO_BITRATE =
    (process.env.MAX_VIDEO_BITRATE && Number(process.env.MAX_VIDEO_BITRATE)) || 4_000_000;
/**
 * The maximum amount of concurrent users per channel
 *
 * @type {number}
 */
export const CHANNEL_SIZE = (process.env.CHANNEL_SIZE && Number(process.env.CHANNEL_SIZE)) || 100;
/**
 * Log level of the mediasoup workers, defaults to "none".
 *
 * @type {"none" | "error" | "warn" | "debug"}
 */
export const WORKER_LOG_LEVEL = (process.env.DEBUG && process.env.WORKER_LOG_LEVEL) || "none";
/**
 * If not set, defaults to "error".
 * If set but not part of the available options, defaults to "error".
 *
 * @type {"none" | "error" | "warn" | "info" | "debug" | "verbose"}
 */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
/**
 * Prefixes yyyy-mm-dd hh:mm:ss,mmm to the logs.
 *
 * @type {boolean}
 */
export const LOG_TIMESTAMP = !FALSY_INPUT.has(process.env.LOG_TIMESTAMP);
/**
 * Colors the logs according to their level.
 *
 *  @type {boolean}
 */
export const LOG_COLOR = process.env.LOG_COLOR
    ? Boolean(process.env.LOG_COLOR)
    : process.stdout.isTTY;

// ------------------------------------------------------------
// --------------------   SETTINGS   --------------------------
// ------------------------------------------------------------

// timeouts in milliseconds
export const timeouts = Object.freeze({
    // how long a session can take to respond (to a ping or to a connection attempt)
    session: 10_000,
    // how long the websocket service waits for the authentication of a new websocket
    authentication: 10_000,
    // how long to wait between each time we ping the client to keep the session alive
    ping: 60_000,
    // how long to wait before we try to recover a session (consuming or producing media) after an error
    recovery: 2_000,
    // how long before a channel is closed after the last session leaves
    channel: 60 * 60_000,
    // how long to wait to gather messages before sending through the bus
    busBatch: process.env.JEST_WORKER_ID ? 10 : 300,
});

// how many errors can occur before the session is closed, recovery attempts will be made until this limit is reached
export const maxSessionErrors = 6;

/**
 * @type {import("mediasoup-client").types.ProducerOptions}
 * https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
 */
const baseProducerOptions = {
    stopTracks: false,
    disableTrackOnPause: false,
    zeroRtpOnPause: true,
};

export const rtc = Object.freeze({
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerSettings
    workerSettings: {
        logLevel: WORKER_LOG_LEVEL,
    },
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcServerOptions
    rtcServerOptions: {
        listenInfos: [
            {
                protocol: "udp",
                ip: RTC_INTERFACE,
                announcedAddress: PUBLIC_IP,
                portRange: {
                    min: RTC_MIN_PORT,
                    max: RTC_MAX_PORT,
                },
            },
            {
                protocol: "tcp",
                ip: RTC_INTERFACE,
                announcedAddress: PUBLIC_IP,
                portRange: {
                    min: RTC_MIN_PORT,
                    max: RTC_MAX_PORT,
                },
            },
        ],
    },
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    rtcTransportOptions: {
        maxSctpMessageSize: MAX_BUF_IN,
        sctpSendBufferSize: MAX_BUF_OUT,
    },
    producerOptionsByKind: {
        /** @type {import("mediasoup-client").types.ProducerOptions} */
        audio: baseProducerOptions,
        /** @type {import("mediasoup-client").types.ProducerOptions} */
        video: {
            ...baseProducerOptions,
            // for browsers using libwebrtc, values are set to allow simulcast layers to be made in that range
            codecOptions: {
                videoGoogleMinBitrate: 1_000,
                videoGoogleStartBitrate: 1_000_000,
                videoGoogleMaxBitrate: MAX_VIDEO_BITRATE * 2,
            },
            encodings: [
                { scaleResolutionDownBy: 4, maxBitrate: Math.floor(MAX_VIDEO_BITRATE / 4) },
                { scaleResolutionDownBy: 2, maxBitrate: Math.floor(MAX_VIDEO_BITRATE / 2) },
                { scaleResolutionDownBy: 1, maxBitrate: MAX_VIDEO_BITRATE },
            ],
        },
    },
});

// ------------------------------------------------------------
// ---------------------   CODECS   ---------------------------
// ------------------------------------------------------------

// These are the codecs that CAN be used.
// The codecs that WILL be used are based on the appropriate env variables

/**
 * in RFC 7874, WebRTC specification mandates support of the Opus, PCMA and PCMU audio codecs on all WebRTC compatible browsers,
 * and recommend the same for any WebRTC endpoint.
 * https://datatracker.ietf.org/doc/html/rfc7874#section-3
 */
export const audioCodecs = Object.freeze({
    opus: {
        // https://datatracker.ietf.org/doc/html/rfc7587
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
    },
    PCMU: {
        // https://datatracker.ietf.org/doc/html/rfc7655
        kind: "audio",
        mimeType: "audio/PCMU", // g711 mu-law
        clockRate: 8000,
        preferredPayloadType: 0,
        channels: 1,
    },
    PCMA: {
        // https://datatracker.ietf.org/doc/html/rfc7655
        kind: "audio",
        mimeType: "audio/PCMA", // g711 a-law
        clockRate: 8000,
        preferredPayloadType: 8,
        channels: 1,
    },
});

/**
 * in RFC 7742, WebRTC specification mandates support of the VP8 and H.264 video codecs on all WebRTC compatible browsers.
 * and recommend the same for any WebRTC endpoint.
 * https://datatracker.ietf.org/doc/html/rfc7742#section-5
 */
export const videoCodecs = Object.freeze({
    VP8: {
        // https://datatracker.ietf.org/doc/html/rfc7741
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
    },
    VP9: {
        // https://datatracker.ietf.org/doc/html/draft-ietf-payload-vp9-16
        kind: "video",
        mimeType: "video/VP9",
        clockRate: 90000,
        parameters: {
            "profile-id": 2, // mediasoup doc indicates that only id 0 and 2 are supported
        },
    },
    H264: {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "640028", // level 4.0 & high, supports 1920x1080 @ 30fps
        },
    },
    H264_1_2cb: {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42e00c", // level 1.2 & constrained baseline, as "mandated" by RFC 7742 section 6.2
        },
    },
    H264_1_3ch: {
        // https://datatracker.ietf.org/doc/html/rfc6184
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "640c0d", // level 1.3 & constrained high, as "recommended" by RFC 7742 section 6.2
        },
    },
});
