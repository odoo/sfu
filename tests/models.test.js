import { describe, beforeEach, afterEach, expect, jest } from "@jest/globals";

import * as rtc from "#src/services/rtc.js";
import { Channel } from "#src/models/channel.js";
import { timeouts, CHANNEL_SIZE } from "#src/config.js";
import { OvercrowdedError } from "#src/utils/errors.js";

describe("Models", () => {
    beforeEach(async () => {
        await rtc.start();
    });
    afterEach(() => {
        Channel.closeAll();
        rtc.close();
    });
    test("Create channel and session", async () => {
        const channel = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel.uuid, 7);
        expect(channel.sessions.size).toBe(1);
        expect(channel.sessions.get(7)).toBeDefined();
    });
    test("should clear channel and session when leaving", async () => {
        const channel = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel.uuid, 3);
        const session = channel.sessions.get(3);
        expect(channel.sessions.size).toBe(1);
        session.close();
        expect(channel.sessions.size).toBe(0);
        expect(Channel.records.size).toBe(1);
    });
    test("should have the right amount of sessions on the channel", async () => {
        const channel1 = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel1.uuid, 2);
        Channel.join(channel1.uuid, 3);
        Channel.join(channel1.uuid, 4);
        const channel2 = await Channel.create("testRemote", "testIssuer2");
        Channel.join(channel2.uuid, 9);

        expect(channel1.sessions.size).toBe(3);
        expect(channel2.sessions.size).toBe(1);
    });
    test("The amount of records should be consistent with the amount sessions", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const channel1 = await Channel.create("testRemote", "testIssuer");
        Channel.join(channel1.uuid, 2);
        Channel.join(channel1.uuid, 3);
        Channel.join(channel1.uuid, 3);
        Channel.join(channel1.uuid, 3);
        Channel.join(channel1.uuid, 4);
        const channel2 = await Channel.create("testRemote", "testIssuer2");
        Channel.join(channel2.uuid, 9);
        Channel.join(channel2.uuid, 4);
        Channel.join(channel2.uuid, 2);

        expect(Channel.records.size).toBe(2);
        expect(channel1.sessions.size).toBe(3);
        expect(channel2.sessions.size).toBe(3);

        for (const session of channel1.sessions.values()) {
            session.close();
        }
        expect(channel1.sessions.size).toBe(0);
        for (const session of channel2.sessions.values()) {
            session.close();
        }
        expect(channel2.sessions.size).toBe(0);
        expect(Channel.records.size).toBe(2);
        jest.advanceTimersByTime(timeouts.channel + 10);
        expect(Channel.records.size).toBe(0);
        jest.useRealTimers();
    });
    test("should not be more sessions past channel size limit", async () => {
        const channel1 = await Channel.create("testRemote", "testIssuer");
        for (let i = 0; i < CHANNEL_SIZE; i++) {
            Channel.join(channel1.uuid, i);
        }
        await expect(() => {
            Channel.join(channel1.uuid, CHANNEL_SIZE + 1);
        }).toThrow(OvercrowdedError);
    });
});
