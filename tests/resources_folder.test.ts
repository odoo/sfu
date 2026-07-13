import { describe, expect, test } from "@jest/globals";

import { RECORDING_RESERVATION_BYTES } from "#src/core/services/resources.ts";

import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";
import { withMockEnv } from "#tests/utils/utils.ts";

mockNodeFS();

describe("Folder disk reservation guard", () => {
    test("reserves and releases concurrent folders atomically", async () => {
        const restoreEnv = withMockEnv({
            AUTH_KEY: "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=",
            PUBLIC_IP: "127.0.0.1",
            RECORDING: "true",
            DATA_PATH: "/mock"
        });
        const resources = await import("#src/core/services/resources.ts");
        const disk = await import("#tests/utils/mockFileSystem.ts");

        try {
            disk.mockFs.setAvailableDiskSpace(resources.RECORDING_RESERVATION_BYTES * 1.5);
            const results = await Promise.allSettled([
                resources.Folder.create("first", []),
                resources.Folder.create("second", [])
            ]);
            const folders = results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : []
            );

            expect(folders).toHaveLength(1);
            expect(resources.__testing__.reservedRecordingBytes).toBe(RECORDING_RESERVATION_BYTES);
            await folders[0].delete();
            expect(resources.__testing__.reservedRecordingBytes).toBe(0);
        } finally {
            restoreEnv();
        }
    });

    test("rethrows move failure and releases reservation", async () => {
        const restoreEnv = withMockEnv({
            AUTH_KEY: "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=",
            PUBLIC_IP: "127.0.0.1",
            RECORDING: "true",
            DATA_PATH: "/mock"
        });
        const resources = await import("#src/core/services/resources.ts");
        const { mockFsModule } = await import("#tests/utils/mockFileSystem.ts");

        try {
            const folder = await resources.Folder.create("move-failure", []);
            mockFsModule.rename.mockRejectedValueOnce(new Error("rename failed"));

            await expect(folder.move("/mock/recordings/final")).rejects.toThrow("rename failed");
            expect(resources.__testing__.reservedRecordingBytes).toBe(0);
        } finally {
            restoreEnv();
        }
    });
});
