import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

import * as config from "#src/config.ts";
import { WS_CLOSE_CODE } from "#src/shared/enums.ts";
import { Bus } from "#src/shared/bus.ts";
import { Logger, extractRequestInfo } from "#src/utils/utils.ts";
import { AuthenticationError, OvercrowdedError } from "#src/utils/errors.ts";
import { Session, SESSION_CLOSE_CODE } from "#src/models/session.ts";
import { Channel } from "#src/models/channel.ts";
import { verify } from "#src/services/auth.ts";

interface Credentials {
    channelUUID?: string;
    jwt: string;
}

const logger = new Logger("WS");
const unauthenticatedWebSockets = new Map<number, WebSocket>();
const authenticatedWebSockets = new Set<WebSocket>();
let pendingId = 0;
let server: WebSocketServer | undefined;

export async function start(
    options: ConstructorParameters<typeof WebSocketServer>[0]
): Promise<WebSocketServer> {
    logger.info("starting...");

    server = new WebSocketServer(options);

    /**
     * Handle new WebSocket connections
     * This is the entry point for clients - they connect via WebSocket,
     * provide authentication credentials, and if successful, a session is created
     */
    server.on("connection", (webSocket: WebSocket, req: IncomingMessage) => {
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

        // Handle first message (authentication)
        webSocket.once("message", (message: string) => {
            try {
                const credentials = JSON.parse(message);
                const session = connect(webSocket, {
                    channelUUID: credentials?.channelUUID,
                    jwt: credentials.jwt || credentials
                });
                session.remote = remoteAddress;
                logger.info(`session [${session.name}] authenticated and created`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn(`${errorMessage} : ${error instanceof Error ? error.cause ?? "" : ""}`);
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

export function closeAllWebSockets(closeCode: number = WS_CLOSE_CODE.CLEAN): void {
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
    authenticatedWebSockets.clear();
}

export function close(): void {
    closeAllWebSockets();
    server?.close();
    server = undefined;
}

/**
 * Establishes authenticated connection and creates session
 *
 * @param webSocket - WebSocket connection
 * @param credentials - Authentication credentials
 * @returns Created session
 * @throws {AuthenticationError} If authentication fails
 */
function connect(webSocket: WebSocket, credentials: Credentials): Session {
    const { channelUUID, jwt } = credentials;
    let channel = channelUUID ? Channel.records.get(channelUUID) : undefined;
    const authResult = verify(jwt, channel?.key);
    const { sfu_channel_uuid, session_id } = authResult;
    if (!channelUUID && sfu_channel_uuid) {
        // Cases where the channelUUID is not provided in the credentials for backwards compatibility with version 1.1 and earlier.
        channel = Channel.records.get(sfu_channel_uuid);
        if (channel?.key) {
            throw new AuthenticationError(
                "A channel with a key can only be accessed by providing a channelUUID in the credentials"
            );
        }
    }
    if (!channel) {
        throw new AuthenticationError("Channel does not exist");
    }
    if (!session_id) {
        throw new AuthenticationError("Malformed JWT payload");
    }
    webSocket.send(""); // client can start using ws after this message.
    const bus = new Bus(webSocket, { batchDelay: config.timeouts.busBatch });
    const { session } = Channel.join(channel.uuid, session_id);
    session.once("close", ({ code }: { code: string }) => {
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
    webSocket.once("close", (code: number, message: Buffer) => {
        authenticatedWebSockets.delete(webSocket);
        session.close({
            code: SESSION_CLOSE_CODE.WS_CLOSED,
            cause: `ws closed with code ${code}: ${message.toString()}`
        });
    });
    webSocket.on("error", (error: Error) => {
        session.close({
            code: SESSION_CLOSE_CODE.WS_ERROR,
            cause: error.message
        });
    });
    session.connect(bus).catch((error) => {
        logger.error(`Failed to connect session ${session.id}: ${error.message}`);
        session.close({
            code: SESSION_CLOSE_CODE.ERROR,
            cause: `Connection failed: ${error.message}`
        });
    });
    return session;
}
