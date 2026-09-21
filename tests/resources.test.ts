import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import * as mediasoup from "mediasoup";

import * as resources from "#src/core/services/resources.ts";

describe("rtc service", () => {
    beforeEach(async () => {
        await resources.start();
    });
    afterEach(async () => {
        await resources.close();
    });
    test("worker should be replaced if it dies", async () => {
        const worker = await resources.getWorker();
        const replacementReady = new Promise<resources.RtcWorker>((resolve) => {
            mediasoup.observer.once("newworker", (replacement) => {
                replacement.observer.once("newwebrtcserver", () =>
                    resolve(replacement as resources.RtcWorker)
                );
            });
        });
        process.kill(worker.pid, "SIGTERM");

        const replacement = await replacementReady;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await resources.getWorker()).toBe(replacement);
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
