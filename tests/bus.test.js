import { EventEmitter } from "node:events";

import { expect, describe, jest } from "@jest/globals";

import { Bus } from "#src/shared/bus.js";

class MockTargetWebSocket extends EventTarget {
    send(message) {
        this.dispatchEvent(new MessageEvent("propagate_message", { data: message }));
    }
    close() {
        this.dispatchEvent(new CustomEvent("propagate_close"));
        this.dispatchEvent(new CustomEvent("close"));
    }
}
class MockWebSocket extends EventEmitter {
    send(message) {
        this.emit("propagate_message", message);
    }
    close() {
        this.emit("propagate_close");
        this.emit("close");
    }
}

/**
 * @param {MockWebSocket} mockWebSocket
 * @param {MockTargetWebSocket} mockTargetWebSocket
 */
function pipeSockets(mockWebSocket, mockTargetWebSocket) {
    mockTargetWebSocket.addEventListener("propagate_message", ({ data: payload }) => {
        mockWebSocket.emit("message", payload);
    });
    mockTargetWebSocket.addEventListener("propagate_close", ({ code }) => {
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
        const aliceBus = new Bus(aliceSocket);
        const bobBus = new Bus(bobSocket);
        aliceBus.onMessage = (message) => {
            receivedMessage = message;
        };
        bobBus.send("hello");
        expect(receivedMessage).toBe("hello");
    });
    test("request()", async () => {
        const { aliceSocket, bobSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket);
        const bobBus = new Bus(bobSocket);
        bobBus.onRequest = (message) => {
            if (message === "ping") {
                return "pong";
            }
        };
        const response = await aliceBus.request("ping");
        expect(response).toBe("pong");
    });
    test("promises are rejected when the bus is closed", async () => {
        const { aliceSocket } = mockSocketPair();
        const aliceBus = new Bus(aliceSocket);
        let rejected = false;
        const promise = aliceBus.request("ping");
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
        const aliceBus = new Bus(aliceSocket);
        const timeout = 500;
        const promise = aliceBus.request("hello", { timeout });
        jest.advanceTimersByTime(timeout);
        await expect(promise).rejects.toThrow();
        jest.useRealTimers();
    });
    test("Bus does batch messages, respects order and timing", async () => {
        jest.spyOn(global, "setTimeout");
        jest.useFakeTimers();
        const { aliceSocket, bobSocket } = mockSocketPair();
        const testBatchDelay = 10000;
        const aliceBus = new Bus(aliceSocket, { batchDelay: testBatchDelay });
        const bobBus = new Bus(bobSocket);
        const receivedMessages = [];
        bobBus.onMessage = (message) => {
            receivedMessages.push(message);
        };
        const firstBatch = ["0", "1", "2", "3", "4"];
        for (const message of firstBatch) {
            aliceBus.send(message, { batch: true });
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
            aliceBus.send(message, { batch: true });
        }
        expect(receivedMessages).toStrictEqual([...firstBatch, secondBatch[0]]);
        jest.advanceTimersByTime(testBatchDelay);
        expect(receivedMessages).toStrictEqual(firstBatch.concat(secondBatch));
        jest.useRealTimers();
    });
});
