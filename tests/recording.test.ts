import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { EventEmitter, once } from "node:events";

import { describe, expect, jest, test, beforeEach, afterEach } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { CLIENT_UPDATE } from "#src/client";
import { STOP_CODE, TIME_TAG } from "#src/recording/models/recorder.ts";
import type { Channel } from "#src/core/models/channel.ts";

import { recordingSetup, setupUnitTestsEnv } from "#tests/utils/testHelpers.ts";
import { waitFor, withMockEnv } from "#tests/utils/utils.ts";
import {
    mockFfmpeg,
    mockSpawn,
    ChildProcessLike,
    MockChildProcess
} from "#tests/utils/mockFfmpeg.ts";
import { mockNodeFS } from "#tests/utils/mockFileSystem.ts";

mockNodeFS();
mockFfmpeg();

function makeManualProcess(args: string[] = []) {
    const process = new MockChildProcess("manual", args);
    process.stdin = new PassThrough();
    return process;
}

function fileState(
    type: STREAM_TYPE,
    filename: string,
    timestamp: number,
    {
        active = true,
        available = true,
        sessionId = 1
    }: { active?: boolean; available?: boolean; sessionId?: number } = {}
) {
    return {
        tag: TIME_TAG.FILE_STATE_CHANGE,
        timestamp,
        info: { type, filename, sessionId, active, available }
    };
}

