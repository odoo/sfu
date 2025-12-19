import type { SpawnOptions, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";

import { describe, expect, jest, test, beforeEach, afterEach } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { CLIENT_UPDATE } from "#src/client";
import { TIME_TAG } from "#src/models/recording/recorder.ts";

import { withMockEnv } from "#tests/utils/utils";
import { mockSpawn, MockChildProcess } from "#tests/utils/mockFfmpeg.ts";
import { mockFs } from "#tests/utils/disk.ts";

type ChildProcessLike = {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: number | string) => boolean;
    killed: boolean;
    pid: number;
} & ChildProcess;

jest.mock("node:fs", () => {
    const { mockFsSyncModule } = jest.requireActual("#tests/utils/disk.ts") as {
        mockFsSyncModule: typeof import("#tests/utils/disk.ts").mockFsSyncModule;
    };
    return {
        ...(jest.requireActual("node:fs") as Record<string, unknown>),
        mkdtempSync: mockFsSyncModule.mkdtempSync,
        rmSync: mockFsSyncModule.rmSync,
        mkdirSync: mockFsSyncModule.mkdirSync
    };
});

jest.mock("node:fs/promises", () => {
    const { mockFsModule } = jest.requireActual("#tests/utils/disk.ts") as {
        mockFsModule: typeof import("#tests/utils/disk.ts").mockFsModule;
    };
    return mockFsModule;
});

jest.mock("node:child_process", () => {
    const original = jest.requireActual("node:child_process") as {
        spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;
    };
    return {
        ...original,
        spawn: (command: string, args: string[], options: SpawnOptions): ChildProcessLike => {
            if (command === "ffmpeg") {
                return mockSpawn(command, args, options) as unknown as ChildProcessLike;
            }
            return original.spawn(command, args, options);
        }
    };
});

async function recordingSetup(env: Record<string, string | undefined>) {
    jest.resetModules();
    mockFs.reset(); // Reset fake FS state
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfu-test-"));
    const resourcesPath = path.join(tmpDir, "resources");
    const recordingPath = path.join(tmpDir, "recordings");

    // Create these directories exist in mock fs
    // mkdtempSync creates the tmpDir.
    // We need to create resourcesPath and recordingPath
    fs.mkdirSync(resourcesPath);
    fs.mkdirSync(recordingPath);

    // making sure that means during the tests, we don't clog the resources and recordings directories
    const restoreEnv = withMockEnv({
        RESOURCES_PATH: resourcesPath,
        RECORDING_PATH: recordingPath,
        ...env
    });
    const { LocalNetwork } = await import("#tests/utils/network");
    const { Channel } = await import("#src/models/channel");
    const network = new LocalNetwork();
    await network.start("0.0.0.0", 61254);
    return {
        restore: () => {
            restoreEnv();
            network.close();
            // fs.rmSync(tmpDir, { recursive: true, force: true });
            // Mock rmSync will handle cleanup in memory
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
        getChannel: (uuid: string) => Channel.records.get(uuid),
        network
    };
}

describe("Recording & Transcription", () => {
    test("Does not record when the feature is disabled", async () => {
        const { restore } = await recordingSetup({
            RECORDING: undefined
        });
        const config = await import("#src/config");
        expect(config.recording.enabled).toBe(false);
        restore();
    });
    test("Returns false when calling start/stop recording/transcription when not connected", async () => {
        const { SfuClient } = await import("#src/client");
        const client = new SfuClient();

        expect(await client.startRecording()).toStrictEqual({ allowed: false });
        expect(await client.stopRecording()).toStrictEqual({ allowed: false });
    });
    test("can record", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        expect(user2.sfuClient.availableFeatures.recording).toBe(true);
        const recordingStartEventPromise = once(user1.sfuClient, "update");
        const startResult = await user2.sfuClient.startRecording();
        expect(startResult.allowed).toBe(true);
        const [recordingStartEvent] = await recordingStartEventPromise;
        expect(recordingStartEvent.detail).toEqual({
            name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
            payload: { state: { recording: true, transcription: false, video: false } }
        });
        expect(user2.sfuClient.recordingState.recording).toBe(true);
        const recordingEndEventPromise = once(user2.sfuClient, "update");
        const stopResult = await user1.sfuClient.stopRecording();
        const [recordingEventEnd] = await recordingEndEventPromise;
        expect(recordingEventEnd.detail).toEqual({
            name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
            payload: { state: { recording: false, transcription: false, video: false } }
        });
        expect(stopResult.allowed).toBe(true);
        restore();
    });
    test("can transcribe", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        const startResult = await user2.sfuClient.startRecording({ transcription: true });
        expect(startResult.allowed).toBe(true);
        expect(startResult.allowed).toBe(true);
        expect(user2.sfuClient.recordingState.recording).toBe(true);
        expect(user2.sfuClient.recordingState.transcription).toBe(true);

        const stopResult = await user2.sfuClient.stopRecording();
        expect(stopResult.allowed).toBe(true);
        expect(user2.sfuClient.recordingState.recording).toBe(false);
        expect(user2.sfuClient.recordingState.transcription).toBe(false);
        restore();
    });
    test("Spawns FFMPEG for both audio and video streams", async () => {
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp as unknown as MockChildProcess;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;
            await user.sfuClient.startRecording({ video: true });

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.CAMERA, videoTrack);

            await new Promise<void>((resolve) => {
                const interval = setInterval(() => {
                    if (mockSpawn.mock.calls.length >= 2) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 100);
            });

            expect(mockSpawn).toHaveBeenCalledTimes(2);

            const results = mockSpawn.mock.results as Array<{ value: ChildProcessLike }>;
            const process1 = results[0].value;
            const process2 = results[1].value;

            const readSdp = (proc: ChildProcessLike) =>
                new Promise<string>((resolve) => {
                    if (proc.stdin!.readableLength > 0) {
                        resolve(proc.stdin!.read().toString());
                    } else {
                        proc.stdin!.once("data", (chunk: Buffer) => resolve(chunk.toString()));
                    }
                });

            const sdp1 = await readSdp(process1);
            const sdp2 = await readSdp(process2);

            const sdps = [sdp1, sdp2];
            const audioSdp = sdps.find((s) => s.includes("m=audio"));
            const videoSdp = sdps.find((s) => s.includes("m=video"));

            expect(audioSdp).toBeDefined();
            expect(audioSdp).toContain("s=FFmpeg");
            expect(videoSdp).toBeDefined();
            expect(videoSdp).toContain("s=FFmpeg");

            const callArgs = mockSpawn.mock.calls.map((c) => c[1] as string[]);
            const audioArgs = callArgs.find((args) => args.includes("-c:a"));
            const videoArgs = callArgs.find((args) => args.includes("-c:v"));

            expect(audioArgs).toBeDefined();
            expect(videoArgs).toBeDefined();
        } finally {
            restore();
        }
    });

    test("Does not spawn FFMPEG for paused producers when recording starts", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => new MockChildProcess("ffmpeg", []));

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, videoTrack);
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, null);

            await user.sfuClient.startRecording({ video: true });

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error("Timeout waiting for audio spawn"));
                }, 2000);
                const interval = setInterval(() => {
                    const calls = mockSpawn.mock.calls;
                    const hasAudio = calls.some((c) => (c[1] as string[]).includes("-c:a"));
                    if (hasAudio) {
                        clearInterval(interval);
                        clearTimeout(timeout);
                        resolve();
                    }
                }, 100);
            });

            expect(mockSpawn).toHaveBeenCalledTimes(1);
            const args = mockSpawn.mock.calls[0][1] as string[];
            expect(args.join(" ")).toContain("-c:a");
            expect(args.join(" ")).not.toContain("-c:v");

            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, videoTrack);

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error("Timeout waiting for video spawn"));
                }, 2000);
                const interval = setInterval(() => {
                    if (mockSpawn.mock.calls.length >= 2) {
                        clearInterval(interval);
                        clearTimeout(timeout);
                        resolve();
                    }
                }, 100);
            });

            expect(mockSpawn).toHaveBeenCalledTimes(2);
            const calls = mockSpawn.mock.calls;
            const secondCallArgs = calls[1][1] as string[];
            expect(secondCallArgs.join(" ")).toContain("-c:v");
        } finally {
            restore();
        }
    });
});

