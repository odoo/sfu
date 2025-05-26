/* eslint-disable no-console */
import type { IncomingMessage } from "node:http";

import type { RtpCodecCapability } from "mediasoup/node/lib/types";

import * as config from "#src/config.ts";
import type { JSONSerializable } from "#src/shared/types";

const ASCII = {
    color: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        white: "\x1b[37m",
        default: "\x1b[0m"
    }
} as const;

export enum LogLevel {
    NONE = "none",
    ERROR = "error",
    WARN = "warn",
    INFO = "info",
    DEBUG = "debug",
    VERBOSE = "verbose"
}

export interface LoggerOptions {
    logLevel?: LogLevel | string;
    timestamp?: boolean;
    useColors?: boolean;
}

type LogFunction = (message: string) => void;

export interface RequestInfo {
    /** Server host and port */
    host: string;
    pathname: string;
    protocol: "http" | "https";
    /** Remote client address */
    remoteAddress: string;
    searchParams: URLSearchParams;
}

export interface ParseBodyOptions {
    /** Whether to JSON parse the response */
    json?: boolean;
}

export class Logger {
    private readonly _name: string;
    private readonly _colorize: (text: string, color?: string) => string;
    private readonly _getTimeStamp: () => string;

    /**
     * @param name - Logger name/category
     * @param options - Logger configuration options
     */
    constructor(name: string = "", options: LoggerOptions = {}) {
        this._name = name;
        const {
            logLevel = config.LOG_LEVEL,
            timestamp = config.LOG_TIMESTAMP,
            useColors = config.LOG_COLOR
        } = options;
        this._colorize = useColors ? this._applyColor.bind(this) : (text: string) => text;
        this._getTimeStamp = timestamp ? this._generateTimeStamp.bind(this) : () => "";
        this._configureLevelFiltering(logLevel);
    }
    error(text: string): void {
        this._log(console.error, ":ERROR:", text, ASCII.color.red);
    }
    warn(text: string): void {
        this._log(console.error, ":WARN:", text, ASCII.color.yellow);
    }
    info(text: string): void {
        this._log(console.log, ":INFO:", text, ASCII.color.green);
    }
    debug(text: string): void {
        this._log(console.log, ":DEBUG:", text);
    }
    verbose(text: string): void {
        this._log(console.log, ":VERBOSE:", text, ASCII.color.white);
    }
    private _generateTimeStamp(): string {
        const now = new Date();
        return now.toISOString() + " ";
    }
    /**
     * @param logFn - Console function to use (console.log or console.error)
     * @param level - Formatted level string (e.g. ":ERROR:")
     * @param text - Message text
     * @param color - Optional ANSI color code
     */
    private _log(logFn: LogFunction, level: string, text: string, color?: string): void {
        const timestamp = this._getTimeStamp();
        const formattedMessage = `${level} [${this._name}] - ${text}`;
        const colorizedMessage = this._colorize(formattedMessage, color);

        logFn(`${timestamp}odoo-sfu ${colorizedMessage}`);
    }
    /**
     * @param text - Text to colorize
     * @param color - ANSI color code
     * @returns Colorized text
     */
    private _applyColor(text: string, color: string = ""): string {
        return `${color}${text}${ASCII.color.default}`;
    }
    private _configureLevelFiltering(logLevel: LogLevel | string): void {
        // Create no-op function for disabled levels, I expect the JS engine to inline it
        const noop = (): void => {};
        switch (logLevel) {
            // @ts-expect-error fallthrough
            case LogLevel.NONE:
                this.error = noop;
            // @ts-expect-error fallthrough
            case LogLevel.ERROR:
                this.warn = noop;
            // @ts-expect-error fallthrough
            case LogLevel.WARN:
                this.info = noop;
            // @ts-expect-error fallthrough
            case LogLevel.INFO:
                this.debug = noop;
            // @ts-expect-error fallthrough
            case LogLevel.DEBUG:
                this.verbose = noop;
            // fallthrough
            default:
                // All levels enabled
                break;
        }
    }
}

/**
 * Parses HTTP request body
 *
 * @param req - HTTP request object
 * @param options - Parsing options
 * @returns Promise resolving to parsed body (string or JSON)
 */
export function parseBody(
    req: IncomingMessage,
    options: ParseBodyOptions = {}
): Promise<JSONSerializable | string> {
    const { json = false } = options;
    return new Promise((resolve) => {
        const rawBody: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            rawBody.push(chunk);
        });
        req.on("end", () => {
            const stringBody = Buffer.concat(rawBody).toString();
            resolve(json ? JSON.parse(stringBody) : stringBody);
        });
    });
}

/**
 * Extracts useful information from HTTP request
 *
 * @param req - HTTP request object
 * @returns Parsed request information
 */
export function extractRequestInfo(req: IncomingMessage): RequestInfo {
    if (!req.url) {
        throw new Error("Request URL is required");
    }
    // Parse URL with dummy base since we only need pathname and search params
    const url = new URL(req.url, "http://localhost/");
    const info: RequestInfo = {
        host: `${config.PUBLIC_IP}:${config.PORT}`,
        pathname: url.pathname,
        protocol: "http",
        remoteAddress: req.socket.remoteAddress || "unknown",
        searchParams: url.searchParams
    };
    if (config.PROXY) {
        try {
            const forwardedHost = req.headers["x-forwarded-host"];
            const forwardedProto = req.headers["x-forwarded-proto"];
            const forwardedFor = req.headers["x-forwarded-for"];
            if (forwardedHost) {
                info.host = Array.isArray(forwardedHost)
                    ? forwardedHost[0]
                    : forwardedHost.split(",")[0];
            }
            if (forwardedProto) {
                const protocol = Array.isArray(forwardedProto)
                    ? forwardedProto[0]
                    : forwardedProto.split(",")[0];
                info.protocol = protocol === "https" ? "https" : "http";
            }
            if (forwardedFor) {
                info.remoteAddress = Array.isArray(forwardedFor)
                    ? forwardedFor[0]
                    : forwardedFor.split(",")[0];
            }
        } catch {
            throw new Error("invalid 'x-forwarded-' header");
        }
    }
    return info;
}

/**
 * Returns the list of used codecs based on the configuration of the server.
 */
export function getAllowedCodecs(): RtpCodecCapability[] {
    const codecs: RtpCodecCapability[] = [];
    if (config.AUDIO_CODECS) {
        const requestedAudioCodecs = config.AUDIO_CODECS.split(",");
        for (const codec of requestedAudioCodecs) {
            const codecConfig = config.audioCodecs[codec];
            if (codecConfig) {
                codecs.push(codecConfig);
            }
        }
    } else {
        codecs.push(...Object.values(config.audioCodecs));
    }
    if (config.VIDEO_CODECS) {
        const requestedVideoCodecs = config.VIDEO_CODECS.split(",");
        for (const codec of requestedVideoCodecs) {
            const codecConfig = config.videoCodecs[codec];
            if (codecConfig) {
                codecs.push(codecConfig);
            }
        }
    } else {
        codecs.push(...Object.values(config.videoCodecs));
    }
    return codecs;
}
