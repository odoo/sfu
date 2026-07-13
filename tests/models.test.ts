import { once } from "node:events";

import { describe, beforeEach, afterEach, expect } from "@jest/globals";

import * as resources from "#src/core/services/resources";
import { Channel } from "#src/core/models/channel";
import { CHANNEL_SIZE } from "#src/config";
import { OvercrowdedError } from "#src/utils/errors";

describe("Models", () => {
    beforeEach(async () => {
        await resources.start();
    });
    afterEach(async () => {
        await Channel.closeAll();
        await resources.close();
    });
    test("Create channel session with initial options", async () => {
        const channel = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel.uuid, 7, {
            label: "test-label",
            permissions: { audioRecording: true, transcription: true }
        });
        const session = channel.sessions.get(7);
        expect(session).toBeDefined();
        expect(session?.label).toBe("test-label");
        expect(session?.permissions.audioRecording).toBe(true);
        expect(session?.permissions.transcription).toBe(true);
        expect(session?.permissions.videoRecording).toBe(false);
    });
    test("clears the channel when its last session leaves", async () => {
        const channel = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel.uuid, 3);
        const session = channel.sessions.get(3);
        const close = once(channel, Channel.Events.CLOSE);
        session!.close();
        await close;
        await channel.close();
        expect(channel.sessions.size).toBe(0);
        expect(Channel.records.size).toBe(0);
        expect(channel.router?.closed).toBe(true);
    });
    test("should not be more sessions past channel size limit", async () => {
        const channel1 = await Channel.create("testRemote", "testIssuer");
        for (let i = 0; i < CHANNEL_SIZE; i++) {
            Channel.join(channel1.uuid, i);
        }
        expect(() => {
            Channel.join(channel1.uuid, CHANNEL_SIZE + 1);
        }).toThrow(OvercrowdedError);
    });
});
