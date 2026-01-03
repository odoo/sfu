import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import path from "node:path";

import { mockFs, mockNodeFS } from "./utils/mockFileSystem.ts";
mockNodeFS();

import * as resources from "#src/services/resources.ts";
import * as config from "#src/config.ts";

describe("resources service", () => {
    beforeEach(async () => {
        await resources.start();
    });
    afterEach(() => {
        resources.close();
    });
    test("worker load should be evenly distributed", async () => {
        const usedWorkers = new Set();
        for (let i = 0; i < config.NUM_WORKERS; ++i) {
            const worker = await resources.getWorker();
            const router = await worker.createRouter({});
            const webRtcServer = await worker.createWebRtcServer(config.rtc.rtcServerOptions);
            const promises = [];
            for (let i = 0; i < 500; ++i) {
                // creating a lot of transports to make sure that the test is not unreliable as load can vary
                promises.push(
                    router.createWebRtcTransport({
                        ...config.rtc.rtcTransportOptions,
                        webRtcServer
                    })
                );
            }
            await Promise.all(promises);
            usedWorkers.add(worker);
        }
        expect(usedWorkers.size).toBe(config.NUM_WORKERS);
    });
    test("worker should be replaced if it dies", async () => {
        const worker = await resources.getWorker();
        const pid = worker.pid;
        process.kill(pid, "SIGTERM");

        await new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (
                    resources.__testing__.workerCount === config.NUM_WORKERS &&
                    !resources.__testing__.hasWorker(worker)
                ) {
                    clearInterval(interval);
                    resolve();
                }
            }, 10);
        });

        const newWorker = await resources.getWorker();
        expect(newWorker.pid).not.toBe(pid);
        expect(resources.__testing__.workerCount).toBe(config.NUM_WORKERS);
    });
    test("getAllowedCodecs should respect environment variables", async () => {
        const { withMockEnv } = await import("./utils/utils");
        const restore = withMockEnv({
            AUDIO_CODECS: "opus,PCMU",
            VIDEO_CODECS: "VP8,H264"
        });

        const { getAllowedCodecs } = await import("#src/utils/utils");
        const codecs = getAllowedCodecs();

        expect(codecs).toHaveLength(4);
        expect(codecs.map((c) => c.mimeType)).toEqual([
            "audio/opus",
            "audio/PCMU",
            "video/VP8",
            "video/H264"
        ]);

        restore();
    });

    test("folder should be created and managed", async () => {
        const folder = await resources.getFolder(["sub1", "sub2"]);
        expect(mockFs.exists(folder.path)).toBe(true);
        expect(mockFs.exists(path.join(folder.path, "sub1"))).toBe(true);
        expect(mockFs.exists(path.join(folder.path, "sub2"))).toBe(true);

        await folder.add("test.txt", "hello world");
        expect(mockFs.exists(path.join(folder.path, "test.txt"))).toBe(true);
        expect(await mockFs.readFile(path.join(folder.path, "test.txt"))).toBe("hello world");

        const oldPath = folder.path;
        const newPath = path.join(config.RESOURCES_PATH, "sealed-folder");
        await folder.seal(newPath);
        expect(mockFs.exists(oldPath)).toBe(false);
        expect(mockFs.exists(newPath)).toBe(true);
        expect(mockFs.exists(path.join(newPath, "test.txt"))).toBe(true);
        expect(folder.path).toBe(newPath);

        await folder.delete();
        expect(mockFs.exists(newPath)).toBe(false);
    });

    test("ports should be allocated and released", async () => {
        const { withMockEnv } = await import("./utils/utils");
        const restore = withMockEnv({
            DYNAMIC_MIN_PORT: "10000",
            DYNAMIC_MAX_PORT: "10004"
        });

        const resources = await import("#src/services/resources");
        await resources.start();

        const port1 = new resources.DynamicPort();
        const port2 = new resources.DynamicPort();
        const port3 = new resources.DynamicPort();

        expect(port1.number).toBe(10000);
        expect(port2.number).toBe(10002);
        expect(port3.number).toBe(10004);

        expect(() => new resources.DynamicPort()).toThrow();

        port2.release();
        const port4 = new resources.DynamicPort();
        expect(port4.number).toBe(10002);

        resources.close();
        restore();
    });
});
