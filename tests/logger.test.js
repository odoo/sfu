import { beforeAll, afterAll, describe, jest, afterEach, expect } from "@jest/globals";

import { Logger } from "#src/utils/utils.js";

describe("Logger", () => {
    let mockLog;
    let messages = [];
    beforeAll(() => {
        mockLog = jest.spyOn(global.console, "log").mockImplementation((message) => {
            messages.push(message);
        });
        mockLog = jest.spyOn(global.console, "error").mockImplementation((message) => {
            messages.push(message);
        });
        jest.useFakeTimers().setSystemTime(new Date("2023-09-15 08:29:00.000 UTC"));
    });
    afterEach(() => {
        messages = [];
    });
    afterAll(() => {
        mockLog.mockRestore();
        jest.useRealTimers();
    });
    test("Logger has expected format", () => {
        const logger = new Logger("test1", {
            logLevel: "debug",
            timestamp: true,
            useColors: false,
        });
        logger.warn("test");
        expect(messages.pop()).toBe("2023-09-15T08:29:00.000Z odoo-sfu :WARN: [test1] - test");
        const logger2 = new Logger("test2", {
            logLevel: "debug",
            timestamp: false,
            useColors: false,
        });
        logger2.debug("test");
        expect(messages.pop()).toBe("odoo-sfu :DEBUG: [test2] - test");
    });
    test("logger respects log level", () => {
        const logEach = (logger) => {
            logger.verbose("test");
            logger.debug("test");
            logger.info("test");
            logger.warn("test");
            logger.error("test");
        };
        logEach(new Logger("none", { logLevel: "none" }));
        expect(messages.length).toBe(0);
        logEach(new Logger("error", { logLevel: "error" }));
        expect(messages.length).toBe(1);
        messages = [];
        logEach(new Logger("warn", { logLevel: "warn" }));
        expect(messages.length).toBe(2);
        messages = [];
        logEach(new Logger("info", { logLevel: "info" }));
        expect(messages.length).toBe(3);
        messages = [];
        logEach(new Logger("debug", { logLevel: "debug" }));
        expect(messages.length).toBe(4);
        messages = [];
        logEach(new Logger("verbose", { logLevel: "verbose" }));
        expect(messages.length).toBe(5);
    });
});
