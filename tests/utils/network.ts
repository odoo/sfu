import { once } from "node:events";

import { WebSocket } from "ws";
import { Device, FakeHandler, testFakeParameters } from "mediasoup-client";

import * as auth from "#src/core/services/auth";
import * as http from "#src/core/services/http";
import * as resources from "#src/core/services/resources";
import { SfuClient, SfuClientState } from "#src/client";
import { Channel } from "#src/core/models/channel";
import { Session, SESSION_STATE } from "#src/core/models/session";
import { StringLike } from "#src/shared/types.ts";

/**
 * HMAC key for JWT signing in tests
 */
const HMAC_B64_KEY = "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=";
const HMAC_KEY = Buffer.from(HMAC_B64_KEY, "base64");

/**
 * Creates a JWT token for testing
 *
 * @param data - Claims to include in the JWT
 * @param [key] - Key to sign the JWT with
 * @returns Signed JWT string
 */
export function makeJwt<T extends object>(
    data: T & auth.JWTClaims,
    key: StringLike = HMAC_KEY
): string {
    return auth.sign<T>(data, key, { algorithm: auth.ALGORITHM.HS256 });
}

/**
 * This class represents a local network for testing the complete stack
 * (server - websocket - client) together in conditions as close as possible
 * to the real world: multiple sessions connected to the same server with
 * their respective clients.
 */
export class LocalNetwork {
    public readonly hostname = "127.0.0.1";
    public port?: number;

    get url(): string {
        return `http://${this.hostname}:${this.port}`;
    }

    public makeJwt: <T extends object>(data: T & auth.JWTClaims, key?: StringLike) => string =
        makeJwt;

    private readonly _sfuClients: SfuClient[] = [];

    async start(): Promise<void> {
        await resources.start();
        this.port = await http.start({ httpInterface: this.hostname, port: 0 });
        auth.start(HMAC_B64_KEY);
    }

    /**
     * Creates a new channel and returns its UUID
     * @param [param0] - options
     * @param [param0.useWebRtc=true] - Whether to enable WebRTC for the channel
     * @param [param0.key=HMAC_B64_KEY] - Channel key
     * @returns Promise resolving to channel UUID
     */
    async getChannelUUID({
        useWebRtc = true,
        key = HMAC_B64_KEY,
        recordingAddress = "dummy-dest"
    } = {}): Promise<string> {
        if (!this.port) {
            throw new Error("Network not started - call start() first");
        }

        const jwt = this.makeJwt({
            iss: `${this.url}/`,
            key
        });
        const response = await fetch(
            `${this.url}/v${http.API_VERSION}/channel?webRTC=${useWebRtc}&recordingAddress=${recordingAddress}`,
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
     * @param [param2]
     * @param [param2.key=HMAC_B64_KEY] - Channel key
     * @returns Promise resolving to connection result
     * @throws {Error} If either endpoint closes before connecting
     */
    async connect(
        channelUUID: string,
        sessionId: number,
        { key = HMAC_KEY }: { key?: StringLike } = {}
    ) {
        if (!this.port) {
            throw new Error("Network not started - call start() first");
        }

        const sfuClient = new SfuClient();
        this._sfuClients.push(sfuClient);

        // @ts-expect-error injecting the Node test device through the private browser factory
        sfuClient._createDevice = (): Device => {
            return new Device({
                handlerFactory: FakeHandler.createFactory(testFakeParameters)
            });
        };

        // @ts-expect-error injecting Node WebSocket through the private browser factory
        sfuClient._createWebSocket = (url: string): WebSocket => {
            return new WebSocket(url);
        };

        const isClientAuthenticated = Promise.withResolvers();
        const handleStateChange = (event: CustomEvent) => {
            const { state } = event.detail;
            switch (state) {
                case SfuClientState.AUTHENTICATED:
                    sfuClient.removeEventListener(
                        "stateChange",
                        handleStateChange as EventListener
                    );
                    isClientAuthenticated.resolve(true);
                    break;
                case SfuClientState.CLOSED:
                    sfuClient.removeEventListener(
                        "stateChange",
                        handleStateChange as EventListener
                    );
                    isClientAuthenticated.reject(new Error("client closed"));
                    break;
            }
        };
        sfuClient.addEventListener("stateChange", handleStateChange as EventListener);

        sfuClient.connect(
            `ws://${this.hostname}:${this.port}`,
            this.makeJwt(
                {
                    sfu_channel_uuid: channelUUID,
                    session_id: sessionId,
                    permissions: {
                        audioRecording: true,
                        videoRecording: true,
                        transcription: true
                    }
                },
                key
            ),
            { channelUUID }
        );

        const channel = Channel.records.get(channelUUID);
        if (!channel) {
            throw new Error(`Channel ${channelUUID} not found`);
        }

        await isClientAuthenticated.promise;

        const session = channel.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found in channel ${channelUUID}`);
        }

        if (session.state === SESSION_STATE.CLOSED) {
            throw new Error("server session closed before connecting");
        }
        if (session.state !== SESSION_STATE.CONNECTED) {
            const [state] = await once(session, Session.Events.STATE_CHANGE);
            if (state !== SESSION_STATE.CONNECTED) {
                throw new Error("server session closed before connecting");
            }
        }
        return { session, sfuClient };
    }

    async close(): Promise<void> {
        for (const sfuClient of this._sfuClients) {
            sfuClient.disconnect();
        }
        this._sfuClients.length = 0;

        await Channel.closeAll();

        auth.close();
        await http.close();
        await resources.close();

        this.port = undefined;
    }
}
