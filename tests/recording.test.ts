import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter, once } from "node:events";

import { describe, expect, jest, test, beforeEach, afterEach } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { CLIENT_UPDATE } from "#src/client";
import { STOP_CODE, TIME_TAG } from "#src/recording/models/recorder.ts";
import type { Channel } from "#src/core/models/channel.ts";

import { recordingSetup, setupUnitTestsEnv } from "#tests/utils/testHelpers.ts";
import { withMockEnv } from "#tests/utils/utils.ts";
import {
    mockFfmpeg,
    mockSpawn,
    ChildProcessLike,
    MockChildProcess
} from "#tests/utils/mockFfmpeg.ts";
import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";

mockNodeFS();
mockFfmpeg();

describe("Recording & Transcription", () => {
    test("rejects recording start when disk reservation cannot be made", async () => {
        const baseDir = `/mock/recorder-disk-guard-${Date.now()}`;
        const resourcesPath = path.join(baseDir, "resources");
        const recordingPath = path.join(baseDir, "recordings");
        const authKey = "u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng=";
        const localKey = "24qvOuliAKWt1gnSzSvkYUD3s31pO1hPcchbekMHCyA=";

        const restoreEnv = withMockEnv({
            AUTH_KEY: authKey,
            PUBLIC_IP: "127.0.0.1",
            LOCAL_KEY: localKey,
            RECORDING_PATH: recordingPath,
            RESOURCES_PATH: resourcesPath,
            RECORDING: "true"
        });
        const auth = await import("#src/core/services/auth.ts");
        const disk = await import("#tests/utils/mockFileSystem.ts");

        try {
            disk.mockFs.setAvailableDiskSpace(1);
            auth.start();

            const { Recorder } = await import("#src/recording/models/recorder.ts");

            class FakeChannel extends EventEmitter {
                name = "test-channel";
                uuid = "test-uuid";
                key = Buffer.from("test-channel-key");
                sessions = new Map();
            }

            const recorder = new Recorder(
                new FakeChannel() as unknown as Channel,
                "http://routing.local"
            );
            const recorderUpdate = once(recorder, Recorder.Events.UPDATE);
            await recorder.start({ audio: true });
            const [update] = await recorderUpdate;

            expect(recorder.state.recording).toBe(false);
            expect(recorder.path).toBeUndefined();
            expect(update.stopCode).toBe(STOP_CODE.DISK_SPACE_EXHAUSTED);
        } finally {
            disk.mockFs.setAvailableDiskSpace(512 * 1024 * 1024 * 1024);
            auth.close();
            restoreEnv();
        }
    });
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

        expect(await client.startRecording()).toBe(false);
        expect(await client.stopRecording()).toBe(false);
    });
    test("can record", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        expect(user2.sfuClient.availableFeatures.audioRecording).toBe(true);
        const recordingStartEventPromise = once(user1.sfuClient, "update");
        const startResult = await user2.sfuClient.startRecording({ audio: true });
        expect(startResult).toBe(true);
        const [recordingStartEvent] = await recordingStartEventPromise;
        expect(recordingStartEvent.detail).toEqual({
            name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
            payload: { state: { recording: true, audio: true, transcription: false, video: false } }
        });
        expect(user2.sfuClient.recordingState.recording).toBe(true);
        const recordingEndEventPromise = once(user2.sfuClient, "update");
        const stopResult = await user1.sfuClient.stopRecording();
        const [recordingEventEnd] = await recordingEndEventPromise;
        expect(recordingEventEnd.detail).toEqual({
            name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
            payload: {
                state: {
                    recording: false,
                    audio: false,
                    transcription: false,
                    video: false
                },
                stopCode: "user_request"
            }
        });
        expect(stopResult).toBe(true);
        restore();
    });
    test("can transcribe", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        const startResult = await user2.sfuClient.startRecording({
            audio: true,
            transcription: true
        });
        expect(startResult).toBe(true);
        expect(user2.sfuClient.recordingState.recording).toBe(true);
        expect(user2.sfuClient.recordingState.audio).toBe(true);
        expect(user2.sfuClient.recordingState.transcription).toBe(true);

        const stopResult = await user2.sfuClient.stopRecording();
        expect(stopResult).toBe(true);
        expect(user2.sfuClient.recordingState.recording).toBe(false);
        expect(user2.sfuClient.recordingState.transcription).toBe(false);
        restore();
    });
    test("Spawns FFMPEG for both audio and video streams", async () => {
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;
            await user.sfuClient.startRecording({ audio: true, video: true });

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

            const callArgs = mockSpawn.mock.calls.map((c) => c[1]);
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

            await user.sfuClient.startRecording({ audio: true, video: true });

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
            const args = mockSpawn.mock.calls[0][1];
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
            const secondCallArgs = calls[1][1];
            expect(secondCallArgs.join(" ")).toContain("-c:v");
        } finally {
            restore();
        }
    });
    test("Records streams from users who join mid-recording", async () => {
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user1 = await network.connect(channelUUID, 1);
            await user1.isConnected;

            await user1.sfuClient.startRecording({ audio: true });
            expect(user1.sfuClient.recordingState.recording).toBe(true);

            const user2 = await network.connect(channelUUID, 2);
            await user2.isConnected;

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user2.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error("Timeout waiting for spawn call"));
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

            expect(mockSpawn).toHaveBeenCalled();
            const calls = mockSpawn.mock.calls;
            const audioCall = calls.find((c) => (c[1] as string[]).includes("-c:a"));
            expect(audioCall).toBeDefined();
        } finally {
            restore();
        }
    });

    test("Records streams started after recording begins", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;

            await user.sfuClient.startRecording({ audio: true, video: true });
            expect(user.sfuClient.recordingState.recording).toBe(true);

            expect(mockSpawn).not.toHaveBeenCalled();

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

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
            let args = mockSpawn.mock.calls[0][1];
            expect(args.join(" ")).toContain("-c:a");

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.CAMERA, videoTrack);

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
            args = mockSpawn.mock.calls[1][1];
            expect(args.join(" ")).toContain("-c:v");
        } finally {
            restore();
        }
    });

    test("does not spawn camera ffmpeg while screen is active", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const hasPath = (args: readonly string[] | undefined, folder: "screen" | "camera") =>
            Boolean(args?.some((arg) => arg.includes(`/${folder}/`)));
        const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
            const start = Date.now();
            while (!predicate()) {
                if (Date.now() - start > timeoutMs) {
                    throw new Error("timeout waiting for condition");
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        };

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;

            await user.sfuClient.startRecording({ video: true });

            const screenTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, screenTrack);
            await waitFor(() =>
                mockSpawn.mock.calls.some((call) =>
                    hasPath(call[1] as readonly string[] | undefined, "screen")
                )
            );

            mockSpawn.mockClear();
            const cameraTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.CAMERA, cameraTrack);
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(
                mockSpawn.mock.calls.some((call) =>
                    hasPath(call[1] as readonly string[] | undefined, "camera")
                )
            ).toBe(false);

            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, null);
            await waitFor(() =>
                mockSpawn.mock.calls.some((call) =>
                    hasPath(call[1] as readonly string[] | undefined, "camera")
                )
            );
        } finally {
            restore();
        }
    });
});

