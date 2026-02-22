import { describe, expect, test } from "@jest/globals";

import { RECORDING_RESERVATION_BYTES } from "#src/core/services/resources.ts";

import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";
import { withMockEnv } from "#tests/utils/utils.ts";

mockNodeFS();

describe("Folder disk reservation guard", () => {
    test("rejects folder creation when there is not enough free disk", async () => {
        const restoreEnv = withMockEnv({
            AUTH_KEY: "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=",
            PUBLIC_IP: "127.0.0.1",
            RECORDING: "true",
            DATA_PATH: "/mock"
        });
        const disk = await import("#tests/utils/mockFileSystem.ts");
        const resources = await import("#src/core/services/resources.ts");

        try {
            disk.mockFs.setAvailableDiskSpace(RECORDING_RESERVATION_BYTES - 1);
            await expect(resources.Folder.create("insufficient", [])).rejects.toMatchObject({
                name: "DiskSpaceLimitReachedError"
            });
        } finally {
            restoreEnv();
        }
    });

    test("releases reservation after folder delete", async () => {
        const restoreEnv = withMockEnv({
            AUTH_KEY: "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=",
            PUBLIC_IP: "127.0.0.1",
            RECORDING: "true",
            DATA_PATH: "/mock"
        });
        const resources = await import("#src/core/services/resources.ts");

        try {
            const first = await resources.Folder.create("first", []);
            expect(resources.__testing__.reservedRecordingBytes).toBe(RECORDING_RESERVATION_BYTES);

            await first.delete();
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