describe("Recording & Transcription", () => {
    test("honors explicit false recording flags", async () => {
        const restore = withMockEnv({
            RECORDING: " FALSE ",
            FFMPEG_LOGGING: "No"
        });
        try {
            const config = await import("#src/config");
            expect(config.recording.enabled).toBe(false);
            expect(config.FFMPEG_LOGGING).toBe(false);
        } finally {
            restore();
        }
    });
    test("serializes overlapping recording transitions", async () => {
        const { restore } = await recordingSetup({ RECORDING: "true" });
        const { Folder, __testing__ } = await import("#src/core/services/resources.ts");
        const { Recorder } = await import("#src/recording/models/recorder.ts");
        const folder = await Folder.create("deferred", ["audio", "camera", "screen"]);
        const folderGate = Promise.withResolvers<typeof folder>();
        const createSpy = jest.spyOn(Folder, "create").mockReturnValueOnce(folderGate.promise);
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

        try {
            const start = recorder.start({ audio: true });
            expect(recorder.state.recording).toBe(true);
            const stop = recorder.stop({ save: false });
            const restart = recorder.start({ audio: true });
            const finalStop = recorder.stop({ save: false });
            folderGate.resolve(folder);
            await Promise.all([start, stop, restart, finalStop]);

            expect(createSpy).toHaveBeenCalledTimes(2);
            expect(recorder.state.recording).toBe(false);
            expect(recorder.path).toBeUndefined();
            expect(__testing__.reservedRecordingBytes).toBe(0);
        } finally {
            folderGate.resolve(folder);
            await recorder.stop({ save: false });
            await folder.delete();
            createSpy.mockRestore();
            await restore();
        }
    });
    test("acknowledges start requests and reports disk failures through channel updates", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);

            mockFs.setAvailableDiskSpace(1);
            const recordingFailureEventPromise = once(user.sfuClient, "update");
            const startResult = await user.sfuClient.startRecording({ audio: true });
            const [recordingFailureEvent] = await recordingFailureEventPromise;

            expect(startResult).toBe(true);
            expect(recordingFailureEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        recording: false,
                        audio: false,
                        transcription: false,
                        video: false
                    },
                    stopCode: STOP_CODE.DISK_SPACE_EXHAUSTED
                }
            });
            expect(user.sfuClient.recordingState.recording).toBe(false);
        } finally {
            mockFs.setAvailableDiskSpace(512 * 1024 * 1024 * 1024);
            await restore();
        }
    });
    test("can record", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        try {
            const channelUUID = await network.getChannelUUID();
            const user1 = await network.connect(channelUUID, 1);
            const user2 = await network.connect(channelUUID, 3);
            expect(user2.sfuClient.availableFeatures.audioRecording).toBe(true);
            const recordingStartEventPromise = once(user1.sfuClient, "update");
            const startResult = await user2.sfuClient.startRecording({ audio: true });
            expect(startResult).toBe(true);
            const [recordingStartEvent] = await recordingStartEventPromise;
            expect(recordingStartEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        recording: true,
                        audio: true,
                        transcription: false,
                        video: false
                    }
                }
            });
            await waitFor(() => user2.sfuClient.recordingState.recording);
            const transcriptionEventPromise = once(user1.sfuClient, "update");
            const transcriptionResult = await user2.sfuClient.startRecording({
                transcription: true
            });
            const [transcriptionEvent] = await transcriptionEventPromise;
            expect(transcriptionResult).toBe(true);
            expect(transcriptionEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        recording: true,
                        audio: true,
                        transcription: true,
                        video: false
                    }
                }
            });
            await waitFor(() => user2.sfuClient.recordingState.transcription);
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
        } finally {
            await restore();
        }
    });
    test("waits for recorder finalization before channel cleanup resolves", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const config = await import("#src/config");
        const { Channel } = await import("#src/core/models/channel");
        const { mockFs, mockFsModule } = await import("#tests/utils/mockFileSystem.ts");
        const originalRename = mockFsModule.rename.getMockImplementation();
        if (!originalRename) {
            throw new Error("rename mock has no implementation");
        }
        const renameGate = Promise.withResolvers<void>();
        let now = 1_000_000;
        const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
        mockFsModule.rename.mockImplementation(async (oldPath: string, newPath: string) => {
            await renameGate.promise;
            return originalRename(oldPath, newPath);
        });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);

            expect(await user.sfuClient.startRecording({ audio: true })).toBe(true);
            const channel = Channel.records.get(channelUUID);
            expect(channel?.recorder?.path).toBeDefined();

            const resourcePath = channel!.recorder!.path!;
            const recordingName = path.basename(resourcePath).replace(/-\d+$/, "");
            const recordingPath = path.join(config.dir.recordings, recordingName);
            now += config.recording.minDuration + 1;
            const closePromise = Channel.closeAll();

            await Promise.resolve();
            expect(mockFs.exists(recordingPath)).toBe(false);

            renameGate.resolve();
            await closePromise;

            expect(mockFs.exists(recordingPath)).toBe(true);
            expect(mockFs.exists(path.join(recordingPath, config.recording.metadataFileName))).toBe(
                true
            );
            const auth = await import("#src/core/services/auth.ts");
            const metadata = JSON.parse(
                auth.decrypt(
                    await mockFs.readFile(
                        path.join(recordingPath, config.recording.metadataFileName)
                    )
                )
            );
            expect(metadata.channelName).toBe(channel!.name);
            expect(metadata.channelUUID).toBe(channel!.uuid);
            const jwt = auth.sign(
                { sub: "recording", exp: Math.floor(Date.now() / 1000) + 60 },
                metadata.channelKey
            );
            expect(auth.verify(jwt, channel!.key).sub).toBe("recording");
            expect(mockFs.exists(resourcePath)).toBe(false);
        } finally {
            renameGate.resolve();
            dateNowSpy.mockRestore();
            mockFsModule.rename.mockImplementation(originalRename);
            await restore();
        }
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
            await user.sfuClient.startRecording({ audio: true, video: true });

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.CAMERA, videoTrack);

            await waitFor(() => mockSpawn.mock.calls.length >= 2);

            expect(mockSpawn).toHaveBeenCalledTimes(2);

            const results = mockSpawn.mock.results as Array<{
                value: ChildProcessLike;
            }>;
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
            await restore();
        }
    });

    test("Does not spawn FFMPEG for paused producers when recording starts", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation(() => new MockChildProcess("ffmpeg", []));

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, videoTrack);
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, null);

            await user.sfuClient.startRecording({ audio: true, video: true });

            await waitFor(() =>
                mockSpawn.mock.calls.some((c) => (c[1] as string[]).includes("-c:a"))
            );

            expect(mockSpawn).toHaveBeenCalledTimes(1);
            const args = mockSpawn.mock.calls[0][1];
            expect(args.join(" ")).toContain("-c:a");
            expect(args.join(" ")).not.toContain("-c:v");

            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, videoTrack);

            await waitFor(() => mockSpawn.mock.calls.length >= 2);

            expect(mockSpawn).toHaveBeenCalledTimes(2);
            const calls = mockSpawn.mock.calls;
            const secondCallArgs = calls[1][1];
            expect(secondCallArgs.join(" ")).toContain("-c:v");
        } finally {
            await restore();
        }
    });
    test("Records streams from users who join mid-recording", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user1 = await network.connect(channelUUID, 1);

            await user1.sfuClient.startRecording({ audio: true });
            await waitFor(() => user1.sfuClient.recordingState.recording);

            const user2 = await network.connect(channelUUID, 2);

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user2.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const hasAudioWriter = () =>
                mockSpawn.mock.calls.some((c) => (c[1] as string[]).includes("-c:a"));
            await waitFor(hasAudioWriter);
            expect(hasAudioWriter()).toBe(true);
        } finally {
            await restore();
        }
    });

    test("keeps the latest writer after overlapping initial stream uploads", async () => {
        let activeWriters = 0;
        const replacements = Promise.withResolvers<void>();
        const firstWriterClose = Promise.withResolvers<void>();
        let writerCount = 0;
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            if (args?.includes("pipe:0")) {
                activeWriters++;
                mp.once("close", () => {
                    activeWriters--;
                });
                if (!writerCount++) {
                    mp.kill = (signal) => {
                        mp.killed = true;
                        void firstWriterClose.promise.then(() => mp.emit("close", null, signal));
                        return true;
                    };
                }
            }
            return mp;
        });

        const { restore, network, getChannel } = await recordingSetup({ RECORDING: "true" });
        const uploads: Promise<void>[] = [];

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            const recorder = getChannel(channelUUID)!.recorder!;
            const mark = jest.spyOn(recorder, "mark");
            // @ts-expect-error controlling concurrent client producer submission
            const transport = user.sfuClient._ctsTransport!;
            const produce = transport.produce.bind(transport);
            let producerCount = 0;
            jest.spyOn(transport, "produce").mockImplementation(async (options) => {
                if (producerCount++) {
                    await replacements.promise;
                }
                return produce(options);
            });

            await user.sfuClient.startRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.recording);

            uploads.push(
                user.sfuClient.updateUpload(
                    STREAM_TYPE.AUDIO,
                    new FakeMediaStreamTrack({ kind: "audio" })
                ),
                user.sfuClient.updateUpload(
                    STREAM_TYPE.AUDIO,
                    new FakeMediaStreamTrack({ kind: "audio" })
                ),
                user.sfuClient.updateUpload(
                    STREAM_TYPE.AUDIO,
                    new FakeMediaStreamTrack({ kind: "audio" })
                )
            );
            await waitFor(() => activeWriters === 1);
            replacements.resolve();
            await Promise.all(uploads);
            firstWriterClose.resolve();
            await waitFor(
                () =>
                    activeWriters === 1 &&
                    mark.mock.calls.filter(
                        ([tag, info]) =>
                            tag === TIME_TAG.FILE_STATE_CHANGE &&
                            info.type === STREAM_TYPE.AUDIO &&
                            info.eof
                    ).length >= 2
            );
            expect(activeWriters).toBe(1);
            await recorder.stop({ save: false });
        } finally {
            replacements.resolve();
            firstWriterClose.resolve();
            await Promise.allSettled(uploads);
            await restore();
        }
    });

    test("reports recording_failed when FFMPEG cannot be spawned", async () => {
        mockSpawn.mockClear();
        let ffmpegProcess: MockChildProcess | undefined;
        mockSpawn.mockImplementation((_cmd, args) => {
            ffmpegProcess = makeManualProcess(args as string[]);
            return ffmpegProcess;
        });

        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });

        try {
            const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);

            await user.sfuClient.startRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.recording);

            const channel = getChannel(channelUUID)!;
            const recorder = channel.recorder!;
            const resourcePath = recorder.path;
            const failureEventPromise = once(user.sfuClient, "update");

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);
            await waitFor(() => Boolean(ffmpegProcess));

            const spawnError = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
            spawnError.code = "ENOENT";
            ffmpegProcess!.emit("error", spawnError);

            const [failureEvent] = await failureEventPromise;
            expect(failureEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        recording: false,
                        audio: false,
                        transcription: false,
                        video: false
                    },
                    stopCode: STOP_CODE.RECORDING_FAILED
                }
            });
            await waitFor(() => Boolean(resourcePath && !mockFs.exists(resourcePath)));
            expect(ffmpegProcess!.killed).toBe(true);
            expect(recorder.state.recording).toBe(false);
        } finally {
            await restore();
        }
    });

    test("fails when a recording sink cannot initialize", async () => {
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.sfuClient.startRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.recording);

            const recorder = getChannel(channelUUID)!.recorder!;
            const resourcePath = recorder.path!;
            const router = getChannel(channelUUID)!.router!;
            const createTransportSpy = jest
                .spyOn(router, "createPlainTransport")
                .mockRejectedValueOnce(new Error("plain transport failure"));
            let stopCode: STOP_CODE | undefined;
            recorder.on("update", (update: { stopCode?: STOP_CODE }) => {
                stopCode = update.stopCode ?? stopCode;
            });

            try {
                await user.sfuClient.updateUpload(
                    STREAM_TYPE.AUDIO,
                    new FakeMediaStreamTrack({ kind: "audio" })
                );
                await waitFor(() => stopCode === STOP_CODE.RECORDING_FAILED);
                const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
                expect(recorder.state.recording).toBe(false);
                expect(mockFs.exists(resourcePath)).toBe(false);
            } finally {
                createTransportSpy.mockRestore();
            }
        } finally {
            await restore();
        }
    });

    test("fails recording when session replacement cannot close its writer", async () => {
        mockSpawn.mockClear();
        const closeRequested = Promise.withResolvers<void>();
        let process: MockChildProcess | undefined;
        mockSpawn.mockImplementation((_cmd, args) => {
            process = makeManualProcess(args as string[]);
            process.kill = (signal?: NodeJS.Signals | number) => {
                if (signal === "SIGINT") {
                    closeRequested.resolve();
                } else if (signal === "SIGKILL") {
                    process!.killed = true;
                    process!.emit("close", null, signal);
                }
                return true;
            };
            return process;
        });
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.sfuClient.startRecording({ audio: true });
            await user.sfuClient.updateUpload(
                STREAM_TYPE.AUDIO,
                new FakeMediaStreamTrack({ kind: "audio" })
            );
            await waitFor(() => Boolean(process));

            const recorder = getChannel(channelUUID)!.recorder!;
            let stopCode: STOP_CODE | undefined;
            recorder.on("update", (update: { stopCode?: STOP_CODE }) => {
                stopCode = update.stopCode ?? stopCode;
            });
            jest.useFakeTimers();
            getChannel(channelUUID)!.join(user.session.id);
            await closeRequested.promise;
            await jest.advanceTimersByTimeAsync(30_001);
            jest.useRealTimers();
            await waitFor(() => stopCode === STOP_CODE.RECORDING_FAILED);

            expect(process!.killed).toBe(true);
            expect(recorder.state.recording).toBe(false);
        } finally {
            jest.useRealTimers();
            await restore();
        }
    });

    test("waits for sibling writers before discarding a failed recording", async () => {
        mockSpawn.mockClear();
        const killSignals: Array<NodeJS.Signals | number | undefined> = [];
        const cameraClose = Promise.withResolvers<void>();
        let audioProcess: MockChildProcess | undefined;
        let cameraProcess: MockChildProcess | undefined;
        mockSpawn.mockImplementation((_cmd, args) => {
            const process = makeManualProcess(args as string[]);
            if (!(args as string[]).some((arg) => arg.includes("/audio/"))) {
                process.kill = () => {
                    void cameraClose.promise.then(() => process.emit("close", 0));
                    return true;
                };
                cameraProcess = process;
                return process;
            }
            process.kill = (signal?: NodeJS.Signals | number) => {
                killSignals.push(signal);
                if (signal === "SIGKILL") {
                    process.killed = true;
                    process.emit("close", null, signal);
                }
                return true;
            };
            audioProcess = process;
            return process;
        });

        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });

        try {
            const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);

            await user.sfuClient.startRecording({ audio: true, video: true });
            await waitFor(() => user.sfuClient.recordingState.recording);

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);
            const cameraTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.CAMERA, cameraTrack);
            await waitFor(() => Boolean(audioProcess && cameraProcess));

            const recorder = getChannel(channelUUID)!.recorder!;
            const resourcePath = recorder.path;
            const failureUpdatePromise = new Promise<void>((resolve) => {
                const listener = (update: { stopCode?: STOP_CODE }) => {
                    if (update.stopCode === STOP_CODE.RECORDING_FAILED) {
                        recorder.off("update", listener);
                        resolve();
                    }
                };
                recorder.on("update", listener);
            });

            jest.useFakeTimers();
            const stopPromise = recorder.stop();
            await jest.advanceTimersByTimeAsync(30_001);
            expect(resourcePath).toBeDefined();
            expect(mockFs.exists(resourcePath!)).toBe(true);
            cameraClose.resolve();
            await stopPromise;
            await failureUpdatePromise;

            expect(killSignals).toEqual(["SIGINT", "SIGKILL"]);
            expect(mockFs.exists(resourcePath!)).toBe(false);
        } finally {
            cameraClose.resolve();
            jest.useRealTimers();
            await restore();
        }
    });

    test("starts a gated camera after replacing the screen session", async () => {
        mockSpawn.mockClear();
        mockSpawn.mockImplementation((_cmd, args) => {
            const mp = new MockChildProcess("ffmpeg", args || []);
            mp.stdin = new PassThrough();
            return mp;
        });

        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });
        const hasPath = (args: readonly string[] | undefined, folder: "screen" | "camera") =>
            Boolean(args?.some((arg) => arg.includes(`/${folder}/`)));

        try {
            const channelUUID = await network.getChannelUUID();
            const screenUser = await network.connect(channelUUID, 1);
            const cameraUser = await network.connect(channelUUID, 2);

            const screenTrack = new FakeMediaStreamTrack({ kind: "video" });
            const cameraTrack = new FakeMediaStreamTrack({ kind: "video" });
            await screenUser.sfuClient.updateUpload(STREAM_TYPE.SCREEN, screenTrack);
            await cameraUser.sfuClient.updateUpload(STREAM_TYPE.CAMERA, cameraTrack);
            const channel = getChannel(channelUUID)!;
            const markSpy = jest.spyOn(channel.recorder!, "mark");
            try {
                await screenUser.sfuClient.startRecording({ video: true });
                await waitFor(() =>
                    mockSpawn.mock.calls.some((call) =>
                        hasPath(call[1] as readonly string[] | undefined, "screen")
                    )
                );
                await waitFor(() =>
                    markSpy.mock.calls.some(
                        ([, info]) => info.type === STREAM_TYPE.CAMERA && info.available
                    )
                );
                expect(
                    mockSpawn.mock.calls.some((call) =>
                        hasPath(call[1] as readonly string[] | undefined, "camera")
                    )
                ).toBe(false);

                channel.join(screenUser.session.id);
                await waitFor(() =>
                    mockSpawn.mock.calls.some((call) =>
                        hasPath(call[1] as readonly string[] | undefined, "camera")
                    )
                );
            } finally {
                markSpy.mockRestore();
            }
        } finally {
            await restore();
        }
    });
});