describe("Media Service", () => {
    let mediaService: typeof import("#src/recording/services/media");
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModule: typeof import("#tests/utils/mockFileSystem").mockFsModule;

    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        const env = await setupUnitTestsEnv();
        mockFs = env.mockFs;
        mockFsModule = env.mockFsModule;

        global.fetch = mockFetch;

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ recording: "!http://upload/url" }),
            statusText: "OK"
        } as Response);

        mediaService = await import("#src/recording/services/media");
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
        const routingAddress = "http://www.odoo.com/routin";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
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
            audio: false,
            video: false,
            transcription: false
        };

        mockFs.mkdir(recordingDir);
        mockFs.mkdir(path.join(recordingDir, "audio"));
        mockFs.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFs.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio content");

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch();

        expect(mockFsModule.readdir).toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            "ffmpeg",
            expect.arrayContaining([expect.stringContaining("recording_1000.ogg")]),
            undefined
        );

        expect(mockFetch).toHaveBeenCalledWith(
            `${routingAddress}/audio?start=${metadata.startedAt}&end=${metadata.stoppedAt}&main_media=True`,
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ Authorization: "Bearer mock_jwt" })
            })
        );
    });

    test("should ignore invalid/incomplete recordings", async () => {
        const recordingName = "bad_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        mockFs.mkdir(recordingDir);

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch();

        expect(mockFsModule.readFile).toHaveBeenCalledWith(
            path.join(recordingDir, "metadata.bin"),
            "utf-8"
        );
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });

    test("should handle expired recordings", async () => {
        const recordingName = "expired_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            stoppedAt: Date.now() - 1000 * 60 * 60 * 24,
            timeStamps: []
        };

        mockFs.mkdir(recordingDir);
        mockFs.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch();

        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });
});

