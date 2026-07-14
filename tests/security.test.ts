import { once } from "node:events";

import { WebSocket } from "ws";
import { describe, beforeEach, afterEach, expect } from "@jest/globals";

import { Channel } from "#src/core/models/channel";

import { LocalNetwork, makeJwt } from "#tests/utils/network";

describe("Security", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start();
    });
    afterEach(async () => {
        await network.close();
    });
    test("Authentication fails with wrong JWT", async () => {
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        network.makeJwt = () => "wrong-JWT";
        await expect(network.connect(channelUUID, 54)).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
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
    test("Legacy Auth: Succeeds if channel has NO key and channelUUID not provided", async () => {
        const channelUUID = await network.getChannelUUID({ key: "", recordingAddress: "" });
        const ws = new WebSocket(`ws://${network.hostname}:${network.port}`);
        await once(ws, "open");

        const jwt = makeJwt({
            sfu_channel_uuid: channelUUID,
            session_id: 1,
            permissions: {}
        });

        ws.send(JSON.stringify({ jwt }));

        const [message] = await once(ws, "message");
        const data = JSON.parse(message.toString());
        expect(data).toHaveProperty("availableFeatures");

        const close = once(ws, "close");
        ws.close();
        await close;
    });
    test("cannot omit key when recordingAddress is provided", async () => {
        await expect(
            network.getChannelUUID({ key: "", recordingAddress: "dummy-dest" })
        ).rejects.toThrow();
    });
});