describe("Scheduler Service", () => {
    let mediaService: typeof import("#src/recording/services/scheduler");
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModule: typeof import("#tests/utils/mockFileSystem").mockFsModule;
    let loadAverage: jest.SpiedFunction<typeof os.loadavg>;

    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        loadAverage = jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
        const env = await setupUnitTestsEnv();
        mockFs = env.mockFs;
        mockFsModule = env.mockFsModule;

        global.fetch = mockFetch;

        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => "",
            statusText: "OK"
        } as Response);

        mediaService = await import("#src/recording/services/scheduler");
    });

    afterEach(async () => {
        if (mediaService) {
            await mediaService.close();
        }
        loadAverage.mockRestore();
        global.fetch = originalFetch;
    });

    test("should process a valid recording", async () => {
        const recordingName = "session_123";
        const routingAddress = "http://www.oodo.test/routin";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100),
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 4000, { active: false })
            ],
            audio: true,
            video: false,
            transcription: false
        };
        const uploadDestination = "http://upload.local/video";

        mockFs.mkdir(recordingDir);
        mockFs.mkdir(path.join(recordingDir, "audio"));
        mockFs.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFs.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio content");
        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes("/routing")) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ destination: uploadDestination }),
                    statusText: "OK"
                } as Response;
            }
            if (urlString === uploadDestination) {
                return { ok: true, text: async () => "" } as Response;
            }
            return {
                ok: false,
                statusText: "Not Found",
                text: async () => ""
            } as Response;
        });

        await mediaService.start();
        expect(mockFs.exists(recordingDir)).toBe(false);

        expect(mockSpawn).toHaveBeenCalledWith(
            "ffmpeg",
            expect.arrayContaining([expect.stringContaining("recording_1000.partial.ogg")]),
            expect.objectContaining({ stdio: "ignore" })
        );
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
    });

    test("retries transient metadata read failures", async () => {
        const recordingName = "retry_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            routingAddress: "http://routing.local",
            channelKey: "key",
            startedAt: 1000,
            stoppedAt: Date.now() - 1000,
            timeStamps: [],
            audio: false,
            video: false,
            transcription: false
        };
        mockFs.mkdir(recordingDir);
        mockFs.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        const readError = Object.assign(new Error("temporary read failure"), {
            code: "EIO"
        });
        mockFsModule.readFile.mockRejectedValueOnce(readError);

        await mediaService.start();

        expect(mockFs.exists(recordingDir)).toBe(true);
        await mediaService.__testing__.oneProcessingBatch();
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
    });

    test("should handle expired recordings", async () => {
        const recordingName = "expired_session";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const freshRecordingDir = "/mock/recordings/fresh_session";
        const metadata = {
            routingAddress: "http://routing.local",
            channelKey: "key",
            startedAt: 1000,
            stoppedAt: Date.now() - 1000 * 60 * 60 * 24 - 1000,
            timeStamps: [],
            audio: false,
            video: false,
            transcription: false
        };

        mockFs.mkdir(recordingDir);
        mockFs.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFs.mkdir(freshRecordingDir);
        mockFs.write(
            path.join(freshRecordingDir, "metadata.bin"),
            JSON.stringify({
                ...metadata,
                startedAt: Date.now() - 2000,
                stoppedAt: Date.now() - 1000
            })
        );

        loadAverage.mockReturnValue([os.cpus().length, 0, 0]);
        await mediaService.start();
        expect(loadAverage).toHaveBeenCalled();

        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(mockFs.exists(freshRecordingDir)).toBe(true);
    });
});

