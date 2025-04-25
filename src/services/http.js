import http from "node:http";

import * as ws from "#src/services/ws.js";
import * as auth from "#src/services/auth.js";
import * as config from "#src/config.js";
import { Logger, parseBody, extractRequestInfo } from "#src/utils/utils.js";
import { SESSION_CLOSE_CODE } from "#src/models/session.js";
import { Channel } from "#src/models/channel.js";

/**
 * @typedef {function} routeCallback
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {Object} param2
 * @param {string} param2.remoteAddress
 * @param {string} param2.protocol
 * @param {string} param2.host
 * @param {URLSearchParams} param2.searchParams
 * @return {http.ServerResponse}
 */

export const API_VERSION = 1;
const logger = new Logger("HTTP");
let httpServer;

/**
 * @param {Object} [options]
 * @param {string} [options.httpInterface]
 * @param {number} [options.port]
 */
export async function start({ httpInterface = config.HTTP_INTERFACE, port = config.PORT } = {}) {
    logger.info("starting...");
    const routeListener = new RouteListener();
    routeListener.get(`/v${API_VERSION}/noop`, {
        callback: (req, res) => {
            res.statusCode = 200;
            return res.end(JSON.stringify({ result: "ok" }));
        },
    });
    routeListener.get(`/v${API_VERSION}/stats`, {
        callback: async (req, res) => {
            const proms = [];
            for (const channel of Channel.records.values()) {
                proms.push(channel.getStats());
            }
            const channelStats = await Promise.all(proms);
            res.statusCode = 200;
            return res.end(JSON.stringify(channelStats));
        },
    });
    routeListener.get(`/v${API_VERSION}/channel`, {
        callback: async (req, res, { host, protocol, remoteAddress, searchParams }) => {
            try {
                const jsonWebToken = req.headers.authorization?.split(" ")[1];
                /** @type {{ iss: string, key: string || undefined }} */
                const claims = auth.verify(jsonWebToken);
                if (!claims.iss) {
                    logger.warn(`${remoteAddress}: missing issuer claim when creating channel`);
                    res.statusCode = 403; // forbidden
                    return res.end();
                }
                const channel = await Channel.create(remoteAddress, claims.iss, {
                    key: claims.key,
                    useWebRtc: searchParams.get("webRTC") !== "false",
                });
                res.setHeader("Content-Type", "application/json");
                res.statusCode = 200;
                return res.end(
                    JSON.stringify({
                        uuid: channel.uuid,
                        url: `${protocol}://${host}`,
                    })
                );
            } catch (error) {
                logger.warn(`[${remoteAddress}] failed to create channel: ${error.message}`);
            }
            return res.end();
        },
    });
    routeListener.post(`/v${API_VERSION}/disconnect`, {
        callback: async (req, res, { remoteAddress }) => {
            try {
                const jsonWebToken = await parseBody(req);
                /** @type {{ sessionIdsByChannel: Object<string, number[]> }} */
                const claims = auth.verify(jsonWebToken);
                for (const [channelUuid, sessionIds] of Object.entries(
                    claims.sessionIdsByChannel
                )) {
                    const channel = Channel.records.get(channelUuid);
                    if (!channel) {
                        return res.end();
                    }
                    if (!channel.remoteAddress === remoteAddress) {
                        logger.warn(
                            `[${remoteAddress}] tried to disconnect sessions from channel ${channelUuid} but is not the owner`
                        );
                        return res.end();
                    }
                    for (const sessionId of sessionIds) {
                        const session = channel.sessions.get(sessionId);
                        session?.close(SESSION_CLOSE_CODE.KICKED, {
                            cause: `/disconnect by ${remoteAddress}`,
                        });
                    }
                }
                res.statusCode = 200;
            } catch (error) {
                logger.error(`[${remoteAddress}] failed to disconnect session: ${error.message}`);
                res.statusCode = 422; // unprocessable entity
            }
            return res.end();
        },
    });
    httpServer = http.createServer(routeListener.listen);
    await new Promise((resolve) => {
        httpServer.listen(port, httpInterface, resolve);
    });
    logger.info(`http listening at ${httpInterface}:${port}`);
    await ws.start({ server: httpServer });
}

export function close() {
    ws.close();
    httpServer?.close();
}

class RouteListener {
    /** @type {Map<string, { callback: routeCallback, cors: string, methods: string }>} */
    GETs = new Map();
    /** @type {Map<string, { callback: routeCallback, cors: string, methods: string }>} */
    POSTs = new Map();
    /** @type {Map<string, { cors: string, methods: string }>} */
    OPTIONs = new Map();

    constructor() {
        this.listen = this.listen.bind(this);
    }

    /**
     * @param {string} pattern
     * @param {{ cors: string, callback: routeCallback }} options
     */
    get(pattern, { cors, callback }) {
        let methods = "GET";
        if (cors) {
            methods = "GET, OPTIONS";
            this.OPTIONs.set(pattern, { cors, methods });
        }
        this.GETs.set(pattern, { cors, methods, callback });
    }

    /**
     * @param {string} pattern
     * @param {{ cors: string, callback: routeCallback }} options
     */
    post(pattern, { cors, callback }) {
        let methods = "POST";
        if (cors) {
            methods = "POST, OPTIONS";
            this.OPTIONs.set(pattern, { cors, methods });
        }
        this.POSTs.set(pattern, { cors, methods, callback });
    }

    /**
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    async listen(req, res) {
        const { host, protocol, remoteAddress, pathname, searchParams } = extractRequestInfo(req);
        logger.verbose(`${remoteAddress} - ${req.method} - ${req.url}`);
        res.statusCode = 404; // Not found
        let registeredRoutes;
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
                return res.end();
        }
        for (const [pattern, options] of registeredRoutes) {
            if (pathname === pattern) {
                if (options?.cors) {
                    res.setHeader("Access-Control-Allow-Origin", options.cors);
                    res.setHeader("Access-Control-Allow-Methods", options.methods);
                    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                }
                if (options?.callback) {
                    try {
                        return await options.callback(req, res, {
                            host,
                            protocol,
                            remoteAddress,
                            searchParams,
                        });
                    } catch (error) {
                        logger.error(
                            `[${remoteAddress}] ${error.message} when calling ${req.url}: ${error.message}`
                        );
                        res.statusCode = 500; // Internal server error
                        return res.end();
                    }
                }
                // if there is no callback, it is a preflight (OPTIONS) request
                res.statusCode = 202; // Accepted
                break;
            }
        }
        return res.end();
    }
}
