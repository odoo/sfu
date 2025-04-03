import { WebSocket } from "ws";
import { Device } from "mediasoup-client";
import { FakeHandler } from "mediasoup-client/lib/handlers/FakeHandler";
import * as fakeParameters from "mediasoup-client/lib/test/fakeParameters";

import * as auth from "#src/services/auth.js";
import * as http from "#src/services/http.js";
import * as rtc from "#src/services/rtc.js";
import { SfuClient, SFU_CLIENT_STATE } from "#src/client.js";
import { Channel } from "#src/models/channel.js";

const HMAC_B64_KEY = "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=";
const HMAC_KEY = Buffer.from(HMAC_B64_KEY, "base64");

export function makeJwt(data) {
    return auth.sign(data, HMAC_KEY, { algorithm: "HS256" });
}

/**
 * This class represents a local network, it is used to test the whole stack (server - websocket - client) together
 * in conditions that are as close as possible to the real world: multiple sessions that are connected to the same
 * server and their respective clients.
 */
export class LocalNetwork {
    /** @type {string} */
    hostname;
    /** @type {number} */
    port;
    /** @type {Function} */
    makeJwt = makeJwt;
    /** @type{SfuClient[]} */
    _sfuClients = [];

    /**
     * @param {string} hostname
     * @param {number} port
     */
    async start(hostname, port) {
        this.hostname = hostname;
        this.port = port;
        await rtc.start();
        await http.start({ hostname, port });
        await auth.start(HMAC_B64_KEY);
    }

    /**
     * @param {boolean} [useWebRtc]
     * @returns {Promise<string>}
     */
    async getChannelUUID(useWebRtc = true) {
        const jwt = this.makeJwt({
            iss: `http://${this.hostname}:${this.port}/`,
            key: HMAC_B64_KEY,
        });
        const response = await fetch(
            `http://${this.hostname}:${this.port}/v${http.API_VERSION}/channel?webRTC=${useWebRtc}`,
            {
                method: "GET",
                headers: {
                    Authorization: "jwt " + jwt,
                },
            }
        );
        const result = await response.json();
        return result.uuid;
    }

    /**
     * Adds a session to the network.
     *
     * @param {string} channelUUID
     * @param {number} sessionId
     * @returns { Promise<{ session: import("#src/models/session.js").Session, sfuClient: import("#src/client.js").SfuClient }>}
     * @throws {Error} if the client is closed before being authenticated
     */
    async connect(channelUUID, sessionId) {
        const sfuClient = new SfuClient();
        this._sfuClients.push(sfuClient);
        sfuClient._createDevice = () => {
            // Mocks the creation of the device, since we are in a server environment, we do not have access to a real webRTC API.
            return new Device({
                handlerFactory: FakeHandler.createFactory(fakeParameters),
            });
        };
        sfuClient._createWebSocket = (url) => {
            // Replaces the browser's WebSocket with the `ws` package's WebSocket as we are in a server environment.
            return new WebSocket(url);
        };
        const isClientAuthenticated = new Promise((resolve, reject) => {
            sfuClient.addEventListener("stateChange", ({ detail: { state } }) => {
                switch (state) {
                    case SFU_CLIENT_STATE.AUTHENTICATED:
                        resolve(true);
                        break;
                    case SFU_CLIENT_STATE.CLOSED:
                        reject(new Error("client closed"));
                        break;
                }
            });
        });
        sfuClient.connect(
            `ws://${this.hostname}:${this.port}`,
            this.makeJwt({
                sfu_channel_uuid: channelUUID,
                session_id: sessionId,
            }),
            { channelUUID }
        );
        const channel = Channel.records.get(channelUUID);
        await isClientAuthenticated;
        return {
            session: channel.sessions.get(sessionId),
            sfuClient,
        };
    }

    close() {
        for (const s of this._sfuClients) {
            s?.disconnect();
        }
        Channel.closeAll();
        auth.close();
        http.close();
        rtc.close();
    }
}
