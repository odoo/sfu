import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, jest } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { SESSION_CLOSE_CODE, SESSION_STATE } from "#src/core/models/session";
import { STREAM_TYPE } from "#src/shared/enums.ts";
import { Channel } from "#src/core/models/channel";
import { CLIENT_UPDATE, SFU_CLIENT_STATE } from "#src/client";
import { timeouts } from "#src/config";
import type { Bus } from "#src/shared/bus";

import { LocalNetwork } from "#tests/utils/network";
import { waitFor } from "#tests/utils/utils";

function nextUpdate(target: EventTarget, name: CLIENT_UPDATE): Promise<CustomEvent> {
    return new Promise((resolve) => {
        const listener = (event: Event) => {
            const update = event as CustomEvent;
            if (update.detail.name !== name) {
                return;
            }
            target.removeEventListener("update", listener);
            resolve(update);
        };
        target.addEventListener("update", listener);
    });
}

describe("Full network", () => {
    let network: LocalNetwork;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start();
    });
    afterEach(async () => {
        jest.useRealTimers();
        await network.close();
    });
    test("The session of the server closes when the client is disconnected", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const close = once(user1.session, "close");
        user1.sfuClient.disconnect();
        await close;
        expect(user1.session.state).toBe(SESSION_STATE.CLOSED);
    });
    test("The server notifies other sessions when one is disconnected", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        const update = once(user1.sfuClient, "update");
        user2.session.close();
        const [event] = await update;
        expect(event.detail).toEqual({
            name: "disconnect",
            payload: { sessionId: 2 }
        });
    });
    test("Server session info can be updated by the client", async () => {
        const channelUUID = await network.getChannelUUID();
        const sender = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 3);
        const info = {
            isRaisingHand: true,
            isTalking: false,
            isSelfMuted: true,
            isDeaf: false,
            isCameraOn: true,
            isScreenSharingOn: false
        };
        const update = once(user2.sfuClient, "update");
        sender.sfuClient.updateInfo(info);
        const [event] = await update;
        expect(event.detail.name).toBe("info_change");
        expect(event.detail.payload).toEqual({ [1]: info });
    });
    test("Can obtain the info of the whole channel", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        expect(user1.session.state).toBe(SESSION_STATE.CONNECTED);
        const user2 = await network.connect(channelUUID, 2);
        expect(user2.session.state).toBe(SESSION_STATE.CONNECTED);
        const user3 = await network.connect(channelUUID, 3);
        expect(user3.session.state).toBe(SESSION_STATE.CONNECTED);
        const user3Info = {
            isRaisingHand: true,
            isTalking: false,
            isSelfMuted: true
        };
        const infoUpdate = once(user2.sfuClient, "update");
        user3.sfuClient.updateInfo(user3Info);
        const [event] = await infoUpdate;
        expect(event.detail.payload).toEqual({
            [user3.session.id]: user3Info
        });
        const refresh = once(user2.sfuClient, "update");
        user2.sfuClient.updateInfo({ isTalking: true }, { needRefresh: true });
        const [event2] = await refresh;
        expect(event2.detail.payload).toEqual({
            [user1.session.id]: {},
            [user3.session.id]: user3Info
        });
    });
    test("Connecting multiple times with the same session id closes the previous ones", async () => {
        const sameId = 1;
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        const user1 = await network.connect(channelUUID, sameId);
        const user2 = await network.connect(channelUUID, sameId);
        const user3 = await network.connect(channelUUID, sameId);
        expect(user1.session.state).toBe(SESSION_STATE.CLOSED);
        expect(user2.session.state).toBe(SESSION_STATE.CLOSED);
        expect(channel!.sessions.get(sameId)).toBe(user3.session);
        expect(channel!.sessions.size).toBe(1);
    });
    test("A client can forward a track to other clients", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        const sender = await network.connect(channelUUID, 3);
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        const prom1 = nextUpdate(user1.sfuClient, CLIENT_UPDATE.TRACK);
        const prom2 = nextUpdate(user2.sfuClient, CLIENT_UPDATE.TRACK);
        await sender.sfuClient.updateUpload(STREAM_TYPE.AUDIO, track);
        const [event1, event2] = await Promise.all([prom1, prom2]);
        expect(event1.detail.name).toEqual("track");
        expect(event2.detail.name).toEqual("track");
        expect(event1.detail.payload.sessionId).toBe(sender.session.id);
        expect(event2.detail.payload.sessionId).toBe(sender.session.id);
        expect(event1.detail.payload.track.kind).toBe("audio");
        expect(event2.detail.payload.track.kind).toBe("audio");
    });
    test("Recovery attempts are made if the production fails, a failure does not close the connection", async () => {
        const channelUUID = await network.getChannelUUID();
        const sender = await network.connect(channelUUID, 3);
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        const errorPromise = once(sender.sfuClient, "handledError");
        // closing the transport so the `updateUpload` should fail.
        // @ts-expect-error accessing private property for testing purposes
        sender.sfuClient._ctsTransport.close();
        await sender.sfuClient.updateUpload(STREAM_TYPE.AUDIO, track);
        await errorPromise;
        expect(sender.sfuClient.errors.length).toBe(1);
        expect(sender.sfuClient.state).toBe(SFU_CLIENT_STATE.CONNECTED);
    });
    test("Recovery attempts are made if the consumption fails, a failure does not close the connection", async () => {
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 1);
        const sender = await network.connect(channelUUID, 3);
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        const errorProm = once(user.session, "handledError");
        // closing the transport so the consumption should fail.
        // @ts-expect-error accessing private property for testing purposes
        user.session._stcTransport.close();
        await sender.sfuClient.updateUpload(STREAM_TYPE.AUDIO, track);
        await errorProm;
        expect(user.session.errors.length).toBe(1);
        expect(user.session.state).toBe(SESSION_STATE.CONNECTED);
    });
    test("The client can obtain download and upload statistics", async () => {
        const channelUUID = await network.getChannelUUID();
        const sender = await network.connect(channelUUID, 3);
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        await sender.sfuClient.updateUpload(STREAM_TYPE.AUDIO, track);
        const stats = await sender.sfuClient.getStats();
        expect(stats).toHaveProperty("downloadStats");
        expect(stats).toHaveProperty("uploadStats");
        expect(stats).toHaveProperty("audio");
    });
    test("The client can update the state of their downloads", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1234);
        const sender = await network.connect(channelUUID, 123);
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        const update = nextUpdate(user1.sfuClient, CLIENT_UPDATE.TRACK);
        await sender.sfuClient.updateUpload(STREAM_TYPE.AUDIO, track);
        const event = await update;
        const download = event.detail.payload.track as MediaStreamTrack;
        // @ts-expect-error verifying the server-side forwarding state
        const getServerConsumer = () => user1.session._consumers.get(sender.session.id)?.audio;
        await waitFor(getServerConsumer);
        const serverConsumer = getServerConsumer();
        expect(serverConsumer).toBeDefined();
        expect(download.enabled).toBe(true);
        const pause = once(serverConsumer!.observer, "pause");
        user1.sfuClient.updateDownload(sender.session.id, { audio: false });
        expect(download.enabled).toBe(false);
        await pause;
        expect(serverConsumer!.paused).toBe(true);
        const resume = once(serverConsumer!.observer, "resume");
        user1.sfuClient.updateDownload(sender.session.id, { audio: true });
        expect(download.enabled).toBe(true);
        await resume;
        expect(serverConsumer!.paused).toBe(false);
    });
    test("The client can update the state of their upload", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1234);
        const sender = await network.connect(channelUUID, 123);
        const track = new FakeMediaStreamTrack({ kind: "video" });
        const trackUpdate = nextUpdate(user1.sfuClient, CLIENT_UPDATE.TRACK);
        await sender.sfuClient.updateUpload(STREAM_TYPE.CAMERA, track);
        await trackUpdate;
        const infoUpdate = nextUpdate(user1.sfuClient, CLIENT_UPDATE.INFO_CHANGE);
        await sender.sfuClient.updateUpload(STREAM_TYPE.CAMERA, null);
        const event = await infoUpdate;
        expect(event.detail.name).toBe("info_change");
        expect(event.detail.payload).toEqual({
            [sender.session.id]: {
                isCameraOn: false
            }
        });
    });
    test("Sessions are closed after connection timeout", async () => {
        const channelUUID = await network.getChannelUUID();
        const { session } = Channel.join(channelUUID, 23);
        const initialization = Promise.withResolvers<void>();
        // @ts-expect-error isolating the connection timeout from transport initialization
        jest.spyOn(session, "_initializeTransports").mockReturnValue(initialization.promise);
        jest.useFakeTimers();
        const connection = session.connect({} as Bus);
        const closeProm = once(session, "close");
        await jest.advanceTimersByTimeAsync(timeouts.session);
        const [closeEvent] = await closeProm;
        initialization.resolve();
        await connection;
        expect(closeEvent.code).toBe(SESSION_CLOSE_CODE.C_TIMEOUT);
    });
    test("Sessions are closed after ping timeouts", async () => {
        const channelUUID = await network.getChannelUUID({ useWebRtc: false });
        const { session } = Channel.join(channelUUID, 273);
        const bus = {
            request: () => Promise.reject(new Error("ping timeout"))
        } as unknown as Bus;
        jest.useFakeTimers();
        await session.connect(bus);
        const closeProm = once(session, "close");
        await jest.advanceTimersByTimeAsync(timeouts.ping);
        const [closeEvent] = await closeProm;
        expect(closeEvent.code).toBe(SESSION_CLOSE_CODE.P_TIMEOUT);
    });
    test("A client can broadcast arbitrary messages to other clients on a channel that does not have webRTC", async () => {
        const channelUUID = await network.getChannelUUID({ useWebRtc: false });
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        const sender = await network.connect(channelUUID, 3);
        const message = "hello";

        const prom1 = once(user1.sfuClient, "update");
        const prom2 = once(user2.sfuClient, "update");
        sender.sfuClient.broadcast(message);
        const [[event1], [event2]] = await Promise.all([prom1, prom2]);
        expect(event1.detail.name).toEqual("broadcast");
        expect(event2.detail.name).toEqual("broadcast");
        expect(event1.detail.payload.senderId).toBe(sender.session.id);
        expect(event2.detail.payload.senderId).toBe(sender.session.id);
        expect(event1.detail.payload.message).toBe(message);
        expect(event2.detail.payload.message).toBe(message);
    });
    test("Client enters CLOSED state when server kicks session", async () => {
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 1);

        const stateChangeProm = once(user.sfuClient, "stateChange");
        user.session.close({ code: SESSION_CLOSE_CODE.KICKED });
        const [event] = await stateChangeProm;
        expect(event.detail.state).toBe(SFU_CLIENT_STATE.CLOSED);
    });
    test("Client enters RECOVERING state when session closes with ERROR code", async () => {
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 1);

        const stateChangeProm = once(user.sfuClient, "stateChange");
        user.session.close({ code: SESSION_CLOSE_CODE.ERROR });
        const [event] = await stateChangeProm;
        expect(event.detail.state).toBe(SFU_CLIENT_STATE.RECOVERING);
    });
});
