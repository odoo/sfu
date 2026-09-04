import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { Device, FakeHandler, testFakeParameters } from "mediasoup-client";

import { SfuClient, SfuClientState } from "#src/client";

class MockWebSocket extends EventTarget {
    readonly CLOSING = 2;
    readyState = 1;

    close(): void {
        this.readyState = 3;
    }
}

class TestSfuClient extends SfuClient {
    readonly webSocket = new MockWebSocket();

    protected override _createDevice(): Device {
        return new Device({
            handlerFactory: FakeHandler.createFactory(testFakeParameters)
        });
    }

    protected override _createWebSocket(): WebSocket {
        return this.webSocket as unknown as WebSocket;
    }
}

describe("SfuClient", () => {
    let client: TestSfuClient;

    beforeEach(() => {
        client = new TestSfuClient();
    });
    afterEach(() => {
        client.disconnect();
    });

    test("rejects recording requests while disconnected", async () => {
        await expect(client.setRecording({ audio: true })).rejects.toThrow(
            "SFU client is not connected"
        );
    });

    test("recovers from a malformed startup message", async () => {
        jest.useFakeTimers();
        Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
        try {
            const connection = client.connect("ws://localhost", "jwt");
            client.webSocket.dispatchEvent(new MessageEvent("message", { data: "{" }));
            await expect(connection).resolves.toBeUndefined();
            expect(client.state).toBe(SfuClientState.RECOVERING);
        } finally {
            client.disconnect();
            Reflect.deleteProperty(globalThis, "window");
            jest.useRealTimers();
        }
    });

    test("accepts a legacy empty startup message", async () => {
        const connection = client.connect("ws://localhost", "jwt");
        client.webSocket.dispatchEvent(new MessageEvent("message", { data: "" }));
        await expect(connection).resolves.toBeUndefined();
        expect(client.state).toBe(SfuClientState.AUTHENTICATED);
        expect(client.availableFeatures).toEqual({
            rtc: true,
            recording: {
                audio: false,
                transcription: false,
                video: false
            }
        });
    });

    test("applies recording capabilities and state from startup", async () => {
        const availableFeatures = {
            rtc: true,
            recording: { audio: true, transcription: true, video: false }
        };
        const recordingState = { audio: false, transcription: true, video: false };
        const connection = client.connect("ws://localhost", "jwt");
        client.webSocket.dispatchEvent(
            new MessageEvent("message", {
                data: JSON.stringify({ availableFeatures, recordingState })
            })
        );
        await expect(connection).resolves.toBeUndefined();
        expect(client.state).toBe(SfuClientState.AUTHENTICATED);
        expect(client.availableFeatures).toEqual(availableFeatures);
        expect(client.recordingState).toEqual(recordingState);
    });
});
