import http, { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import * as ws from "#src/core/services/ws.ts";
import * as auth from "#src/core/services/auth.ts";
import * as config from "#src/config.ts";
import { Logger, parseBody, extractRequestInfo } from "#src/utils/utils.ts";
import { AuthenticationError } from "#src/utils/errors.ts";
import { SESSION_CLOSE_CODE, type SessionId } from "#src/core/models/session.ts";
import { Channel, type ChannelStats } from "#src/core/models/channel.ts";

type RequestInfo = {
    /** Remote client address */
    remoteAddress: string;
    protocol: "http" | "https";
    /** Host header value */
    host: string;
    searchParams: URLSearchParams;
};
type RouteCallback = (
    req: IncomingMessage,
    res: ServerResponse,
    info: RequestInfo
) => Promise<ServerResponse> | ServerResponse;
type HttpChannelClaims = {
    key?: string;
    keySeed?: string;
};
type HttpDisconnectClaims = {
    sessionIdsByChannel: Record<string, SessionId[]>;
};
type HttpStartOptions = {
    httpInterface?: string;
    port?: number;
};

export const API_VERSION = 1;
const logger = new Logger("HTTP");

let httpServer: http.Server | undefined;

export async function start(options: HttpStartOptions = {}): Promise<number> {
    const { httpInterface = config.HTTP_INTERFACE, port = config.PORT } = options;
    const routeListener = new RouteListener();
    setupRoutes(routeListener);
    httpServer = http.createServer(routeListener.listen);
    httpServer.listen(port, httpInterface);
    await once(httpServer, "listening");
    const listeningPort = (httpServer.address() as AddressInfo).port;
    logger.info(`http listening at ${httpInterface}:${listeningPort}`);
    await ws.start({ server: httpServer });
    return listeningPort;
}

export async function close(): Promise<void> {
    ws.close();
    const server = httpServer;
    httpServer = undefined;
    if (!server) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function setupRoutes(routeListener: RouteListener): void {
    routeListener.get(`/v${API_VERSION}/noop`, (req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ result: "ok" }));
    });
    routeListener.get(`/v${API_VERSION}/stats`, async (req, res) => {
        const channelStatsPromises: Promise<ChannelStats>[] = [];
        for (const channel of Channel.records.values()) {
            channelStatsPromises.push(channel.getStats());
        }
        const channelStats = await Promise.all(channelStatsPromises);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(channelStats));
    });
    /**
     * GET /v1/channel
     *
     * Provides a channel to host a rtc conference between user sessions.
     *
     * ### Headers
     * - required:`Authorization: Bearer <JWT>`
     *      The JWT must include an `exp` claim and an `iss` (issuer) claim identifying the caller.
     *      `claim.iss` ensures idempotency: only one channel is created per unique issuer.
     *      To create multiple channels, the caller must provide a distinct `iss` for each request.
     *
     * ### Query Parameters
     * - optional:`webRTC` defaults to `"true"`.
     *      When set to `"false"`, disables WebRTC setup and creates a non-media channel.
     * - optional:`recordingAddress`.
     *      If provided, enables recording and specifies the address
     *      that the SFU can contact to get routing instructions for the recording.
     *
     * ### Responses
     * - `200 OK` returns `{ uuid: string, url: string }`
     * - `400 Bad Request` provided a `recordingAddress` without a `key` or `keySeed` claim
     * - `401 Unauthorized` missing or invalid Authorization header
     * - `403 Forbidden` missing `iss` claim
     * - `500 Internal Server Error` failed to create the channel
     */
    routeListener.get(
        `/v${API_VERSION}/channel`,
        async (req, res, { host, protocol, remoteAddress, searchParams }) => {
            try {
                const jsonWebToken = req.headers.authorization?.split(" ")[1];
                if (!jsonWebToken) {
                    logger.warn(
                        `${remoteAddress}: missing authorization header when creating channel`
                    );
                    res.statusCode = 401;
                    return res.end();
                }
                const claims = auth.verify<HttpChannelClaims>(jsonWebToken);
                if (!claims.iss) {
                    logger.warn(`${remoteAddress}: missing issuer claim when creating channel`);
                    res.statusCode = 403; // forbidden
                    return res.end();
                }
                const recordingAddress = searchParams.get("recordingAddress");
                const channelKey = claims.keySeed
                    ? auth.deriveChannelKey(claims.keySeed)
                    : claims.key;
                if (recordingAddress && !channelKey) {
                    logger.warn(
                        `${remoteAddress}: missing key or key seed when creating channel with recording address`
                    );
                    res.statusCode = 400; // bad request
                    return res.end();
                }
                const channel = await Channel.create(remoteAddress, claims.iss, {
                    key: channelKey,
                    useWebRtc: searchParams.get("webRTC") !== "false",
                    recordingAddress
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
                if (error instanceof AuthenticationError) {
                    logger.warn(
                        `[${remoteAddress}] failed to authenticate channel request: ${errorMessage}`
                    );
                    res.statusCode = 401;
                } else {
                    logger.error(`[${remoteAddress}] failed to create channel: ${errorMessage}`);
                    res.statusCode = 500; // internal server error
                }
                return res.end();
            }
        }
    );
    /**
     * POST /v1/disconnect
     *
     * Disconnects specific sessions from their respective channels.
     * Only the creator of a channel (matching remote address) is authorized to disconnect sessions from it.
     *
     * ### Body
     * - required: A string containing a signed JWT.
     *
     * ### JWT Claims
     * - required: `exp: number`
     *      Expiration time in seconds since the Unix epoch.
     * - required: `sessionIdsByChannel: Record<string, SessionId[]>`
     *      A mapping where keys are channel UUIDs and values are arrays of session IDs to be kicked.
     *
     * ### Responses
     * - `200 OK` sessions successfully processed for disconnection.
     * - `400 Bad Request` the request body is not a valid string.
     * - `422 Unprocessable Entity` invalid JWT or error during processing.
     */
    routeListener.post(`/v${API_VERSION}/disconnect`, async (req, res, { remoteAddress }) => {
        try {
            const jsonWebToken = await parseBody(req);
            if (typeof jsonWebToken !== "string") {
                res.statusCode = 400; // bad request
                return res.end();
            }
            const claims = auth.verify<HttpDisconnectClaims>(jsonWebToken);
            for (const [channelUuid, sessionIds] of Object.entries(claims.sessionIdsByChannel)) {
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
    });
}

class RouteListener {
    private readonly GETs = new Map<string, RouteCallback>();
    private readonly POSTs = new Map<string, RouteCallback>();

    constructor() {
        this.listen = this.listen.bind(this);
    }

    get(pattern: string, callback: RouteCallback): void {
        this.GETs.set(pattern, callback);
    }

    post(pattern: string, callback: RouteCallback): void {
        this.POSTs.set(pattern, callback);
    }

    async listen(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const { host, protocol, remoteAddress, pathname, searchParams } = extractRequestInfo(req);
        logger.verbose(`${remoteAddress} - ${req.method} - ${req.url}`);
        res.statusCode = 404; // Default to Not Found
        let registeredRoutes: IterableIterator<[string, RouteCallback]>;
        switch (req.method) {
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
        for (const [pattern, callback] of registeredRoutes) {
            if (pathname === pattern) {
                try {
                    await callback(req, res, {
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
        }
        res.end();
    }
}
