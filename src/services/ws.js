import { WebSocketServer } from "ws";

import * as config from "#src/config.js";
import { WS_CLOSE_CODE } from "#src/shared/enums.js";
import { Bus } from "#src/shared/bus.js";
import { Logger, extractRequestInfo } from "#src/utils/utils.js";
import { AuthenticationError, OvercrowdedError } from "#src/utils/errors.js";
import { SESSION_CLOSE_CODE } from "#src/models/session.js";
import { Channel } from "#src/models/channel.js";
import { verify } from "#src/services/auth.js";

const logger = new Logger("WS");
/** @type {Map<number, import("ws").WebSocket>} */
const unauthenticatedWebSockets = new Map();
const authenticatedWebSockets = new Set();
let pendingId = 0;
/** @type {import("ws").WebSocketServer} */
let server;

/**
 * @param {Parameters<import("ws").WebSocketServer>[0]} options WebSocketServer options
 * @returns {Promise<import("ws").WebSocketServer>}
 */
export async function start(options) {
    logger.info("starting...");
    server = new WebSocketServer(options);
    /**
     * This is the entry point for clients, from here the client initiates a webSocket connection to the server,
     * provides the secret/jwt for authentication, and if the authentication is successful, the server creates a session
     * and connects it, otherwise the server closes the webSocket (and no rtc session is created).
     */
    server.on("connection", (webSocket, req) => {
        const { remoteAddress } = extractRequestInfo(req);
        logger.info(`new webSocket connection from ${remoteAddress}`);
        const currentPendingId = pendingId++;
        unauthenticatedWebSockets.set(currentPendingId, webSocket);
        const timeout = setTimeout(() => {
            if (webSocket.readyState > webSocket.OPEN) {
                return;
            }
            webSocket.close(WS_CLOSE_CODE.TIMEOUT);
            logger.warn(`${remoteAddress} WS timed out, closing it`);
            unauthenticatedWebSockets.delete(currentPendingId);
        }, config.timeouts.authentication);
        webSocket.once("message", async (message) => {
            try {
                const jsonWebToken = JSON.parse(message);
                const session = await connect(webSocket, jsonWebToken);
                session.remote = remoteAddress;
                logger.info(`session [${session.name}] authenticated and created`);
                webSocket.send(); // client can start using ws after this message.
            } catch (error) {
                logger.warn(`${error.message} : ${error.cause ?? ""}`);
                if (error instanceof AuthenticationError) {
                    webSocket.close(WS_CLOSE_CODE.AUTHENTICATION_FAILED);
                } else if (error instanceof OvercrowdedError) {
                    webSocket.close(WS_CLOSE_CODE.CHANNEL_FULL);
                } else {
                    webSocket.close(WS_CLOSE_CODE.ERROR);
                }
            }
            unauthenticatedWebSockets.delete(currentPendingId);
            authenticatedWebSockets.add(webSocket);
            clearTimeout(timeout);
        });
    });
    return server;
}

/**
 * @param {WS_CLOSE_CODE[keyof WS_CLOSE_CODE]} [closeCode]
 */
export function closeAllWebSockets(closeCode = WS_CLOSE_CODE.CLEAN) {
    for (const webSocket of authenticatedWebSockets) {
        if (webSocket.readyState < webSocket.CLOSING) {
            webSocket.close(closeCode);
        }
    }
    for (const webSocket of unauthenticatedWebSockets.values()) {
        if (webSocket.readyState < webSocket.CLOSING) {
            webSocket.close(closeCode);
        }
    }
    unauthenticatedWebSockets.clear();
}

export function close() {
    closeAllWebSockets();
    server?.close();
}

/**
 * @param {import("ws").WebSocket} webSocket
 * @param {string} jsonWebToken
 */
async function connect(webSocket, jsonWebToken) {
    /** @type {{sfu_channel_uuid: string, session_id: number, ice_servers: Object[] }} */
    const authResult = await verify(jsonWebToken);
    const { sfu_channel_uuid, session_id, ice_servers } = authResult;
    if (!sfu_channel_uuid || !session_id) {
        throw new AuthenticationError("Malformed JWT payload");
    }
    const bus = new Bus(webSocket, { batchDelay: config.timeouts.busBatch });
    const { session } = Channel.join(sfu_channel_uuid, session_id);
    session.once("close", ({ code }) => {
        let wsCloseCode = WS_CLOSE_CODE.CLEAN;
        switch (code) {
            case SESSION_CLOSE_CODE.ERROR:
                wsCloseCode = WS_CLOSE_CODE.ERROR;
                break;
            case SESSION_CLOSE_CODE.KICKED:
            case SESSION_CLOSE_CODE.REPLACED:
            case SESSION_CLOSE_CODE.CHANNEL_CLOSED:
                wsCloseCode = WS_CLOSE_CODE.KICKED;
                break;
            case SESSION_CLOSE_CODE.C_TIMEOUT:
            case SESSION_CLOSE_CODE.P_TIMEOUT:
                wsCloseCode = WS_CLOSE_CODE.TIMEOUT;
                break;
        }
        if (webSocket.readyState < webSocket.CLOSING) {
            webSocket.close(wsCloseCode);
        }
    });
    webSocket.once("close", (code, message) => {
        authenticatedWebSockets.delete(webSocket);
        session.close({
            code: SESSION_CLOSE_CODE.WS_CLOSED,
            cause: `ws closed with code ${code}: ${message}`,
        });
    });
    webSocket.on("error", (error) =>
        session.close({ code: SESSION_CLOSE_CODE.WS_ERROR, cause: error.message })
    );
    // Not awaiting connect
    session.connect(bus, ice_servers);
    return session;
}
