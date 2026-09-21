import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import * as mediasoup from "mediasoup";

import * as rtc from "#src/services/rtc.ts";

describe("rtc service", () => {
    beforeEach(async () => {
        await rtc.start();
    });
    afterEach(async () => {
        await rtc.close();
    });
    test("worker should be replaced if it dies", async () => {
        const worker = await rtc.getWorker();
        const replacementReady = new Promise<rtc.RtcWorker>((resolve) => {
            mediasoup.observer.once("newworker", (replacement) => {
                replacement.observer.once("newwebrtcserver", () =>
                    resolve(replacement as rtc.RtcWorker)
                );
            });
        });
        process.kill(worker.pid, "SIGTERM");

        const replacement = await replacementReady;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await rtc.getWorker()).toBe(replacement);
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