describe("MediaCompiler tests", () => {
    let MediaCompiler: typeof import("#src/recording/models/media_compiler.ts").MediaCompiler;
    let mockFs: typeof import("#tests/utils/mockFileSystem").mockFs;
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
                fileState(STREAM_TYPE.AUDIO, "file1.ogg", 1000),
                fileState(STREAM_TYPE.AUDIO, "file2.ogg", 2000)
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
                path.join(workingDir, "audio", "file2.ogg"),
                "-c:a",
                "libopus"
            ]),
            expect.objectContaining({ stdio: "ignore" })
        );
        expect(mockSpawn).toHaveBeenCalledWith(
            "ffprobe",
            expect.arrayContaining(["-read_intervals", "%+5"]),
            expect.anything()
        );
        const ffmpegArgs = mockSpawn.mock.calls.find(([command]) => command === "ffmpeg")![1];
        expect((ffmpegArgs as string[]).filter((arg) => arg === "+discardcorrupt")).toHaveLength(2);
    });

    test("retries when ffprobe is terminated", async () => {
        const workingDir = "/probe-timeout";
        mockFs.mkdir(path.join(workingDir, "audio"), { recursive: true });
        mockFs.write(path.join(workingDir, "audio", "file.ogg"), "data");
        const spawn = mockSpawn.getMockImplementation()!;
        mockSpawn.mockImplementation((command, args, options) => {
            if (command !== "ffprobe") {
                return spawn(command, args, options);
            }
            const process = makeManualProcess(args as string[]);
            setTimeout(() => process.emit("close", null, "SIGKILL"));
            return process;
        });
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [fileState(STREAM_TYPE.AUDIO, "file.ogg", 1000)]
        });

        try {
            await expect(compiler.getAudio()).rejects.toThrow("signal SIGKILL");
        } finally {
            mockSpawn.mockImplementation(spawn);
        }
    });

    test("retries after ffmpeg leaves a partial output", async () => {
        const workingDir = "/work";
        mockFs.mkdir(workingDir);
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "audio", "file1.ogg"), "data");
        const options = {
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [fileState(STREAM_TYPE.AUDIO, "file1.ogg", 1000, { sessionId: 3 })]
        };
        const spawn = mockSpawn.getMockImplementation()!;
        let shouldFail = true;
        mockSpawn.mockImplementation((command, args, options) => {
            if (command !== "ffmpeg" || !shouldFail) {
                return spawn(command, args, options);
            }
            shouldFail = false;
            const process = makeManualProcess(args as string[]);
            setTimeout(() => {
                mockFs.write((args as string[]).at(-1)!, "partial");
                process.emit("close", 1);
            });
            return process;
        });

        await expect(new MediaCompiler(options).getAudio()).rejects.toThrow();
        const result = await new MediaCompiler(options).getAudio();
        expect(result).toBe(path.join(workingDir, "recording_1000.ogg"));
        expect(mockSpawn.mock.calls.filter(([command]) => command === "ffmpeg")).toHaveLength(2);
    });

    test("aborts compilation as one bounded job", async () => {
        const controller = new AbortController();
        const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
        const spawn = mockSpawn.getMockImplementation()!;
        mockSpawn.mockImplementation((command, args, options) => {
            const process = makeManualProcess(args as string[]);
            const signal = (options as { signal?: AbortSignal }).signal;
            signal?.addEventListener(
                "abort",
                () => {
                    process.emit("error", signal.reason);
                    process.emit("close", null, "SIGKILL");
                },
                { once: true }
            );
            return process;
        });
        const workingDir = "/bounded";
        mockFs.mkdir(path.join(workingDir, "audio"), { recursive: true });
        mockFs.write(path.join(workingDir, "audio", "file.ogg"), "data");
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [fileState(STREAM_TYPE.AUDIO, "file.ogg", 1000)]
        });

        try {
            const compilation = compiler.getAudio();
            controller.abort(new Error("compilation deadline"));
            await expect(compilation).rejects.toThrow("compilation deadline");
            expect(timeoutSpy).toHaveBeenCalledTimes(1);
        } finally {
            timeoutSpy.mockRestore();
            mockSpawn.mockImplementation(spawn);
        }
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
                fileState(STREAM_TYPE.CAMERA, "cam1.mp4", 1000),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const videoCall = mockSpawn.mock.calls.find(
            ([command, args]) =>
                command === "ffmpeg" &&
                (args as string[]).includes(path.join(workingDir, "camera", "cam1.mp4"))
        );
        expect(videoCall).toBeDefined();
    });

    test("preserves delayed-video gaps and cleans failed assembly", async () => {
        const workingDir = "/work";
        mockFs.mkdir(path.join(workingDir, "camera"), { recursive: true });
        mockFs.mkdir(path.join(workingDir, "audio"));
        mockFs.write(path.join(workingDir, "camera", "cam1.mp4"), "video");
        mockFs.write(path.join(workingDir, "audio", "audio.ogg"), "audio");
        const spawn = mockSpawn.getMockImplementation()!;
        mockSpawn.mockImplementation((command, args, options) => {
            if (command !== "ffmpeg" || !(args as string[]).at(-1)?.endsWith(".partial.ogg")) {
                return spawn(command, args, options);
            }
            const process = makeManualProcess(args as string[]);
            setTimeout(() => process.emit("close", 1));
            return process;
        });
        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 3000,
            timeStamps: [
                fileState(STREAM_TYPE.CAMERA, "cam1.mp4", 2000),
                fileState(STREAM_TYPE.AUDIO, "audio.ogg", 1000)
            ]
        });

        await expect(compiler.getVideo()).rejects.toThrow();
        const segmentCalls = mockSpawn.mock.calls.filter(([, args]) =>
            (args as string[]).at(-1)?.includes("segment_")
        );
        expect(segmentCalls).toHaveLength(2);
        expect(segmentCalls[0][1]).toEqual(expect.arrayContaining(["-f", "lavfi", "-t", "1.000"]));
        expect(mockFs.exists(path.join(workingDir, "segment_0.mp4"))).toBe(false);
        expect(mockFs.exists(path.join(workingDir, "segment_1.mp4"))).toBe(false);
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
                fileState(STREAM_TYPE.CAMERA, "cam1.mp4", 1000),
                fileState(STREAM_TYPE.CAMERA, "cam2.mp4", 1000, { sessionId: 2 }),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
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
                fileState(STREAM_TYPE.SCREEN, "screen1.mp4", 1000),
                fileState(STREAM_TYPE.CAMERA, "cam1.mp4", 1000, { sessionId: 2 }),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const calls = mockSpawn.mock.calls;
        const segmentCall = calls.find(
            (c) =>
                (c[1] as string[]).join(" ").includes("screen1.mp4") &&
                (c[1] as string[]).join(" ").includes("cam1.mp4")
        );
        expect(segmentCall).toBeDefined();
        expect(
            ((segmentCall![1] as string[]) ?? []).filter((arg) => arg === "+discardcorrupt")
        ).toHaveLength(2);
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

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                fileState(STREAM_TYPE.CAMERA, "cam1.mp4", 1000),
                fileState(STREAM_TYPE.CAMERA, "cam2.mp4", 1200, { sessionId: 2 }),
                fileState(STREAM_TYPE.CAMERA, "cam3.mp4", 3000, { sessionId: 3 }),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
            ]
        });

        await compiler.getVideo();

        const calls = mockSpawn.mock.calls;
        const segmentCalls = calls.filter((c) => {
            const args = c[1] as string[] | undefined;
            return args?.some((arg) => arg?.includes("segment_"));
        });

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

    test("reports an unexpected clean ffmpeg exit", async () => {
        const process = makeManualProcess();
        mockSpawn.mockImplementationOnce(() => process);
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
            "test_exit"
        );
        const failure = once(writer, "failure");

        process.emit("close", 0);

        expect((await failure)[0].error).toEqual(
            new Error("FFMPEG test_exit.webm exited with code 0")
        );
        await writer.close();
    });

    test("waits for process closure after an error", async () => {
        const process = makeManualProcess();
        process.kill = () => true;
        mockSpawn.mockImplementationOnce(() => process);
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
        let settled = false;
        let closeError: unknown;
        const closePromise = writer
            .close()
            .catch((error) => {
                closeError = error;
            })
            .finally(() => {
                settled = true;
            });

        process.emit("error", new Error("signal failure"));
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);

        process.emit("close", null, "SIGINT");
        await closePromise;
        expect(closeError).toBeUndefined();
    });

    test("bounds close when a process survives force killing", async () => {
        jest.useFakeTimers();
        const process = makeManualProcess();
        process.kill = () => true;
        mockSpawn.mockImplementationOnce(() => process);
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
            "test_survivor"
        );

        try {
            const processClose = once(writer, MediaWriter.Events.PROCESS_CLOSE);
            const close = writer.close().catch((error) => error);
            await jest.advanceTimersByTimeAsync(60_001);
            expect(await close).toEqual(
                new Error("FFMPEG test_survivor.webm remained alive after force killing")
            );
            expect(writer.isProcessClosed).toBe(false);
            process.emit("close", null, "SIGKILL");
            await processClose;
            expect(writer.isProcessClosed).toBe(true);
        } finally {
            jest.useRealTimers();
        }
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
                fileState(STREAM_TYPE.SCREEN, "screen1.mp4", 1000),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
            ]
        });

        const result = await compiler.getVideo();
        expect(result).toBe(path.join(workingDir, "recording_1000.mp4"));

        const screenCall = mockSpawn.mock.calls.find(
            ([command, args]) =>
                command === "ffmpeg" &&
                (args as string[]).includes(path.join(workingDir, "screen", "screen1.mp4"))
        );
        expect(screenCall).toBeDefined();
    });

    test("should skip corrupted video files in segment", async () => {
        const workingDir = "/work_corrupt";
        mockFsInstance.mkdir(workingDir);
        mockFsInstance.mkdir(path.join(workingDir, "camera"));
        mockFsInstance.mkdir(path.join(workingDir, "audio"));
        mockFsInstance.write(path.join(workingDir, "camera", "corrupted.mp4"), "not a video");
        mockFsInstance.write(path.join(workingDir, "audio", "audio1.ogg"), "audio");
        mockSpawn.mockImplementation((command, args) => {
            const process = makeManualProcess(args as string[]);
            if (command === "ffprobe") {
                setTimeout(() => {
                    if ((args as string[]).at(-1)?.endsWith("corrupted.mp4")) {
                        process.emit("close", 1);
                    } else {
                        process.stdout?.push("opus\n");
                        process.emit("close", 0);
                    }
                }, 5);
            } else {
                setTimeout(() => {
                    mockFsInstance.write((args as string[]).at(-1)!, "output");
                    process.emit("close", 0);
                }, 5);
            }
            return process;
        });

        const compiler = new MediaCompiler({
            workingDir,
            startedAt: 1000,
            stoppedAt: 5000,
            timeStamps: [
                fileState(STREAM_TYPE.CAMERA, "corrupted.mp4", 1000),
                fileState(STREAM_TYPE.AUDIO, "audio1.ogg", 1000)
            ]
        });

        const videoResult = await compiler.getVideo();
        expect(videoResult).toBeUndefined();

        const audioResult = await compiler.getAudio();
        expect(audioResult).toBe(path.join(workingDir, "recording_1000.ogg"));
    });
});

