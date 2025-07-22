import { once } from "node:events";

import { WebSocket } from "ws";
import { describe, beforeEach, afterEach, expect, jest } from "@jest/globals";

import { Channel } from "#src/models/channel";
import { WS_CLOSE_CODE } from "#src/shared/enums";
import { timeouts } from "#src/config";

import { LocalNetwork } from "#tests/utils/network";

const HTTP_INTERFACE = "0.0.0.0";
const PORT = 62348;

describe("Security", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start(HTTP_INTERFACE, PORT);
        jest.useFakeTimers();
    });
    afterEach(() => {
        network.close();
        jest.useRealTimers();
    });
    test("Authentication fails with wrong JWT", async () => {
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        network.makeJwt = () => "wrong-JWT";
        await expect(network.connect(channelUUID, 54)).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
    });
    test("Websocket does timeout if the authentication process is not started", async () => {
        jest.spyOn(global, "setTimeout");
        const websocket = new WebSocket(`ws://${HTTP_INTERFACE}:${PORT}`);
        await once(websocket, "open");
        jest.advanceTimersByTime(timeouts.authentication + 100);
        const [event] = await once(websocket, "close");
        expect(event).toBe(WS_CLOSE_CODE.TIMEOUT);
    });
    test("cannot access a channel with the wrong key", async () => {
        const channelUUID = await network.getChannelUUID({ key: "channel-specific-key" });
        const channel = Channel.records.get(channelUUID);
        // testing the default/global key
        await expect(network.connect(channelUUID, 3)).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
        // any arbitrary wrong key
        await expect(network.connect(channelUUID, 3, { key: "wrong-key" })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
    });
    test("can join a channel with its specific key", async () => {
        const key = "channel-specific-key";
        const channelUUID = await network.getChannelUUID({ key });
        const channel = Channel.records.get(channelUUID);
        await network.connect(channelUUID, 4, { key });
        expect(channel!.sessions.size).toBe(1);
    });
});
