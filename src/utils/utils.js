/* eslint-disable no-console */
import * as config from "#src/config.js";

const ASCII = {
    color: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        white: "\x1b[37m",
        default: "\x1b[0m",
    },
};

export class Logger {
    /**
     * @param {string} name
     * @param {Object} [options]
     * @param {string} [options.logLevel]
     * @param {boolean} [options.timestamp]
     * @param {boolean} [options.useColors]
     */
    constructor(name = "", { logLevel, timestamp, useColors } = {}) {
        this._name = name;
        if (!(useColors ?? config.LOG_COLOR)) {
            this._colorize = (text) => text;
        }
        if (!(timestamp ?? config.LOG_TIMESTAMP)) {
            this._getTimeStamp = () => "";
        }
        switch (logLevel ?? config.LOG_LEVEL) {
            case "none":
                this.error = () => {};
            // eslint-disable-next-line no-fallthrough
            case "error":
                this.warn = () => {};
            // eslint-disable-next-line no-fallthrough
            case "warn":
                this.info = () => {};
            // eslint-disable-next-line no-fallthrough
            case "info":
                this.debug = () => {};
            // eslint-disable-next-line no-fallthrough
            case "debug":
                this.verbose = () => {};
        }
    }
    /**
     * @returns {string} a date of this format: `yyyy-mm-ddT hh:mm:ss,mmmZ`
     */
    _getTimeStamp() {
        const now = new Date();
        return now.toISOString() + " ";
    }
    /**
     * @param {Function} logFn The function used to log the message, e.g. `console.error`
     * @param {string} level formatted level, e.g. `:ERROR:`
     * @param {string} text
     * @param {string} [color]
     */
    _log(logFn, level, text, color) {
        logFn(
            `${this._getTimeStamp()}odoo-sfu ${this._colorize(
                `${level} [${this._name}] - ${text}`,
                color
            )}`
        );
    }
    /**
     * @param {string} text
     * @param {string} [color]
     * @returns {string}
     */
    _colorize(text, color = "") {
        return `${color}${text}${ASCII.color.default}`;
    }
    error(text) {
        this._log(console.error, `:ERROR:`, text, ASCII.color.red);
    }
    warn(text) {
        this._log(console.error, `:WARN:`, text, ASCII.color.yellow);
    }
    info(text) {
        this._log(console.log, `:INFO:`, text, ASCII.color.green);
    }
    debug(text) {
        this._log(console.log, `:DEBUG:`, text);
    }
    verbose(text) {
        this._log(console.log, `:VERBOSE:`, text, ASCII.color.white);
    }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {Object} [options]
 * @param {boolean} [options.json] if the response has to be JSON parsed
 * @returns {Promise<any>} a string, or any json serializable if option.json = true
 */
export function parseBody(req, { json } = {}) {
    return new Promise((resolve) => {
        const rawBody = [];
        req.on("data", (chunk) => {
            rawBody.push(chunk);
        });
        req.on("end", () => {
            const stringBody = Buffer.concat(rawBody).toString();
            resolve(json ? JSON.parse(stringBody) : stringBody);
        });
    });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ host: string, pathname: string, protocol: string, remoteAddress: string, searchParams: URLSearchParams }}
 */
export function extractRequestInfo(req) {
    const url = new URL(req.url, "http://localhost/"); // the second argument is required to parse the url correctly, but not relevant.
    const info = {
        host: `${config.PUBLIC_IP}:${config.PORT}`,
        pathname: url.pathname,
        protocol: "http",
        remoteAddress: req.socket.remoteAddress,
        searchParams: url.searchParams,
    };
    if (config.PROXY) {
        try {
            Object.assign(info, {
                host: req.headers["x-forwarded-host"]?.split(`,`)[0],
                protocol: req.headers["x-forwarded-proto"]?.split(`,`)[0],
                remoteAddress: req.headers["x-forwarded-for"]?.split(`,`)[0],
            });
        } catch {
            throw new Error("invalid 'x-forwarded-' header");
        }
    }
    return info;
}

/**
 * Returns the list of used codecs based on the configuration of the server.
 *
 * @return {import("mediasoup").types.RtpCodecCapability[]}
 */
export function getAllowedCodecs() {
    const codecs = [];
    if (config.AUDIO_CODECS) {
        const requestedAudioCodecs = config.AUDIO_CODECS.split(",");
        for (const codec of requestedAudioCodecs) {
            if (codec in config.audioCodecs) {
                codecs.push(config.audioCodecs[codec]);
            }
        }
    } else {
        codecs.push(...Object.values(config.audioCodecs));
    }
    if (config.VIDEO_CODECS) {
        const requestedVideoCodecs = config.VIDEO_CODECS.split(",");
        for (const codec of requestedVideoCodecs) {
            if (codec in config.videoCodecs) {
                codecs.push(config.videoCodecs[codec]);
            }
        }
    } else {
        codecs.push(...Object.values(config.videoCodecs));
    }
    return codecs;
}
