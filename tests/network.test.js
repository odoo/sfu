import { once } from "node:events";

import { describe, beforeEach, afterEach, expect, jest } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { SESSION_CLOSE_CODE, SESSION_STATE } from "#src/models/session.js";
import { Channel } from "#src/models/channel.js";
import { SFU_CLIENT_STATE } from "#src/client.js";
import { timeouts } from "#src/config.js";

import { LocalNetwork } from "#tests/utils/network.js";

const HTTP_INTERFACE = "0.0.0.0";
const PORT = 61254;

describe("Full network", () => {
    /** @type {LocalNetwork} */
    let network;
    beforeEach(async () => {
        network = new LocalNetwork();
        await network.start(HTTP_INTERFACE, PORT);
    });
    afterEach(() => {
        network.close();
        jest.useRealTimers();
    });
    test("Multiple clients handshake and reach connected state", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const [firstStateChange] = await once(user1.session, "stateChange");
        expect(firstStateChange).toBe(SESSION_STATE.CONNECTED);
        const user2 = await network.connect(channelUUID, 2);
        const [secondStateChange] = await once(user2.session, "stateChange");
        expect(secondStateChange).toBe(SESSION_STATE.CONNECTED);
        const user3 = await network.connect(channelUUID, 3);
        const [thirdStateChange] = await once(user3.session, "stateChange");
        expect(thirdStateChange).toBe(SESSION_STATE.CONNECTED);
    });
    test("The session of the server closes when the client is disconnected", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        expect(user1.session).toBeDefined();
        user1.sfuClient.disconnect();
        await once(user1.session, "close");
        expect(user1.session.state).toBe(SESSION_STATE.CLOSED);
    });
    test("The server notifies other sessions when one is disconnected", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        user2.session.close();
        const [event] = await once(user1.sfuClient, "update");
        expect(event.detail).toEqual({
            name: "disconnect",
            payload: { sessionId: 2 },
        });
    });
    test("Sessions broadcast info to each other", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        user2.session._broadcastInfo();
        const [event] = await once(user1.sfuClient, "update");
        expect(event.detail.name).toBe("info_change");
        expect(event.detail.payload).toEqual({
            [2]: {
                isRaisingHand: undefined,
                isTalking: undefined,
                isSelfMuted: undefined,
                isDeaf: undefined,
                isCameraOn: undefined,
                isScreenSharingOn: undefined,
            },
        });
    });
    test("Server session info can be updated by the client", async () => {
        const channelUUID = await network.getChannelUUID();
        const sender = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 3);
        expect(sender.session.info).toEqual({
            isRaisingHand: undefined,
            isTalking: undefined,
            isSelfMuted: undefined,
            isDeaf: undefined,
            isCameraOn: undefined,
            isScreenSharingOn: undefined,
        });
        const info = {
            isRaisingHand: true,
            isTalking: false,
            isSelfMuted: true,
            isDeaf: false,
            isCameraOn: true,
            isScreenSharingOn: false,
        };
        sender.sfuClient.updateInfo(info);
        const [event] = await once(user2.sfuClient, "update");
        expect(event.detail.name).toBe("info_change");
        expect(event.detail.payload).toEqual({ [1]: info });
        // if we mock a network with multiple session, we should check if the other sessions get the update too
    });
    test("Can obtain the info of the whole channel", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        const [firstStateChange] = await once(user1.session, "stateChange");
        expect(firstStateChange).toBe(SESSION_STATE.CONNECTED);
        const user2 = await network.connect(channelUUID, 2);
        const [secondStateChange] = await once(user2.session, "stateChange");
        expect(secondStateChange).toBe(SESSION_STATE.CONNECTED);
        const user3 = await network.connect(channelUUID, 3);
        const [thirdStateChange] = await once(user3.session, "stateChange");
        expect(thirdStateChange).toBe(SESSION_STATE.CONNECTED);
        const user3Info = {
            isRaisingHand: true,
            isTalking: false,
            isSelfMuted: true,
        };
        user3.sfuClient.updateInfo(user3Info, { needRefresh: true });
        const [event] = await once(user3.sfuClient, "update");
        expect(event.detail.payload).toEqual({
            [user1.session.id]: {},
            [user2.session.id]: {},
            [user3.session.id]: user3Info,
        });
    });
    test("Connecting multiple times with the same session id closes the previous ones", async () => {
        const sameId = 1;
        const channelUUID = await network.getChannelUUID();
        const channel = Channel.records.get(channelUUID);
        const user1 = await network.connect(channelUUID, sameId);
        const user2 = await network.connect(channelUUID, sameId);
        const user3 = await network.connect(channelUUID, sameId);
        const lastSession = channel.sessions.get(sameId);
        expect(user1.session).not.toBe(lastSession);
        expect(user2.session).not.toBe(lastSession);
        expect(user3.session).toBe(lastSession);
        expect(channel.sessions.size).toBe(1);
    });
    test("A client can forward a track to other clients", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await once(user1.session, "stateChange");
        const user2 = await network.connect(channelUUID, 2);
        await once(user2.session, "stateChange");
        const sender = await network.connect(channelUUID, 3);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        await sender.sfuClient.updateUpload("audio", track);
        const prom1 = once(user1.sfuClient, "update");
        const prom2 = once(user2.sfuClient, "update");
        const [[event1], [event2]] = await Promise.all([prom1, prom2]);
        expect(event1.detail.name).toEqual("track");
        expect(event2.detail.name).toEqual("track");
        expect(event1.detail.payload.sessionId).toBe(sender.session.id);
        expect(event2.detail.payload.sessionId).toBe(sender.session.id);
        expect(event1.detail.payload.track.kind).toBe("audio");
        expect(event2.detail.payload.track.kind).toBe("audio");
    });
    test("Recovery attempts are made if the production fails, a failure does not close the connection", async () => {
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 1);
        await once(user.session, "stateChange");
        const sender = await network.connect(channelUUID, 3);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        // closing the transport so the `updateUpload` should fail.
        sender.sfuClient._ctsTransport.close();
        await sender.sfuClient.updateUpload("audio", track);
        expect(sender.sfuClient.errors.length).toBe(1);
        expect(sender.sfuClient.state).toBe(SFU_CLIENT_STATE.CONNECTED);
    });
    test("Recovery attempts are made if the consumption fails, a failure does not close the connection", async () => {
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 1);
        await once(user.session, "stateChange");
        const sender = await network.connect(channelUUID, 3);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        // closing the transport so the consumption should fail.
        user.session._stcTransport.close();
        await sender.sfuClient.updateUpload("audio", track);
        // not ideal but we have to wait a tick for the websocket message to go through
        await new Promise(setTimeout);
        expect(user.session.errors.length).toBe(1);
        expect(user.session.state).toBe(SESSION_STATE.CONNECTED);
    });
    test("The client can obtain download and upload statistics", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await once(user1.session, "stateChange");
        const sender = await network.connect(channelUUID, 3);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        await sender.sfuClient.updateUpload("audio", track);
        await once(user1.sfuClient, "update");
        const stats = await sender.sfuClient.getStats();
        // since it is a fake webRTC connection, there is no stats
        expect(stats).toHaveProperty("downloadStats");
        expect(stats).toHaveProperty("uploadStats");
        expect(stats).toHaveProperty("audio");
    });
    test("The client can update the state of their downloads", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1234);
        await once(user1.session, "stateChange");
        const sender = await network.connect(channelUUID, 123);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "audio" });
        await sender.sfuClient.updateUpload("audio", track);
        await once(user1.sfuClient, "update");
        user1.sfuClient.updateDownload(sender.session.id, { audio: false });
        // waiting for the websocket message to go through
        await new Promise(setTimeout);
        user1.sfuClient.updateDownload(sender.session.id, { audio: true });
        await new Promise((resolve) => {
            // this 100ms is not ideal, but it prevents a race condition where the worker is closed right
            // when the consumer is updated, which prevents the main process to send that message to the worker,
            // this is not a problem in production as it is normal that workers that are closed do not send messages.
            setTimeout(resolve, 100);
        });
        expect(user1.sfuClient.state).toBe(SFU_CLIENT_STATE.CONNECTED);
        expect(user1.session.state).toBe(SESSION_STATE.CONNECTED);
    });
    test("The client can update the state of their upload", async () => {
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1234);
        await once(user1.session, "stateChange");
        const sender = await network.connect(channelUUID, 123);
        await once(sender.session, "stateChange");
        const track = new FakeMediaStreamTrack({ kind: "video" });
        await sender.sfuClient.updateUpload("camera", track);
        await once(user1.sfuClient, "update");
        await sender.sfuClient.updateUpload("camera", null);
        const [event] = await once(user1.sfuClient, "update");
        expect(event.detail.name).toBe("info_change");
        expect(event.detail.payload).toEqual({
            [sender.session.id]: {
                isCameraOn: false,
            },
        });
    });
    test("Sessions are closed after connection timeout", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 23);
        const closeProm = once(user.session, "close");
        jest.advanceTimersByTime(timeouts.session + 10);
        const [closeEvent] = await closeProm;
        expect(closeEvent.code).toBe(SESSION_CLOSE_CODE.C_TIMEOUT);
    });
    test("Sessions are closed after ping timeouts", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const channelUUID = await network.getChannelUUID();
        const user = await network.connect(channelUUID, 273);
        const [stateChangeEvent] = await once(user.session, "stateChange");
        // we must pass the connected step before advancing time so that the session is not closed by the connection timeout
        expect(stateChangeEvent).toBe("connected");
        const closeProm = once(user.session, "close");
        // waiting for the first ping, then for the timeout of the ping response
        jest.advanceTimersByTime(timeouts.ping + timeouts.session + 10);
        const [closeEvent] = await closeProm;
        expect(closeEvent.code).toBe(SESSION_CLOSE_CODE.P_TIMEOUT);
    });
    test("A client can broadcast arbitrary messages to other clients on a channel that does not have webRTC", async () => {
        const channelUUID = await network.getChannelUUID(false);
        const user1 = await network.connect(channelUUID, 1);
        const user2 = await network.connect(channelUUID, 2);
        const sender = await network.connect(channelUUID, 3);
        const message = "hello";
        sender.sfuClient.broadcast(message);
        const prom1 = once(user1.sfuClient, "update");
        const prom2 = once(user2.sfuClient, "update");
        const [[event1], [event2]] = await Promise.all([prom1, prom2]);
        expect(event1.detail.name).toEqual("broadcast");
        expect(event2.detail.name).toEqual("broadcast");
        expect(event1.detail.payload.senderId).toBe(sender.session.id);
        expect(event2.detail.payload.senderId).toBe(sender.session.id);
        expect(event1.detail.payload.message).toBe(message);
        expect(event2.detail.payload.message).toBe(message);
    });
});
