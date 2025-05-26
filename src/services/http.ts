import http, { IncomingMessage, ServerResponse } from "node:http";

import * as ws from "#src/services/ws.ts";
import * as auth from "#src/services/auth.ts";
import * as config from "#src/config.ts";
import { Logger, parseBody, extractRequestInfo } from "#src/utils/utils.ts";
import { SESSION_CLOSE_CODE } from "#src/models/session.ts";
import { Channel, type ChannelStats } from "#src/models/channel.ts";

interface RequestInfo {
    /** Remote client address */
    remoteAddress: string;
    protocol: "http" | "https";
    /** Host header value */
    host: string;
    searchParams: URLSearchParams;
}
type RouteCallback = (
    req: IncomingMessage,
    res: ServerResponse,
    info: RequestInfo
) => Promise<ServerResponse> | ServerResponse;
interface RouteOptions {
    /** CORS origin header value */
    cors?: string;
    /** Route handler callback */
    callback?: RouteCallback;
}
interface RouteEntry extends RouteOptions {
    /** Allowed HTTP methods for this route */
    methods: string;
}
interface HttpStartOptions {
    httpInterface?: string;
    port?: number;
}

export const API_VERSION = 1;
const logger = new Logger("HTTP");

let httpServer: http.Server | undefined;

export async function start(options: HttpStartOptions = {}): Promise<void> {
    const { httpInterface = config.HTTP_INTERFACE, port = config.PORT } = options;
    logger.info("starting...");
    const routeListener = new RouteListener();
    setupRoutes(routeListener);
    httpServer = http.createServer(routeListener.listen);
    await new Promise<void>((resolve) => {
        httpServer!.listen(port, httpInterface, resolve);
    });
    logger.info(`http listening at ${httpInterface}:${port}`);
    await ws.start({ server: httpServer });
}

export function close(): void {
    ws.close();
    httpServer?.close();
    httpServer = undefined;
}

function setupRoutes(routeListener: RouteListener): void {
    routeListener.get(`/v${API_VERSION}/noop`, {
        callback: (req, res) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ result: "ok" }));
        }
    });
    routeListener.get(`/v${API_VERSION}/stats`, {
        callback: async (req, res) => {
            const channelStatsPromises: Promise<ChannelStats>[] = [];
            for (const channel of Channel.records.values()) {
                channelStatsPromises.push(channel.getStats());
            }
            const channelStats = await Promise.all(channelStatsPromises);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(channelStats));
        }
    });
    routeListener.get(`/v${API_VERSION}/channel`, {
        callback: async (req, res, { host, protocol, remoteAddress, searchParams }) => {
            try {
                const jsonWebToken = req.headers.authorization?.split(" ")[1];
                if (!jsonWebToken) {
                    logger.warn(
                        `${remoteAddress}: missing authorization header when creating channel`
                    );
                    res.statusCode = 401; // unauthorized
                    return res.end();
                }
                const claims = auth.verify(jsonWebToken);
                if (!claims.iss) {
                    logger.warn(`${remoteAddress}: missing issuer claim when creating channel`);
                    res.statusCode = 403; // forbidden
                    return res.end();
                }
                const channel = await Channel.create(remoteAddress, claims.iss, {
                    key: claims.key,
                    useWebRtc: searchParams.get("webRTC") !== "false"
                });
                res.setHeader("Content-Type", "application/json");
                res.statusCode = 200;
                return res.end(
                    JSON.stringify({
                        uuid: channel.uuid,
                        url: `${protocol}://${host}`
                    })
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn(`[${remoteAddress}] failed to create channel: ${errorMessage}`);
                res.statusCode = 500; // internal server error
                return res.end();
            }
        }
    });
    routeListener.post(`/v${API_VERSION}/disconnect`, {
        callback: async (req, res, { remoteAddress }) => {
            try {
                const jsonWebToken = await parseBody(req);
                if (typeof jsonWebToken !== "string") {
                    res.statusCode = 400; // bad request
                    return res.end();
                }
                const claims = auth.verify(jsonWebToken);
                for (const [channelUuid, sessionIds] of Object.entries(
                    claims.sessionIdsByChannel!
                )) {
                    const channel = Channel.records.get(channelUuid);
                    if (!channel) {
                        continue;
                    }
                    // only allow disconnection from own channels
                    if (channel.remoteAddress !== remoteAddress) {
                        logger.warn(
                            `[${remoteAddress}] tried to disconnect sessions from channel ${channelUuid} but is not the owner, requested by: ${remoteAddress}, authorized for: ${channel.remoteAddress}`
                        );
                        continue;
                    }
                    for (const sessionId of sessionIds) {
                        const session = channel.sessions.get(sessionId);
                        session?.close({
                            code: SESSION_CLOSE_CODE.KICKED,
                            cause: `/disconnect by ${remoteAddress}`
                        });
                    }
                }
                res.statusCode = 200;
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`[${remoteAddress}] failed to disconnect session: ${errorMessage}`);
                res.statusCode = 422; // unprocessable entity
            }
            return res.end();
        }
    });
}

class RouteListener {
    private readonly GETs = new Map<string, RouteEntry>();
    private readonly POSTs = new Map<string, RouteEntry>();
    private readonly OPTIONs = new Map<string, RouteEntry>();

    constructor() {
        this.listen = this.listen.bind(this);
    }

    get(pattern: string, options: RouteOptions): void {
        let methods = "GET";
        if (options.cors) {
            methods = "GET, OPTIONS";
            this.OPTIONs.set(pattern, {
                cors: options.cors,
                methods
            });
        }
        this.GETs.set(pattern, {
            ...options,
            methods
        });
    }

    post(pattern: string, options: RouteOptions): void {
        let methods = "POST";
        if (options.cors) {
            methods = "POST, OPTIONS";
            this.OPTIONs.set(pattern, {
                cors: options.cors,
                methods
            });
        }
        this.POSTs.set(pattern, {
            ...options,
            methods
        });
    }

    async listen(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const { host, protocol, remoteAddress, pathname, searchParams } = extractRequestInfo(req);
        logger.verbose(`${remoteAddress} - ${req.method} - ${req.url}`);
        res.statusCode = 404; // Default to Not Found
        let registeredRoutes: IterableIterator<[string, RouteEntry]>;
        switch (req.method) {
            case "OPTIONS":
                registeredRoutes = this.OPTIONs.entries();
                break;
            case "GET":
                registeredRoutes = this.GETs.entries();
                break;
            case "POST":
                registeredRoutes = this.POSTs.entries();
                break;
            default:
                logger.warn(`[${remoteAddress}] ${req.method} is not allowed on ${req.url}`);
                res.statusCode = 405; // Method not allowed
                res.end();
                return;
        }
        for (const [pattern, routeEntry] of registeredRoutes) {
            if (pathname === pattern) {
                if (routeEntry.cors) {
                    res.setHeader("Access-Control-Allow-Origin", routeEntry.cors);
                    res.setHeader("Access-Control-Allow-Methods", routeEntry.methods);
                    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                }
                if (routeEntry.callback) {
                    try {
                        await routeEntry.callback(req, res, {
                            host,
                            protocol,
                            remoteAddress,
                            searchParams
                        });
                        return;
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        logger.error(`[${remoteAddress}] error in ${req.url}: ${errorMessage}`);
                        res.statusCode = 500; // Internal server error
                        res.end();
                        return;
                    }
                }
                // if there is no callback, it is a preflight (OPTIONS) request
                res.statusCode = 202; // Accepted
                break;
            }
        }
        res.end();
    }
}
