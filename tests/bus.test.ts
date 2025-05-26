import { EventEmitter } from "node:events";

import { expect, describe, jest } from "@jest/globals";

import { Bus } from "#src/shared/bus";
import type { JSONSerializable, BusMessage } from "#src/shared/types";

class MockTargetWebSocket extends EventTarget {
    send(message: JSONSerializable) {
        this.dispatchEvent(new MessageEvent("propagate_message", { data: message }));
    }
    close() {
        this.dispatchEvent(new CustomEvent("propagate_close"));
        this.dispatchEvent(new CustomEvent("close"));
    }
}
class MockWebSocket extends EventEmitter {
    send(message: JSONSerializable) {
        this.emit("propagate_message", message);
    }
    close() {
        this.emit("propagate_close");
        this.emit("close");
    }
}

function pipeSockets(mockWebSocket: MockWebSocket, mockTargetWebSocket: MockTargetWebSocket) {
    mockTargetWebSocket.addEventListener("propagate_message", (event) => {
        const payload = (event as MessageEvent).data;
        mockWebSocket.emit("message", payload);
    });
    mockTargetWebSocket.addEventListener("propagate_close", (event) => {
        const code = (event as CustomEvent).detail?.code;
        mockWebSocket.emit("close", { code });
    });
    mockWebSocket.on("propagate_message", (payload) => {
        mockTargetWebSocket.dispatchEvent(new MessageEvent("message", { data: payload }));
    });
    mockWebSocket.on("propagate_close", () => {
        mockTargetWebSocket.dispatchEvent(new CustomEvent("close"));
    });
}

/**
 * @returns {{aliceSocket: MockWebSocket, bobSocket: MockTargetWebSocket}}
 */
function mockSocketPair() {
    const aliceSocket = new MockWebSocket();
    const bobSocket = new MockTargetWebSocket();
    // piping events between the sockets
    pipeSockets(aliceSocket, bobSocket);
    return { aliceSocket, bobSocket };
}

describe("Bus API", () => {
    test("message()", () => {
        let receivedMessage;
        const { aliceSocket, bobSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket as unknown as WebSocket);
        const bobBus = new Bus(bobSocket as unknown as WebSocket);
        aliceBus.onMessage = (message) => {
            receivedMessage = message;
        };
        bobBus.send("hello" as unknown as BusMessage);
        expect(receivedMessage).toBe("hello");
    });
    test("request()", async () => {
        const { aliceSocket, bobSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket as unknown as WebSocket);
        const bobBus = new Bus(bobSocket as unknown as WebSocket);
        //@ts-expect-error we do not need to return for the test
        bobBus.onRequest = (message: JSONSerializable) => {
            if (message === "ping") {
                return "pong";
            }
        };
        const response = await aliceBus.request("ping" as unknown as BusMessage);
        expect(response).toBe("pong");
    });
    test("promises are rejected when the bus is closed", async () => {
        const { aliceSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket as unknown as WebSocket);
        let rejected = false;
        const promise = aliceBus.request("ping" as unknown as BusMessage);
        aliceBus.close();
        try {
            await promise;
        } catch {
            rejected = true;
        }
        expect(rejected).toBe(true);
    });
    test("Bus requests do timeout", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const { aliceSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket as unknown as WebSocket);
        const timeout = 500;
        const promise = aliceBus.request("hello" as unknown as BusMessage, { timeout });
        jest.advanceTimersByTime(timeout);
        await expect(promise).rejects.toThrow();
        jest.useRealTimers();
    });
    test("Bus does batch messages, respects order and timing", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const { aliceSocket, bobSocket } = mockSocketPair();
        const testBatchDelay = 10000;
        const aliceBus = new Bus(aliceSocket as unknown as WebSocket, {
            batchDelay: testBatchDelay
        });
        const bobBus = new Bus(bobSocket as unknown as WebSocket);
        const receivedMessages: string[] = [];
        bobBus.onMessage = (message) => {
            receivedMessages.push(message as unknown as string);
        };
        const firstBatch = ["0", "1", "2", "3", "4"];
        for (const message of firstBatch) {
            aliceBus.send(message as unknown as BusMessage, { batch: true });
        }
        // the first message of the batch is sent immediately
        expect(receivedMessages).toStrictEqual([firstBatch[0]]);
        jest.advanceTimersByTime(testBatchDelay / 2);
        // no message additional message is sent before the batch delay
        expect(receivedMessages).toStrictEqual([firstBatch[0]]);
        jest.advanceTimersByTime(testBatchDelay / 2);
        // the rest of the messages are sent after the batch delay, in order
        expect(receivedMessages).toStrictEqual(firstBatch);
        const secondBatch = ["5", "6", "7", "8", "9"];
        for (const message of secondBatch) {
            aliceBus.send(message as unknown as BusMessage, { batch: true });
        }
        expect(receivedMessages).toStrictEqual([...firstBatch, secondBatch[0]]);
        jest.advanceTimersByTime(testBatchDelay);
        expect(receivedMessages).toStrictEqual(firstBatch.concat(secondBatch));
        jest.useRealTimers();
    });
});
