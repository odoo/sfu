import { describe, expect, test } from "@jest/globals";

import { RECORDING_RESERVATION_BYTES } from "#src/core/services/resources.ts";

import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";
import { withMockEnv } from "#tests/utils/utils.ts";

mockNodeFS();

describe("Folder disk reservation guard", () => {
    test.each([undefined, "", "8.5"])(
        "reserves concurrent folders with budget %s MB",
        async (budget) => {
            const restoreEnv = withMockEnv({
                AUTH_KEY: "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=",
                PUBLIC_IP: "127.0.0.1",
                RECORDING: "true",
                DATA_PATH: "/mock",
                RECORDING_RESERVATION_MB: budget
            });
            try {
                const resources = await import("#src/core/services/resources.ts");
                const disk = await import("#tests/utils/mockFileSystem.ts");
                expect(resources.RECORDING_RESERVATION_BYTES).toBe(
                    budget ? Number(budget) * 1_000_000 : RECORDING_RESERVATION_BYTES
                );
                disk.mockFs.setAvailableDiskSpace(resources.RECORDING_RESERVATION_BYTES * 1.5);
                const results = await Promise.allSettled([
                    resources.Folder.create("first", []),
                    resources.Folder.create("second", [])
                ]);
                const folders = results.flatMap((result) =>
                    result.status === "fulfilled" ? [result.value] : []
                );

                expect(folders).toHaveLength(1);
                expect(resources.__testing__.reservedRecordingBytes).toBe(
                    resources.RECORDING_RESERVATION_BYTES
                );
                await folders[0].delete();
                expect(resources.__testing__.reservedRecordingBytes).toBe(0);
            } finally {
                restoreEnv();
            }
        }
    );

    test.each(["0", "-1", "invalid", "Infinity", "1e20"])(
        "rejects invalid recording reservation %s",
        async (budget) => {
            const restoreEnv = withMockEnv({ RECORDING_RESERVATION_MB: budget });
            try {
                await expect(import("#src/config.ts")).rejects.toThrow("RECORDING_RESERVATION_MB");
            } finally {
                restoreEnv();
            }
        }
    );

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
