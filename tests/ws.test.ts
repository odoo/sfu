import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { WebSocket } from "ws";

import { Channel } from "#src/core/models/channel";
import { WS_CLOSE_CODE } from "#src/shared/enums";
import { OvercrowdedError } from "#src/utils/errors";
import { timeouts } from "#src/config";
import { __testing__ as wsTesting } from "#src/core/services/ws";

import { LocalNetwork, makeJwt } from "#tests/utils/network";

const HTTP_INTERFACE = "0.0.0.0";
const PORT = 62345;

describe("WebSocket Service", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start(HTTP_INTERFACE, PORT);
    });
    afterEach(async () => {
        await network.close();
        jest.useRealTimers();
    });
    test("Closes connection if authentication times out", async () => {
        jest.useFakeTimers({ advanceTimers: true });
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");
        jest.advanceTimersByTime(timeouts.authentication + 100);
        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.TIMEOUT);
    });
    test("Closes connection on invalid JSON message", async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        ws.send("not json");

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.ERROR);
        expect(wsTesting.unauthenticatedWebSocketCount).toBe(0);
        expect(wsTesting.authenticatedWebSocketCount).toBe(0);
    });
    test("Closes connection on invalid auth credentials (invalid JWT)", async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        ws.send(
            JSON.stringify({
                channelUUID: "some-uuid",
                jwt: "invalid-jwt"
            })
        );

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.AUTHENTICATION_FAILED);
    });
    test("Closes connection when Channel does not exist", async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        const channelUUID = "non-existent-uuid";
        const jwt = makeJwt({
            sfu_channel_uuid: channelUUID,
            session_id: 1,
            permissions: {}
        });

        ws.send(
            JSON.stringify({
                channelUUID,
                jwt
            })
        );

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.AUTHENTICATION_FAILED);
    });
    test("Closes connection when JWT payload is malformed (missing session_id)", async () => {
        const channelUUID = await network.getChannelUUID();
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        const jwt = makeJwt({
            sfu_channel_uuid: channelUUID,
            permissions: {}
        });

        ws.send(
            JSON.stringify({
                channelUUID,
                jwt
            })
        );

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.AUTHENTICATION_FAILED);
    });
    test("Closes connection with CHANNEL_FULL when channel is overcrowded", async () => {
        const channelUUID = await network.getChannelUUID();
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        const joinSpy = jest.spyOn(Channel, "join").mockImplementationOnce(() => {
            throw new OvercrowdedError("Channel is full");
        });

        const jwt = makeJwt({
            sfu_channel_uuid: channelUUID,
            session_id: 1,
            permissions: {}
        });

        ws.send(
            JSON.stringify({
                channelUUID,
                jwt
            })
        );

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.CHANNEL_FULL);
        joinSpy.mockRestore();
    });
    test("Handles early disconnect before authentication timeout", async () => {
        jest.useFakeTimers({ advanceTimers: true });
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await once(ws, "open");

        ws.close();
        await once(ws, "close");

        jest.advanceTimersByTime(timeouts.authentication + 100);
        expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
});
