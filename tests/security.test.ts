import { describe, beforeEach, afterEach, expect } from "@jest/globals";

import { Channel } from "#src/models/channel";

import { AUTH_KEY, LocalNetwork } from "#tests/utils/network";

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
        const key = Buffer.from("channel-specific-key").toString("base64");
        const channelUUID = await network.getChannelUUID({ key });
        const channel = Channel.records.get(channelUUID);
        await expect(network.connect(channelUUID, 3, { key: AUTH_KEY })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
        await expect(network.connect(channelUUID, 3, { key: "wrong-key" })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
    });
    test("can join a channel with its legacy key", async () => {
        const key = Buffer.from("legacy-channel-key").toString("base64");
        const channelUUID = await network.getChannelUUID({ key });
        const channel = Channel.records.get(channelUUID);
        await network.connect(channelUUID, 4, { key });
        expect(channel!.sessions.size).toBe(1);
    });
});
