import { describe, beforeEach, afterEach, expect, jest } from "@jest/globals";

import { SESSION_STATE } from "#src/models/session.js";
import { Channel } from "#src/models/channel.js";
import * as config from "#src/config.js";
import { API_VERSION } from "#src/services/http.js";

import { LocalNetwork, makeJwt } from "#tests/utils/network.js";
import { once } from "node:events";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

const HTTP_INTERFACE = "0.0.0.0";
const PORT = 6971;

describe("HTTP", () => {
    /** @type {LocalNetwork} */
    let network;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start(HTTP_INTERFACE, PORT);
    });
    afterEach(() => {
        network.close();
        jest.useRealTimers();
    });
    test("/stats", async () => {
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        const streamer = await network.connect(channelUUID, 5);
        await once(streamer.session, "stateChange");
        await streamer.sfuClient.updateUpload(
            "camera",
            new FakeMediaStreamTrack({ kind: "video" })
        );

        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/stats`, {
            method: "GET",
        });
        expect(response.ok).toBe(true);
        const parsedResponse = await response.json();
        expect(parsedResponse).toEqual([
            {
                uuid: channelUUID,
                remoteAddress: channel.remoteAddress,
                sessionsStats: {
                    incomingBitRate: {
                        audio: 0,
                        camera: 0, // no bitrate as it is a fake track
                        screen: 0,
                        total: 0,
                    },
                    count: 1,
                    cameraCount: 1,
                    screenCount: 0,
                },
                createDate: channel.createDate,
                webRtcEnabled: true,
            },
        ]);
    });
    test("/channel", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization:
                    "jwt " +
                    makeJwt({
                        iss: `http://${HTTP_INTERFACE}:${PORT}/`,
                    }),
            },
        });
        expect(response.ok).toBe(true);
        const { uuid, url } = await response.json();
        expect(Channel.records.get(uuid)).toBeDefined();
        expect(url).toBe(`http://${config.PUBLIC_ADDRESS}:${config.PORT}`);
    });
    test("/noop", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/noop`, {
            method: "GET",
        });
        expect(response.ok).toBe(true);
        const { result } = await response.json();
        expect(result).toBe("ok");
    });
    test("/channel is idempotent", async () => {
        const request = {
            method: "GET",
            headers: {
                Authorization:
                    "jwt " +
                    makeJwt({
                        iss: `UUID-CHANNEL_ID`,
                    }),
            },
        };
        const response = await fetch(
            `http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`,
            request
        );
        const responseJson = await response.json();
        const response2 = await fetch(
            `http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`,
            request
        );
        const response2Json = await response2.json();
        expect(responseJson.uuid).toBe(response2Json.uuid);
        const response3 = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization:
                    "jwt " +
                    makeJwt({
                        iss: `DIFFERENT_UUID-CHANNEL_ID`,
                    }),
            },
        });
        const response3Json = await response3.json();
        expect(responseJson.uuid).not.toBe(response3Json.uuid);
    });
    test("/disconnect", async () => {
        const channelUUID = await network.getChannelUUID();
        const sessionId = 5;
        const user1 = await network.connect(channelUUID, sessionId);
        await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/disconnect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    [channelUUID]: [sessionId],
                },
            }),
        });
        expect(user1.session.state).toBe(SESSION_STATE.CLOSED);
    });
    test("/disconnect fails with an incorrect JWT", async () => {
        const channelUUID = await network.getChannelUUID();
        const sessionId = 5;
        const user1 = await network.connect(channelUUID, sessionId);
        await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/disconnect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    wrong: [sessionId],
                },
            }),
        });
        expect(user1.session.state).not.toBe(SESSION_STATE.CLOSED);
    });
    test("malformed routes", async () => {
        const response1 = await fetch(
            `http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/src/server.js`,
            {
                method: "GET",
            }
        );
        expect(response1.status).toBe(404);
        const response2 = await fetch(`http://${HTTP_INTERFACE}:${PORT}/`, {
            method: "GET",
        });
        expect(response2.status).toBe(404);
    });
});
