import { afterEach, beforeEach, describe, expect, jest } from "@jest/globals";

import { SESSION_STATE } from "#src/models/session";
import { Channel } from "#src/models/channel";
import * as config from "#src/config";
import { API_VERSION } from "#src/services/http";

import { LocalNetwork, makeJwt } from "#tests/utils/network";
import { withMockEnv } from "#tests/utils/utils";
import { once } from "node:events";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";
import { STREAM_TYPE } from "#src/shared/enums.ts";

const HTTP_INTERFACE = "0.0.0.0";
const PORT = 6971;

describe("HTTP", () => {
    let network: LocalNetwork;
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
            STREAM_TYPE.CAMERA,
            new FakeMediaStreamTrack({ kind: "video" })
        );

        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/stats`, {
            method: "GET"
        });
        expect(response.ok).toBe(true);
        const parsedResponse = await response.json();
        expect(parsedResponse).toEqual([
            {
                uuid: channelUUID,
                remoteAddress: channel!.remoteAddress,
                sessionsStats: {
                    incomingBitRate: {
                        audio: 0,
                        camera: 0, // no bitrate as it is a fake track
                        screen: 0,
                        total: 0
                    },
                    count: 1,
                    cameraCount: 1,
                    screenCount: 0
                },
                createDate: channel!.createDate,
                webRtcEnabled: true
            }
        ]);
    });
    test("/channel", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization:
                    "jwt " +
                    makeJwt({
                        iss: `http://${HTTP_INTERFACE}:${PORT}/`
                    })
            }
        });
        expect(response.ok).toBe(true);
        const { uuid, url } = await response.json();
        expect(Channel.records.get(uuid)).toBeDefined();
        expect(url).toBe(`http://${config.PUBLIC_IP}:${config.PORT}`);
    });
    test("/channel fails without authorization header", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET"
        });
        expect(response.status).toBe(401);
    });
    test("/channel fails without issuer claim", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({})
            }
        });
        expect(response.status).toBe(403);
    });
    test("/noop", async () => {
        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/noop`, {
            method: "GET"
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
                        iss: `UUID-CHANNEL_ID`
                    })
            }
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
                        iss: `DIFFERENT_UUID-CHANNEL_ID`
                    })
            }
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
                "Content-Type": "application/json"
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    [channelUUID]: [sessionId]
                }
            })
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
                "Content-Type": "application/json"
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    wrong: [sessionId]
                }
            })
        });
        expect(user1.session.state).not.toBe(SESSION_STATE.CLOSED);
    });
    test("malformed routes", async () => {
        const response1 = await fetch(
            `http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/src/server.js`,
            {
                method: "GET"
            }
        );
        expect(response1.status).toBe(404);
        const response2 = await fetch(`http://${HTTP_INTERFACE}:${PORT}/`, {
            method: "GET"
        });
        expect(response2.status).toBe(404);
    });
});

describe("HTTP PROXY", () => {
    let network: LocalNetwork;

    afterEach(() => {
        network?.close();
        jest.useRealTimers();
    });

    test("headers are ignored when PROXY is not set", async () => {
        network = new LocalNetwork();
        await network.start(HTTP_INTERFACE, PORT);

        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `http://${HTTP_INTERFACE}:${PORT}/` }),
                "X-Forwarded-Host": "proxy-host",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "1.2.3.4"
            }
        });
        expect(response.ok).toBe(true);
        const { url } = await response.json();
        expect(url).toBe(`http://${config.PUBLIC_IP}:${config.PORT}`);
    });

    test("headers are used when PROXY is set", async () => {
        const restore = withMockEnv({ PROXY: "true" });
        const { LocalNetwork: LocalNetworkProxy } = await import("#tests/utils/network");

        network = new LocalNetworkProxy();
        await network.start(HTTP_INTERFACE, PORT);

        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `http://${HTTP_INTERFACE}:${PORT}/` }),
                "X-Forwarded-Host": "proxy-host",
                "X-Forwarded-Proto": "https"
            }
        });
        expect(response.ok).toBe(true);
        const { url } = await response.json();
        expect(url).toBe("https://proxy-host");

        restore();
    });

    test("X-Forwarded-For updates remoteAddress", async () => {
        const restore = withMockEnv({ PROXY: "true" });
        const { LocalNetwork: LocalNetworkProxy } = await import("#tests/utils/network");
        const { Channel: ChannelProxy } = await import("#src/models/channel");

        network = new LocalNetworkProxy();
        await network.start(HTTP_INTERFACE, PORT);

        const response = await fetch(`http://${HTTP_INTERFACE}:${PORT}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `http://${HTTP_INTERFACE}:${PORT}/` }),
                "X-Forwarded-For": "1.2.3.4"
            }
        });
        expect(response.ok).toBe(true);
        const { uuid } = await response.json();

        const channel = ChannelProxy.records.get(uuid);
        expect(channel).toBeDefined();
        expect(channel!.remoteAddress).toBe("1.2.3.4");

        restore();
    });
});