describe("Scheduler Service network tests", () => {
    let mediaService: typeof import("#src/recording/services/scheduler");
    let mockFsInstance: typeof import("#tests/utils/mockFileSystem").mockFs;
    let mockFsModuleInstance: typeof import("#tests/utils/mockFileSystem").mockFsModule;
    let loadAverage: jest.SpiedFunction<typeof os.loadavg>;

    const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    const originalFetch = global.fetch;

    beforeEach(async () => {
        loadAverage = jest.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
        const env = await setupUnitTestsEnv();
        mockFsInstance = env.mockFs;
        mockFsModuleInstance = env.mockFsModule;

        global.fetch = mockFetch;
        mockFetch.mockClear();
        mediaService = await import("#src/recording/services/scheduler");
    });

    afterEach(async () => {
        if (mediaService) {
            await mediaService.close();
        }
        loadAverage.mockRestore();
        global.fetch = originalFetch;
    });

    test("cancels an unused upload response", async () => {
        const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
        const filePath = "/mock/audio.ogg";
        mockFsInstance.write(filePath, "audio");
        const routingResponse = new Response(
            JSON.stringify({ destination: "http://upload.local" })
        );
        const uploadResponse = new Response("ignored");
        const textSpy = jest.spyOn(uploadResponse, "text");
        const cancelSpy = jest.spyOn(uploadResponse.body!, "cancel");
        mockFetch.mockResolvedValueOnce(routingResponse).mockResolvedValueOnce(uploadResponse);
        const uploader = new MediaUploader({
            routingTimeoutMs: 10,
            uploadTimeoutMs: 10
        });

        await uploader.uploadMedia({
            filePath,
            mimetype: "audio/ogg",
            metadata: {
                channelName: "channel",
                channelUUID: "uuid",
                routingAddress: "http://routing.local",
                channelKey: "key",
                labels: {},
                startedAt: 1000,
                stoppedAt: 2000,
                timeStamps: [],
                audio: true,
                video: false,
                transcription: false
            }
        });

        expect(mockFetch).toHaveBeenNthCalledWith(
            1,
            "http://routing.local/routing?start_ms=1000&end_ms=2000&mimetype=audio%2Fogg",
            expect.objectContaining({ method: "GET" })
        );
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(textSpy).not.toHaveBeenCalled();
    });

    test("uses the Odoo transcription route", async () => {
        const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
        const filePath = "/mock/audio.ogg";
        mockFsInstance.write(filePath, "audio");
        mockFetch.mockResolvedValue(new Response());
        const uploader = new MediaUploader({
            routingTimeoutMs: 10,
            uploadTimeoutMs: 10
        });

        await uploader.transcribe({
            filePath,
            metadata: {
                channelName: "channel",
                channelUUID: "uuid",
                routingAddress: "http://routing.local",
                channelKey: "key",
                labels: {},
                startedAt: 1000,
                stoppedAt: 2000,
                timeStamps: [],
                audio: false,
                video: false,
                transcription: true
            }
        });

        expect(mockFetch).toHaveBeenCalledWith(
            "http://routing.local/transcribe?start_ms=1000&end_ms=2000",
            expect.objectContaining({ method: "POST" })
        );
    });

    test("rejects an oversized routing response", async () => {
        const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
        const filePath = "/mock/video.mp4";
        mockFsInstance.write(filePath, "video");
        mockFetch.mockResolvedValue(new Response("x".repeat(64 * 1024 + 1)));
        const uploader = new MediaUploader({
            routingTimeoutMs: 1000,
            uploadTimeoutMs: 1000
        });

        await expect(
            uploader.uploadMedia({
                filePath,
                mimetype: "video/mp4",
                metadata: {
                    channelName: "channel",
                    channelUUID: "uuid",
                    routingAddress: "http://routing.local",
                    channelKey: "key",
                    labels: {},
                    startedAt: 1000,
                    stoppedAt: 2000,
                    timeStamps: [],
                    audio: false,
                    video: true,
                    transcription: false
                }
            })
        ).rejects.toThrow("Routing response exceeds");
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("keeps recording when its upload fails", async () => {
        const recordingName = "session_route_fail";
        const routingAddress = "http://www.oodo.test/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100),
                fileState(STREAM_TYPE.CAMERA, "cam_1.mp4", 1100)
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

        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            if (url.toString().includes("/routing?")) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ destination: "http://upload.local" })
                } as Response;
            }
            return {
                ok: false,
                status: 503,
                statusText: "Unavailable",
                text: async () => ""
            } as Response;
        });

        await mediaService.start();

        expect(
            mockFetch.mock.calls.filter(([url]) => url.toString() === "http://upload.local")
        ).toHaveLength(1);
        expect(
            mockFetch.mock.calls.filter(([url]) => url.toString().includes("/routing?"))
        ).toHaveLength(1);
        expect(mockFsModuleInstance.rm).not.toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
        expect(mockFsInstance.exists(recordingDir)).toBe(true);
    });

    test("keeps recording when routing returns no destination", async () => {
        const recordingName = "session_no_dest";
        const routingAddress = "http://www.oodo.test/routing";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100),
                fileState(STREAM_TYPE.CAMERA, "cam_1.mp4", 1100)
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

        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes("/audio")) {
                return { ok: true, text: async () => "" } as Response;
            }
            if (urlString.includes("/routing")) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ destination: "" }),
                    statusText: "OK"
                } as Response;
            }
            return {
                ok: false,
                statusText: "Not Found",
                text: async () => ""
            } as Response;
        });

        await mediaService.start();

        const queryParams = `?start_ms=${metadata.startedAt}&end_ms=${metadata.stoppedAt}&mimetype=video%2Fmp4`;
        expect(mockFetch).toHaveBeenCalledWith(
            `${routingAddress}/routing${queryParams}`,
            expect.anything()
        );
        expect(mockFsModuleInstance.rm).not.toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
        expect(mockFsInstance.exists(recordingDir)).toBe(true);
    });

    test("uploads only the requested video artifact", async () => {
        const recordingName = "session_video_mime";
        const routingAddress = "http://www.oodo.test/routing";
        const uploadDestination = "http://upload.local/video";
        const recordingDir = `/mock/recordings/${recordingName}`;
        const metadata = {
            channelName: "Test Channel",
            routingAddress,
            channelKey: "key123",
            stoppedAt: Date.now() - 1000,
            startedAt: 1000,
            timeStamps: [
                fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100),
                fileState(STREAM_TYPE.CAMERA, "cam_1.mp4", 1100)
            ],
            audio: false,
            video: true,
            transcription: false
        };

        mockFsInstance.mkdir(recordingDir);
        mockFsInstance.mkdir(path.join(recordingDir, "audio"));
        mockFsInstance.mkdir(path.join(recordingDir, "camera"));
        mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
        mockFsInstance.write(path.join(recordingDir, "audio", "audio_1.ogg"), "dummy audio");
        mockFsInstance.write(path.join(recordingDir, "camera", "cam_1.mp4"), "dummy video");

        mockFetch.mockImplementation(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes("/routing")) {
                return {
                    ok: true,
                    text: async () => JSON.stringify({ destination: uploadDestination }),
                    statusText: "OK"
                } as Response;
            }
            if (urlString === uploadDestination) {
                return { ok: true, text: async () => "" } as Response;
            }
            return {
                ok: false,
                statusText: "Not Found",
                text: async () => ""
            } as Response;
        });

        await mediaService.start();

        expect(mockFetch.mock.calls.some(([url]) => url.toString().includes("/audio"))).toBe(false);
        const uploadCall = mockFetch.mock.calls.find(
            ([url]) => url.toString() === uploadDestination
        );
        expect(uploadCall).toBeDefined();
        expect(uploadCall![1]).toEqual(
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    "Content-Type": "video/mp4"
                })
            })
        );
    });
});
