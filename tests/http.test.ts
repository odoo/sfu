import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { SESSION_STATE } from "#src/models/session.ts";
import { Channel } from "#src/models/channel.ts";
import * as config from "#src/config";
import { API_VERSION } from "#src/services/http";
import * as rtc from "#src/services/rtc";

import { LocalNetwork, makeJwt } from "#tests/utils/network";
import { withMockEnv } from "#tests/utils/utils";

describe("HTTP", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start();
    });
    afterEach(async () => {
        await network.close();
        jest.useRealTimers();
    });
    test("/stats", async () => {
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        const streamer = await network.connect(channelUUID, 5);
        expect(streamer.session.state).toBe(SESSION_STATE.CONNECTED);
        await streamer.sfuClient.updateUpload(
            STREAM_TYPE.CAMERA,
            new FakeMediaStreamTrack({ kind: "video" })
        );

        const response = await fetch(`${network.url}/v${API_VERSION}/stats`, { method: "GET" });
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
        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization:
                    "jwt " +
                    makeJwt({
                        iss: `${network.url}/`
                    })
            }
        });
        expect(response.ok).toBe(true);
        const { uuid, url } = await response.json();
        expect(Channel.records.get(uuid)).toBeDefined();
        expect(url).toBe(`http://${config.PUBLIC_IP}:${config.PORT}`);
    });
    test("/channel fails without authorization header", async () => {
        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, { method: "GET" });
        expect(response.status).toBe(401);
    });
    test.each([
        ["malformed syntax", "not-a-jwt"],
        ["a null header", "bnVsbA.e30.AA"],
        ["a wrong key", makeJwt({ iss: "issuer" }, Buffer.from("wrong key"))],
        ["an expired claim", makeJwt({ iss: "issuer", exp: 0 })]
    ])("/channel rejects a JWT with %s", async (_description, token) => {
        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: { Authorization: "jwt " + token }
        });
        expect(response.status).toBe(401);
    });
    test("/channel fails without issuer claim", async () => {
        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({})
            }
        });
        expect(response.status).toBe(403);
    });
    test("/channel reports channel creation failures as server errors", async () => {
        const createSpy = jest
            .spyOn(Channel, "create")
            .mockRejectedValueOnce(new Error("channel creation failed"));
        try {
            const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
                method: "GET",
                headers: { Authorization: "jwt " + makeJwt({ iss: "issuer" }) }
            });
            expect(response.status).toBe(500);
        } finally {
            createSpy.mockRestore();
        }
    });
    test("/noop", async () => {
        const response = await fetch(`${network.url}/v${API_VERSION}/noop`, { method: "GET" });
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
        const [response, response2] = await Promise.all([
            fetch(`${network.url}/v${API_VERSION}/channel`, request),
            fetch(`${network.url}/v${API_VERSION}/channel`, request)
        ]);
        const [responseJson, response2Json] = await Promise.all([
            response.json(),
            response2.json()
        ]);
        expect(responseJson.uuid).toBe(response2Json.uuid);
        const response3 = await fetch(`${network.url}/v${API_VERSION}/channel`, {
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
    test("channel cleanup waits for pending creation", async () => {
        const worker = await rtc.getWorker();
        const getResourceUsage = worker.getResourceUsage.bind(worker);
        const creationStarted = Promise.withResolvers<void>();
        const creationGate = Promise.withResolvers<void>();
        const resourceUsageSpy = jest
            .spyOn(worker, "getResourceUsage")
            .mockImplementation(async () => {
                creationStarted.resolve();
                await creationGate.promise;
                return getResourceUsage();
            });
        const creation = Channel.create("pending-remote", "pending-issuer");
        try {
            await creationStarted.promise;
            const closePromise = Channel.closeAll();
            creationGate.resolve();
            await Promise.all([creation, closePromise]);
            expect(Channel.records.size).toBe(0);
        } finally {
            creationGate.resolve();
            await creation.catch(() => undefined);
            resourceUsageSpy.mockRestore();
        }
    });
    test("/disconnect", async () => {
        const channelUUID = await network.getChannelUUID();
        const sessionId = 5;
        const user1 = await network.connect(channelUUID, sessionId);
        const response = await fetch(`${network.url}/v${API_VERSION}/disconnect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    missing: [sessionId],
                    [channelUUID]: [sessionId]
                }
            })
        });
        expect(response.status).toBe(200);
        expect(user1.session.state).toBe(SESSION_STATE.CLOSED);
    });
    test("/disconnect does not execute for unowned channel", async () => {
        const remoteAddress = "test.other-owner.net";
        const channel = await Channel.create(remoteAddress, "issuer");
        const sessionId = 5;
        const user1 = await network.connect(channel.uuid, sessionId);

        const response = await fetch(`${network.url}/v${API_VERSION}/disconnect`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: makeJwt({
                sessionIdsByChannel: {
                    [channel.uuid]: [sessionId]
                }
            })
        });
        expect(response.status).toBe(200);
        expect(user1.session.state).not.toBe(SESSION_STATE.CLOSED);
    });
    test("malformed routes", async () => {
        const response = await fetch(`${network.url}/`, {
            method: "GET"
        });
        expect(response.status).toBe(404);
    });
});

describe("HTTP Proxy", () => {
    let network: LocalNetwork;
    let restoreProxy: (() => void) | undefined;

    afterEach(async () => {
        await network?.close();
        restoreProxy?.();
        restoreProxy = undefined;
        jest.useRealTimers();
    });

    test("headers are ignored when PROXY is not set", async () => {
        network = new LocalNetwork();
        await network.start();

        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `${network.url}/` }),
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
        restoreProxy = withMockEnv({ PROXY: "true" });
        const { LocalNetwork: LocalNetworkProxy } = await import("#tests/utils/network");

        network = new LocalNetworkProxy();
        await network.start();

        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `${network.url}/` }),
                "X-Forwarded-Host": "proxy-host",
                "X-Forwarded-Proto": "https"
            }
        });
        expect(response.ok).toBe(true);
        const { url } = await response.json();
        expect(url).toBe("https://proxy-host");
    });

    test("X-Forwarded-For updates remoteAddress", async () => {
        restoreProxy = withMockEnv({ PROXY: "true" });
        const { LocalNetwork: LocalNetworkProxy } = await import("#tests/utils/network");
        const { Channel: ChannelProxy } = await import("#src/models/channel");

        network = new LocalNetworkProxy();
        await network.start();

        const response = await fetch(`${network.url}/v${API_VERSION}/channel`, {
            method: "GET",
            headers: {
                Authorization: "jwt " + makeJwt({ iss: `${network.url}/` }),
                "X-Forwarded-For": "1.2.3.4"
            }
        });
        expect(response.ok).toBe(true);
        const { uuid } = await response.json();

        const channel = ChannelProxy.records.get(uuid);
        expect(channel).toBeDefined();
        expect(channel!.remoteAddress).toBe("1.2.3.4");
    });
});