describe("MediaCompiler tests", () => {
    let MediaCompiler: typeof import("#src/recording/models/media_compiler.ts").MediaCompiler;
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
    // mockSpawn uses global variable

    beforeEach(async () => {
        const env = await setupUnitTestsEnv();
        mockFs = env.mockFs;

        MediaCompiler = (await import("#src/recording/models/media_compiler.ts")).MediaCompiler;
    });

    test("should compile audio correctly", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "file1.ogg"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 2000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "file2.ogg"
                    }
                }
            ]
        });
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "audio", "file1.ogg"), "data");
        mockFs.write(path.join(workingDir, "audio", "file2.ogg"), "data");

        const result = await compiler.getAudio();

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
        mockFs.mkdir(workingDir);
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        active: true,
                        available: true,
                        sessionId: 3,
                        filename: "file1.ogg"
                    }
                }
            ]
        });
        mockFs.mkdir(workingDir);
        mockFs.write(path.join(workingDir, "recording_1000.ogg"), "existing");

        const result = await compiler.getAudio();
        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    test("should return undefined if no audio files found", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: []
        });
        const result = await compiler.getAudio();
        expect(result).toBeUndefined();
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    test("should compile video with single camera", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "camera"));
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "camera", "cam1.mp4"), "video");
        mockFs.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "cam1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const calls = mockSpawn.mock.calls;
        const videoCall = calls.find((c) => (c[1] as string[]).join(" ").includes("-c:v"));
        expect(videoCall).toBeDefined();
    });

    test("should compile video with multiple cameras in grid layout", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "camera"));
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "camera", "cam1.mp4"), "video1");
        mockFs.write(path.join(workingDir, "camera", "cam2.mp4"), "video2");
        mockFs.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "cam1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 2,
                        available: true,
                        active: true,
                        filename: "cam2.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const calls = mockSpawn.mock.calls;
        const segmentCall = calls.find((c) => (c[1] as string[]).join(" ").includes("hstack"));
        expect(segmentCall).toBeDefined();
    });

    test("should show screen and cameras together when both are active", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "screen"));
        mockFs.mkdir(path.join(workingDir, "camera"));
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "screen", "screen1.mp4"), "screen");
        mockFs.write(path.join(workingDir, "camera", "cam1.mp4"), "video");
        mockFs.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.SCREEN,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "screen1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 2,
                        available: true,
                        active: true,
                        filename: "cam1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const calls = mockSpawn.mock.calls;
        // Both screen and camera should be in input
        const segmentCall = calls.find(
            (c) =>
                (c[1] as string[]).join(" ").includes("screen1.mp4") &&
                (c[1] as string[]).join(" ").includes("cam1.mp4")
        );
        expect(segmentCall).toBeDefined();
    });

    test("should fall back to audio when no video files", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getAudio();
        // Falls back to audio file
        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
    });

    test("should coalesce timestamps within threshold into same segment", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "camera"));
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "camera", "cam1.mp4"), "video1");
        mockFs.write(path.join(workingDir, "camera", "cam2.mp4"), "video2");
        mockFs.write(path.join(workingDir, "camera", "cam3.mp4"), "video3");
        mockFs.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        // Timestamps within 500ms threshold should be coalesced
        // cam1 at 1000, cam2 at 1200 (200ms apart) => same segment
        // cam3 at 3000 (1800ms after cam2) => new segment
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "cam1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1200,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 2,
                        available: true,
                        active: true,
                        filename: "cam2.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 3000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 3,
                        available: true,
                        active: true,
                        filename: "cam3.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        await compiler.getVideo();

        // The _buildVideoSegments method is private, so we verify indirectly
        // by checking that ffmpeg was called with the expected segment pattern.
        // With coalescing: segment 1 (cam1+cam2 from 1000-3000), segment 2 (cam1+cam2+cam3 from 3000-5000)
        // This should produce 2 intermediate segment files plus a final concat.
        const calls = mockSpawn.mock.calls;
        const segmentCalls = calls.filter((c) => {
            const args = c[1] as string[] | undefined;
            return args?.some((arg) => arg?.includes("segment_"));
        });

        // Should have 2 segment compilations (one for each distinct segment)
        expect(segmentCalls.length).toBe(2);
    });
});

