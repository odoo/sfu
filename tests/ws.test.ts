import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { WebSocket } from "ws";

import { Channel } from "#src/core/models/channel";
import { WS_CLOSE_CODE } from "#src/shared/enums";
import { OvercrowdedError } from "#src/utils/errors";
import { timeouts } from "#src/config";
import { __testing__ as wsTesting } from "#src/core/services/ws";

import { LocalNetwork } from "#tests/utils/network";
import { waitFor } from "#tests/utils/utils";

describe("WebSocket Service", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start();
    });
    afterEach(async () => {
        jest.useRealTimers();
        await network.close();
    });
    test("Closes connection if authentication times out", async () => {
        jest.useFakeTimers({
            doNotFake: ["nextTick", "queueMicrotask", "setImmediate"]
        });
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");
        const close = once(ws, "close");
        jest.advanceTimersByTime(timeouts.authentication + 100);
        const [code] = await close;
        expect(code).toBe(WS_CLOSE_CODE.TIMEOUT);
    });
    test("Closes connection on invalid JSON message", async () => {
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");

        ws.send("not json");

        const [code] = await once(ws, "close");
        expect(code).toBe(WS_CLOSE_CODE.ERROR);
        expect(wsTesting.unauthenticatedWebSocketCount).toBe(0);
    });
    test("Closes connection on invalid auth credentials (invalid JWT)", async () => {
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
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
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");

        const channelUUID = "non-existent-uuid";
        const jwt = network.makeChannelJwt(channelUUID, {
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
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");

        const jwt = network.makeChannelJwt(channelUUID, {
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
    test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, true])(
        "Closes connection when partner_id is invalid (%p)",
        async (partnerId) => {
            const channelUUID = await network.getChannelUUID({ useWebRtc: false });
            const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
            await once(ws, "open");

            const jwt = network.makeChannelJwt(channelUUID, {
                sfu_channel_uuid: channelUUID,
                session_id: 1,
                partner_id: partnerId,
                permissions: {}
            });

            ws.send(JSON.stringify({ channelUUID, jwt }));

            const [code] = await once(ws, "close");
            expect(code).toBe(WS_CLOSE_CODE.AUTHENTICATION_FAILED);
        }
    );
    test("Closes connection with CHANNEL_FULL when channel is overcrowded", async () => {
        const channelUUID = await network.getChannelUUID();
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");

        const joinSpy = jest.spyOn(Channel, "join").mockImplementationOnce(() => {
            throw new OvercrowdedError("Channel is full");
        });

        const jwt = network.makeChannelJwt(channelUUID, {
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
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");
        expect(wsTesting.unauthenticatedWebSocketCount).toBe(1);

        ws.close();
        await once(ws, "close");
        await waitFor(() => wsTesting.unauthenticatedWebSocketCount === 0);
        expect(wsTesting.unauthenticatedWebSocketCount).toBe(0);
    });
});
