import { once } from "node:events";

import { WebSocket } from "ws";
import { describe, beforeEach, afterEach, expect } from "@jest/globals";

import { Channel } from "#src/core/models/channel";
import * as auth from "#src/core/services/auth";

import { AUTH_KEY, LocalNetwork, makeJwt } from "#tests/utils/network";

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
        const keySeed = Buffer.from("channel-specific-seed").toString("base64");
        const channelUUID = await network.getChannelUUID({ keySeed });
        const channel = Channel.records.get(channelUUID);
        await expect(network.connect(channelUUID, 3, { key: AUTH_KEY })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
        await expect(network.connect(channelUUID, 3, { key: "wrong-key" })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
    });
    test("can join a channel with its derived key", async () => {
        const keySeed = Buffer.from("channel-specific-seed").toString("base64");
        const key = auth.deriveChannelKey(keySeed);
        const channelUUID = await network.getChannelUUID({ keySeed });
        const channel = Channel.records.get(channelUUID);
        await network.connect(channelUUID, 4, { key });
        expect(channel!.sessions.size).toBe(1);
    });
    test("can join a channel with its legacy key", async () => {
        const key = Buffer.from("legacy-channel-key").toString("base64");
        const channelUUID = await network.getChannelUUID({ key });
        const channel = Channel.records.get(channelUUID);
        await network.connect(channelUUID, 4, { key });
        expect(channel!.sessions.size).toBe(1);
    });
    test("prefers a channel key seed over a legacy key", async () => {
        const keySeed = Buffer.from("channel-specific-seed").toString("base64");
        const key = Buffer.from("legacy-channel-key").toString("base64");
        const channelUUID = await network.getChannelUUID({ key, keySeed });
        const channel = Channel.records.get(channelUUID);
        await expect(network.connect(channelUUID, 4, { key })).rejects.toThrow();
        expect(channel!.sessions.size).toBe(0);
        await network.connect(channelUUID, 4);
        expect(channel!.sessions.size).toBe(1);
    });
    test("Legacy Auth: Succeeds if channel has NO key and channelUUID not provided", async () => {
        const channelUUID = await network.getChannelUUID({
            keySeed: "",
            recordingAddress: ""
        });
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
    test("cannot omit key or key seed when recordingAddress is provided", async () => {
        await expect(
            network.getChannelUUID({ keySeed: "", recordingAddress: "dummy-dest" })
        ).rejects.toThrow();
    });
});