describe("Media Service", () => {
    let mediaService: typeof import("#src/services/media.ts");
    let mockFs: typeof import("#tests/utils/disk.ts").mockFs;
    let mockFsModule: typeof import("#tests/utils/disk.ts").mockFsModule;
    // mockSpawn should use the global variable from top-level import to matches the global jest.mock closure.

    // Mock fetch
    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        jest.resetModules();
        const disk = await import("#tests/utils/disk.ts");

        mockFs = disk.mockFs;
        mockFsModule = disk.mockFsModule;
        const ffmpeg = await import("#tests/utils/mockFfmpeg.ts");
        const FreshMockChildProcess = ffmpeg.MockChildProcess;

        mockFs.reset();
        mockFs.mkdir("/mock/recordings");
        global.fetch = mockFetch;
        jest.clearAllMocks();

        // Setup default fetch response
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ recording: "http://upload/url" }),
            statusText: "OK"
        } as Response);

        // Mock config
        jest.doMock("#src/config.ts", () => ({
            __esModule: true,
            recording: {
                enabled: true,
                fileTTL: 1000 * 60 * 60, // 1 hour
                audioCodec: "libopus",
                audioBitRate: "64k"
            },
            RECORDING_PATH: "/mock/recordings",
            LOG_LEVEL: "none"
        }));

        // Mock auth
        jest.doMock("#src/services/auth.ts", () => ({
            __esModule: true,
            decrypt: (content: string) => content,
            sign: () => "mock_jwt"
        }));

        // Mock logger
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
        mediaService = await import("#src/services/media.ts");
    });

    afterEach(() => {
        if (mediaService) {
            mediaService.close();
        }
        global.fetch = originalFetch;
    });

    test("should skip if recording disabled", async () => {
        await mediaService.start();
        expect(mockFsModule.readdir).toHaveBeenCalledWith("/mock/recordings", expect.anything());
    });

    test("should process a valid recording", async () => {
        const recordingName = "session_123";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress: "http://odoo/routing",
            sealedAt: Date.now() - 1000,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1100,
                    info: { type: STREAM_TYPE.AUDIO, active: true, filename: "audio_1.ogg" }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 4000,
                    info: { type: STREAM_TYPE.AUDIO, active: false, filename: "audio_1.ogg" }
                }
            ],
            video: false,
            transcription: false
        };

        mockFs.mkdir(recordingDir);
        mockFs.mkdir(path.join(recordingDir, "audio"));
        mockFs.write(path.join(recordingDir, "metadata.json"), JSON.stringify(metadata));
        mockFs.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio content");

        await mediaService.start();

        await new Promise((r) => setTimeout(r, 50));

        expect(mockFsModule.readdir).toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            "ffmpeg",
            expect.arrayContaining([expect.stringContaining("recording_1000.ogg")]),
            undefined
        );

        const compiledPath = path.join(recordingDir, "recording_1000.ogg");
        expect(mockFs.exists(compiledPath)).toBe(true);

        expect(mockFetch).toHaveBeenCalledWith(
            "http://odoo/routing",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({ Authorization: "Bearer mock_jwt" })
            })
        );
    });

    test("should ignore invalid/incomplete recordings", async () => {
        const recordingName = "bad_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        mockFs.mkdir(recordingDir);

        await mediaService.start();
        await new Promise((r) => setTimeout(r, 50));

        expect(mockFsModule.readFile).toHaveBeenCalledWith(
            path.join(recordingDir, "metadata.json"),
            "utf-8"
        );
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });

    test("should handle expired recordings", async () => {
        const recordingName = "expired_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            sealedAt: Date.now() - 1000 * 60 * 60 * 24,
            timeStamps: []
        };

        mockFs.mkdir(recordingDir);
        mockFs.write(path.join(recordingDir, "metadata.json"), JSON.stringify(metadata));

        await mediaService.start();
        await new Promise((r) => setTimeout(r, 50));

        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });
});