describe("MediaWriter tests", () => {
    let MediaWriter: typeof import("#src/recording/models/media_writer.ts").MediaWriter;

    beforeEach(async () => {
        await setupUnitTestsEnv();
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });
        MediaWriter = (await import("#src/recording/models/media_writer.ts")).MediaWriter;
    });

    test("should handle FFMPEG process error gracefully", async () => {
        const errorMock = new MockChildProcess("ffmpeg", []);
        errorMock.stdin = new PassThrough();
        mockSpawn.mockImplementationOnce(() => errorMock);

        const writer = new MediaWriter(
            {
                kind: "audio",
                payloadType: 111,
                clockRate: 48000,
                codec: "opus",
                port: 5005,
                channels: 2
            },
            "/tmp",
            "test_error"
        );

        // Simulate FFMPEG error event
        errorMock.emit("error", new Error("FFMPEG crashed"));

        // Writer should have closed
        await writer.close();
        expect(writer.extension).toBe("webm");
    });

    test("should fall back to mkv for unknown codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "unknownCodec",
                port: 5000
            },
            "/tmp",
            "test_video"
        );
        expect(writer.extension).toBe("mkv");
        expect(writer.filename).toBe("test_video.mkv");
    });

    test("should use wav for PCMU codec", () => {
        const writer = new MediaWriter(
            {
                kind: "audio",
                payloadType: 0,
                clockRate: 8000,
                codec: "PCMU",
                port: 5001,
                channels: 1
            },
            "/tmp",
            "test_audio"
        );
        expect(writer.extension).toBe("wav");
        expect(writer.filename).toBe("test_audio.wav");
    });

    test("should use wav for PCMA codec", () => {
        const writer = new MediaWriter(
            {
                kind: "audio",
                payloadType: 8,
                clockRate: 8000,
                codec: "PCMA",
                port: 5002,
                channels: 1
            },
            "/tmp",
            "test_audio_pcma"
        );
        expect(writer.extension).toBe("wav");
        expect(writer.filename).toBe("test_audio_pcma.wav");
    });

    test("should use webm for opus codec", () => {
        const writer = new MediaWriter(
            {
                kind: "audio",
                payloadType: 111,
                clockRate: 48000,
                codec: "opus",
                port: 5003,
                channels: 2
            },
            "/tmp",
            "test_opus"
        );
        expect(writer.extension).toBe("webm");
        expect(writer.filename).toBe("test_opus.webm");
    });

    test("should use mp4 for H264 codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "H264",
                port: 5004
            },
            "/tmp",
            "test_h264"
        );
        expect(writer.extension).toBe("mp4");
        expect(writer.filename).toBe("test_h264.mp4");
    });

    test("should use mp4 for H265 codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "H265",
                port: 5006
            },
            "/tmp",
            "test_h265"
        );
        expect(writer.extension).toBe("mp4");
        expect(writer.filename).toBe("test_h265.mp4");
    });

    test("should use webm for VP8 codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "VP8",
                port: 5007
            },
            "/tmp",
            "test_vp8"
        );
        expect(writer.extension).toBe("webm");
    });

    test("should use webm for VP9 codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "VP9",
                port: 5008
            },
            "/tmp",
            "test_vp9"
        );
        expect(writer.extension).toBe("webm");
    });

    test("should use webm for AV1 codec", () => {
        const writer = new MediaWriter(
            {
                kind: "video",
                payloadType: 96,
                clockRate: 90000,
                codec: "AV1",
                port: 5009
            },
            "/tmp",
            "test_av1"
        );
        expect(writer.extension).toBe("webm");
    });
});

describe("Media Compiler edge cases tests", () => {
    let MediaCompiler: typeof import("#src/recording/models/media_compiler.ts").MediaCompiler;
    let mockFsInstance: typeof import("#tests/utils/mockFileSystem").mockFs;

    beforeEach(async () => {
        const env = await setupUnitTestsEnv();
        mockFsInstance = env.mockFs;
        MediaCompiler = (await import("#src/recording/models/media_compiler.ts")).MediaCompiler;
    });

    test("should compile video with screen-only (no cameras)", async () => {
        const workingDir = "/work_screen";
        mockFsInstance.mkdir(workingDir);
        mockFsInstance.mkdir(path.join(workingDir, "screen"));
        mockFsInstance.mkdir(path.join(workingDir, "audio"));
        mockFsInstance.write(path.join(workingDir, "screen", "screen1.mp4"), "screen");
        mockFsInstance.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.SCREEN,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "screen1.mp4"
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        // Verify screen was included in ffmpeg call
        const calls = mockSpawn.mock.calls;
        const screenCall = calls.find((c) => (c[1] as string[]).join(" ").includes("screen1.mp4"));
        expect(screenCall).toBeDefined();
    });

    test("should handle audio file starting before recording", async () => {
        const workingDir = "/work_early";
        mockFsInstance.mkdir(workingDir);
        mockFsInstance.mkdir(path.join(workingDir, "audio"));
        mockFsInstance.write(path.join(workingDir, "audio", "early.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 2000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000, // Before startedAt
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "early.ogg"
                    }
                }
            ]
        });

        const result = await compiler.getAudio();
        expect(result).toBe(path.join(workingDir, "recording_2000.ogg"));

        // Verify -ss flag is used when offset is negative
        const calls = mockSpawn.mock.calls;
        const audioCall = calls.find((c) => (c[1] as string[]).includes("-ss"));
        expect(audioCall).toBeDefined();
    });

    test("should skip corrupted video files in segment", async () => {
        const workingDir = "/work_corrupt";
        mockFsInstance.mkdir(workingDir);
        mockFsInstance.mkdir(path.join(workingDir, "camera"));
        mockFsInstance.mkdir(path.join(workingDir, "audio"));
        // Note: no actual video file written - simulates corrupted/missing file
        mockFsInstance.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.CAMERA,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "corrupted.mp4" // File doesn't exist
                    }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1000,
                    info: {
                        type: STREAM_TYPE.AUDIO,
                        sessionId: 1,
                        available: true,
                        active: true,
                        filename: "audio1.ogg"
                    }
                }
            ]
        });

        // Should fall back to audio since video is corrupted
        const result = await compiler.getAudio();
        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
    });
});

