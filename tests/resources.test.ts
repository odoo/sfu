import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import path from "node:path";
import fs from "node:fs/promises";
import * as mediasoup from "mediasoup";

import * as config from "#src/config.ts";

import { mockFs, mockNodeFS } from "#tests/utils/mockFileSystem.ts";

mockNodeFS(); // mocking FS before importing resources
import * as resources from "#src/core/services/resources.ts";

describe("resources service", () => {
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

    test("folder should be created and managed", async () => {
        const folder = await resources.Folder.create("name", ["sub1", "sub2"]);
        expect(mockFs.exists(folder.path)).toBe(true);
        expect(mockFs.exists(path.join(folder.path, "sub1"))).toBe(true);
        expect(mockFs.exists(path.join(folder.path, "sub2"))).toBe(true);

        await folder.add("test.txt", "hello world");
        expect(mockFs.exists(path.join(folder.path, "test.txt"))).toBe(true);
        expect(await mockFs.readFile(path.join(folder.path, "test.txt"))).toBe("hello world");

        const oldPath = folder.path;
        const newPath = path.join(config.dir.resources, "nested", "path", "sealed-folder");
        await folder.move(newPath);
        expect(mockFs.exists(oldPath)).toBe(false);
        const expectedPath = path.join(newPath, folder.name);
        expect(mockFs.exists(expectedPath)).toBe(true);
        expect(mockFs.exists(path.join(expectedPath, "test.txt"))).toBe(true);
        expect(folder.path).toBe(expectedPath);

        await folder.delete();
        expect(mockFs.exists(path.join(config.dir.resources, "nested"))).toBe(true);
        expect(mockFs.exists(expectedPath)).toBe(false);
        await fs.rm(path.join(config.dir.resources, "nested"), { recursive: true, force: true });
    });

    test("ports should be allocated and released", async () => {
        const { withMockEnv } = await import("./utils/utils");
        const restore = withMockEnv({
            DYNAMIC_MIN_PORT: "10000",
            DYNAMIC_MAX_PORT: "10004"
        });

        const resources = await import("#src/core/services/resources.ts");
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

        await resources.close();
        restore();
    });
});
