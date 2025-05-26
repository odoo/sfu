import { WebSocket } from "ws";
import { Device } from "mediasoup-client";
import { FakeHandler } from "mediasoup-client/lib/handlers/FakeHandler";
import * as fakeParameters from "mediasoup-client/lib/test/fakeParameters";

import * as auth from "#src/services/auth";
import * as http from "#src/services/http";
import * as rtc from "#src/services/rtc";
import { SfuClient, SfuClientState } from "#src/client";
import { Channel } from "#src/models/channel";
import type { Session } from "#src/models/session";
import type { JWTClaims } from "#src/services/auth";

/**
 * HMAC key for JWT signing in tests
 */
const HMAC_B64_KEY = "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=";
const HMAC_KEY = Buffer.from(HMAC_B64_KEY, "base64");

/**
 * Creates a JWT token for testing
 *
 * @param data - Claims to include in the JWT
 * @returns Signed JWT string
 */
export function makeJwt(data: JWTClaims): string {
    return auth.sign(data, HMAC_KEY, { algorithm: auth.ALGORITHM.HS256 });
}

/**
 * Connection result containing session and client instances
 */
interface ConnectionResult {
    /** Server-side session instance */
    session: Session;
    /** Client-side SFU client instance */
    sfuClient: SfuClient;
}

/**
 * This class represents a local network for testing the complete stack
 * (server - websocket - client) together in conditions as close as possible
 * to the real world: multiple sessions connected to the same server with
 * their respective clients.
 */
export class LocalNetwork {
    /** Server hostname */
    public hostname?: string;

    /** Server port */
    public port?: number;

    /** JWT creation function (can be overridden for testing) */
    public makeJwt: (data: JWTClaims) => string = makeJwt;

    /** Active SFU client instances */
    private readonly _sfuClients: SfuClient[] = [];

    /**
     * Starts the local network with all required services
     *
     * @param hostname - Hostname to bind server to
     * @param port - Port to bind server to
     */
    async start(hostname: string, port: number): Promise<void> {
        this.hostname = hostname;
        this.port = port;

        // Start all services in correct order
        await rtc.start();
        await http.start({ httpInterface: hostname, port });
        await auth.start(HMAC_B64_KEY);
    }

    /**
     * Creates a new channel and returns its UUID
     *
     * @param useWebRtc - Whether to enable WebRTC for the channel
     * @returns Promise resolving to channel UUID
     */
    async getChannelUUID(useWebRtc: boolean = true): Promise<string> {
        if (!this.hostname || !this.port) {
            throw new Error("Network not started - call start() first");
        }

        const jwt = this.makeJwt({
            iss: `http://${this.hostname}:${this.port}/`
        });

        const response = await fetch(
            `http://${this.hostname}:${this.port}/v${http.API_VERSION}/channel?webRTC=${useWebRtc}`,
            {
                method: "GET",
                headers: {
                    Authorization: "jwt " + jwt
                }
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to create channel: ${response.status} ${response.statusText}`);
        }

        const result = (await response.json()) as { uuid: string };
        return result.uuid;
    }

    /**
     * Connects a session to the network
     *
     * @param channelUUID - Channel UUID to connect to
     * @param sessionId - Session identifier
     * @returns Promise resolving to connection result
     * @throws {Error} If client is closed before authentication
     */
    async connect(channelUUID: string, sessionId: number): Promise<ConnectionResult> {
        if (!this.hostname || !this.port) {
            throw new Error("Network not started - call start() first");
        }

        // Create SFU client with test overrides
        const sfuClient = new SfuClient();
        this._sfuClients.push(sfuClient);

        // Override device creation for testing environment
        (sfuClient as any)._createDevice = (): Device => {
            // Mock device creation since we're in a server environment without real WebRTC
            return new Device({
                handlerFactory: FakeHandler.createFactory(fakeParameters)
            });
        };

        // Override WebSocket creation for Node.js environment
        (sfuClient as any)._createWebSocket = (url: string): WebSocket => {
            // Replace browser WebSocket with Node.js ws package
            return new WebSocket(url);
        };

        // Set up authentication promise
        const isClientAuthenticated = new Promise<boolean>((resolve, reject) => {
            const handleStateChange = (event: CustomEvent) => {
                const { state } = event.detail;
                switch (state) {
                    case SfuClientState.AUTHENTICATED:
                        sfuClient.removeEventListener(
                            "stateChange",
                            handleStateChange as EventListener
                        );
                        resolve(true);
                        break;
                    case SfuClientState.CLOSED:
                        sfuClient.removeEventListener(
                            "stateChange",
                            handleStateChange as EventListener
                        );
                        reject(new Error("client closed"));
                        break;
                }
            };

            sfuClient.addEventListener("stateChange", handleStateChange as EventListener);
        });

        // Start connection
        sfuClient.connect(
            `ws://${this.hostname}:${this.port}`,
            this.makeJwt({
                sfu_channel_uuid: channelUUID,
                session_id: sessionId
            }),
            { channelUUID }
        );

        // Get channel and wait for authentication
        const channel = Channel.records.get(channelUUID);
        if (!channel) {
            throw new Error(`Channel ${channelUUID} not found`);
        }

        await isClientAuthenticated;

        // Get session from channel
        const session = channel.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found in channel ${channelUUID}`);
        }

        return { session, sfuClient };
    }

    /**
     * Closes the network and cleans up all resources
     */
    close(): void {
        // Disconnect all SFU clients
        for (const sfuClient of this._sfuClients) {
            sfuClient?.disconnect();
        }
        this._sfuClients.length = 0;

        // Close all channels
        Channel.closeAll();

        // Stop all services
        auth.close();
        http.close();
        rtc.close();

        // Clear network info
        this.hostname = undefined;
        this.port = undefined;
    }
}