describe("MediaCompiler Unit Tests", () => {
    let MediaCompiler: typeof import("#src/models/recording/media_compiler.ts").MediaCompiler;
    let mockFs: typeof import("#tests/utils/disk.ts").mockFs;
    // mockSpawn uses global variable

    beforeEach(async () => {
        jest.resetModules();
        const disk = await import("#tests/utils/disk.ts");
        mockFs = disk.mockFs;
        const ffmpeg = await import("#tests/utils/mockFfmpeg.ts");
        const FreshMockChildProcess = ffmpeg.MockChildProcess;

        mockFs.reset();
        jest.clearAllMocks();

        // Mock config required for MediaCompiler if any (likely just utils or defaults)
        jest.doMock("#src/config.ts", () => ({
            __esModule: true,
            // Add config mocks if MediaCompiler needs them (it uses config.recording?)
            recording: {
                audioCodec: "libopus",
                audioBitRate: "64k"
            }
        }));

        // Logger mock might be needed
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

        // Restore mockSpawn implementation with FRESH MockChildProcess
        mockSpawn.mockImplementation(
            (command, args) => new FreshMockChildProcess(command, args as string[])
        );

        MediaCompiler = (await import("#src/models/recording/media_compiler.ts")).MediaCompiler;
    });

    test("should compile audio correctly", async () => {
        const workingDir = "/work";
        const compiler = new MediaCompiler(workingDir, [
            {
                tag: TIME_TAG.FILE_STATE_CHANGE,
                timestamp: 1000,
                info: { type: STREAM_TYPE.AUDIO, active: true, filename: "file1.ogg" }
            },
            {
                tag: TIME_TAG.FILE_STATE_CHANGE,
                timestamp: 2000,
                info: { type: STREAM_TYPE.AUDIO, active: true, filename: "file2.ogg" }
            }
        ]);

        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "audio", "file1.ogg"), "data");
        mockFs.write(path.join(workingDir, "audio", "file2.ogg"), "data");

        const result = await compiler.compile(1000, 5000);

        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
        expect(mockSpawn).toHaveBeenCalledWith(
            "ffmpeg",
            expect.arrayContaining([
                "-i",
                path.join(workingDir, "audio", "file1.ogg"),
                "-i",
                path.join(workingDir, "audio", "file2.ogg")
            ]),
            undefined
        );
    });

    test("should return successfully if output already exists", async () => {
        const workingDir = "/work";
        const compiler = new MediaCompiler(workingDir, [
            {
                tag: TIME_TAG.FILE_STATE_CHANGE,
                timestamp: 1000,
                info: { type: STREAM_TYPE.AUDIO, active: true, filename: "file1.ogg" }
            }
        ]);

        mockFs.mkdir(workingDir);
        mockFs.write(path.join(workingDir, "recording_1000.ogg"), "existing");

        const result = await compiler.compile(1000, 5000);
        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    test("should return undefined if no audio files found", async () => {
        const workingDir = "/work";
        const compiler = new MediaCompiler(workingDir, []);
        const result = await compiler.compile(1000, 5000);
        expect(result).toBeUndefined();
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});
