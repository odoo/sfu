import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withMockEnv } from "#tests/utils/utils";
import { mockFs } from "#tests/utils/mockFileSystem";
import { mockSpawn } from "#tests/utils/mockFfmpeg.ts";

export async function recordingSetup(env: Record<string, string | undefined>) {
    jest.resetModules();
    mockFs.reset();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfu-test-"));
    const resourcesPath = path.join(tmpDir, "resources");
    const recordingPath = path.join(tmpDir, "recordings");
    fs.mkdirSync(resourcesPath);
    fs.mkdirSync(recordingPath);

    const restoreEnv = withMockEnv({
        RESOURCES_PATH: resourcesPath,
        RECORDING_PATH: recordingPath,
        ...env
    });
    const { LocalNetwork } = await import("#tests/utils/network");
    const { Channel } = await import("#src/core/models/channel");
    const network = new LocalNetwork();
    await network.start("0.0.0.0", 61254);
    return {
        restore: () => {
            restoreEnv();
            network.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
        getChannel: (uuid: string) => Channel.records.get(uuid),
        network
    };
}

/**
 * Sets up the isolated environment for unit tests.
 * This handles module resetting, fresh mock generation, and dependency mocking
 * to enable testing of the MediaService and MediaCompiler in isolation.
 *
 * It bridges the gap between the top-level mocked node:child_process (using global mockSpawn)
 * and the fresh memory filesystem used by the unit test under test by updating the
 * global mockSpawn implementation to use the fresh MockChildProcess class.
 */
export async function setupUnitTestsEnv() {
    jest.resetModules();

    const disk = await import("#tests/utils/mockFileSystem");
    const ffmpeg = await import("#tests/utils/mockFfmpeg.ts");
    const FreshMockChildProcess = ffmpeg.MockChildProcess;

    const envMockFs = disk.mockFs;
    const envMockFsModule = disk.mockFsModule;

    envMockFs.reset();
    envMockFs.mkdir("/mock/recordings");
    jest.clearAllMocks();

    jest.doMock("#src/config.ts", () => ({
        __esModule: true,
        recording: {
            enabled: true,
            fileTTL: 1000 * 60 * 60,
            audioCodec: "libopus",
            audioBitRate: "64k",
            videoCodec: "libx264",
            cameraLimit: 4,
            metadataFileName: "metadata.bin"
        },
        RECORDING_PATH: "/mock/recordings",
        LOG_LEVEL: "none"
    }));

    jest.doMock("#src/core/services/auth.ts", () => ({
        __esModule: true,
        decrypt: (content: string) => content,
        sign: () => "mock_jwt"
    }));

    jest.doMock("#src/utils/utils.ts", () => ({
        __esModule: true,
        LogLevel: { DEBUG: "debug" },
        getAllowedCodecs: () => [],
        Logger: class {
            info() {}
            error() {}
            warn() {}
            debug() {}
            verbose() {}
        }
    }));

    mockSpawn.mockImplementation(
        (command, args) => new FreshMockChildProcess(command, args as string[])
    );

    return {
        mockFs: envMockFs,
        mockFsModule: envMockFsModule
    };
}