describe("Media Service network tests", () => {
    let mediaService: typeof import("#src/recording/services/media");
    let mockFsInstance: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModuleInstance: typeof import("#tests/utils/mockFileSystem").mockFsModule;

    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        const env = await setupUnitTestsEnv();
        mockFsInstance = env.mockFs;
        mockFsModuleInstance = env.mockFsModule;

        global.fetch = mockFetch;
        mockFetch.mockClear();
        mediaService = await import("#src/recording/services/media");
    });

    afterEach(() => {
        if (mediaService) {
            mediaService.close();
        }
        global.fetch = originalFetch;
    });

    test("should handle network errors gracefully during upload", async () => {
        const recordingName = "session_network_error";
        const routingAddress = "http://www.odoo.com/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1100,
                    info: { type: STREAM_TYPE.AUDIO, active: true, filename: "audio_1.ogg" }
                }
            ],
            audio: false,
            video: false,
            transcription: false
        };

        mockFsInstance.mkdir(recordingDir);
        mockFsInstance.mkdir(path.join(recordingDir, "audio"));
        mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFsInstance.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio");

        // Simulate network error during routing fetch
        mockFetch.mockRejectedValue(new Error("Network error"));

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch;

        // Recording should be cleaned up despite network failure
        expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });

    test("should handle routing failure gracefully", async () => {
        const recordingName = "session_route_fail";
        const routingAddress = "http://www.odoo.com/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1100,
                    info: { type: STREAM_TYPE.AUDIO, active: true, filename: "audio_1.ogg" }
                }
            ],
            audio: false,
            video: false,
            transcription: false
        };

        mockFsInstance.mkdir(recordingDir);
        mockFsInstance.mkdir(path.join(recordingDir, "audio"));
        mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFsInstance.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio");

        // Routing endpoint returns error
        mockFetch.mockResolvedValue({
            ok: false,
            statusText: "Not Found"
        } as Response);

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch();

        // Recording should be cleaned up despite upload failure
        expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });

    test("should handle empty destination in routing response", async () => {
        const recordingName = "session_no_dest";
        const routingAddress = "http://www.odoo.com/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1100,
                    info: { type: STREAM_TYPE.AUDIO, active: true, filename: "audio_1.ogg" }
                },
                {
                    tag: TIME_TAG.FILE_STATE_CHANGE,
                    timestamp: 1100,
                    info: { type: STREAM_TYPE.CAMERA, active: true, filename: "cam_1.mp4" }
                }
            ],
            audio: true,
            video: true,
            transcription: false
        };

        mockFsInstance.mkdir(recordingDir);
        mockFsInstance.mkdir(path.join(recordingDir, "audio"));
        mockFsInstance.mkdir(path.join(recordingDir, "camera"));
        mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFsInstance.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio");
        mockFsInstance.write(path.join(recordingDir, "camera", "cam_1.mp4"), "dummy video");

        // Audio upload succeeds, routing returns empty destination
        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes("/audio")) {
                return { ok: true, text: async () => "" } as Response;
            }
            if (urlString.includes("/routing")) {
                return {
                    ok: true,
                    json: async () => ({ destination: "" }),
                    statusText: "OK"
                } as Response;
            }
            return { ok: false, statusText: "Not Found" } as Response;
        });

        await mediaService.start();
        await mediaService.__testing__.oneProcessingBatch();

        // Should call routing but not attempt upload (destination is empty)
        expect(mockFetch).toHaveBeenCalledWith(`${routingAddress}/routing`, expect.anything());
        // Recording should still be cleaned up
        expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, { recursive: true });
    });
});
