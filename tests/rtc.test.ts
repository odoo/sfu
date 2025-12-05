import { afterEach, beforeEach, describe, expect } from "@jest/globals";

import * as resources from "#src/services/resources";
import * as config from "#src/config";

describe("rtc service", () => {
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
                    resources.workers.size === config.NUM_WORKERS &&
                    !resources.workers.has(worker)
                ) {
                    clearInterval(interval);
                    resolve();
                }
            }, 10);
        });

        const newWorker = await resources.getWorker();
        expect(newWorker.pid).not.toBe(pid);
        expect(resources.workers.size).toBe(config.NUM_WORKERS);
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
});
