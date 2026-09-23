import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { once } from "node:events";

import { describe, expect, jest, test, beforeEach, afterEach } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";
import type { Consumer } from "mediasoup/node/lib/types";

import { STREAM_TYPE } from "#src/shared/enums.ts";
import { CLIENT_UPDATE } from "#src/client";
import { STOP_CODE, TIME_TAG } from "#src/recording/models/recorder.ts";
import type { RecordingFlags } from "#src/shared/types.ts";

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
    test("requires two participants to start and cannot restart after one leaves", async () => {
        const { restore, network, getChannel } = await recordingSetup({ RECORDING: "true" });
        const { Folder, __testing__ } = await import("#src/core/services/resources.ts");
        const createSpy = jest.spyOn(Folder, "create");
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            const recorder = getChannel(channelUUID)!.recorder!;
            const idleState = { audio: false, video: false, transcription: false };
            for (const output of ["audio", "video", "transcription"] as const) {
                expect(await user.sfuClient.setRecording({ [output]: true })).toBe(false);
                expect(recorder.state).toEqual(idleState);
                expect(user.sfuClient.recordingState).toEqual(idleState);
                expect(recorder.path).toBeUndefined();
            }
            expect(await user.sfuClient.setRecording({})).toBe(true);
            expect(await user.sfuClient.setRecording(idleState)).toBe(true);
            expect(createSpy).not.toHaveBeenCalled();
            expect(__testing__.reservedRecordingBytes).toBe(0);
            const peer = await network.connect(channelUUID, 2);
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => user.sfuClient.recordingState.audio);
            expect(recorder.isRecording).toBe(true);
            expect(createSpy).toHaveBeenCalledTimes(1);
            const stopped = once(recorder, "update");
            peer.sfuClient.disconnect();
            const [update] = await stopped;
            expect(update).toEqual({ ...idleState, stopCode: STOP_CODE.CHANNEL_CLOSED });
            await recorder.stop();
            await waitFor(() => user.sfuClient.recordingState.audio === false);
            expect(getChannel(channelUUID)!.sessions.size).toBe(1);
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(false);
            expect(recorder.state).toEqual(idleState);
            expect(recorder.path).toBeUndefined();
            expect(createSpy).toHaveBeenCalledTimes(1);
            expect(__testing__.reservedRecordingBytes).toBe(0);
        } finally {
            createSpy.mockRestore();
            await restore();
        }
    });
    test.each([false, true])(
        "merges queued recording transitions with peer leaving=%s",
        async (leaves) => {
            const { restore, network, getChannel } = await recordingSetup({ RECORDING: "true" });
            const { Folder, __testing__ } = await import("#src/core/services/resources.ts");
            const { Recorder } = await import("#src/recording/models/recorder.ts");
            const channelUUID = await network.getChannelUUID();
            await network.connect(channelUUID, 1);
            const peer = await network.connect(channelUUID, 2);
            const channel = getChannel(channelUUID)!;
            const recorder = channel.recorder!;
            const folder = await Folder.create("deferred", ["audio", "camera", "screen"]);
            const folderGate = Promise.withResolvers<typeof folder>();
            const createSpy = jest.spyOn(Folder, "create").mockReturnValueOnce(folderGate.promise);
            const permissions = { audio: true, video: true, transcription: true };
            const states: RecordingFlags[] = [];
            recorder.on(Recorder.Events.UPDATE, () => {
                states.push(recorder.state);
            });
            try {
                const start = recorder.setRecording({ audio: true }, permissions);
                expect(await start).toBe(true);
                expect(recorder.isRecording).toBe(true);
                const stop = recorder.stop({ save: false });
                const restart = recorder.setRecording({ transcription: true }, permissions);
                const finalStop = recorder.stop({ save: false });
                if (leaves) {
                    peer.sfuClient.disconnect();
                    await waitFor(() => channel.sessions.size === 1);
                }
                folderGate.resolve(folder);
                await Promise.all([start, stop, restart, finalStop]);
                expect(await restart).toBe(!leaves);
                expect(states).toEqual([
                    { audio: true, video: false, transcription: false },
                    { audio: false, video: false, transcription: false },
                    ...(leaves
                        ? []
                        : [
                              { audio: false, video: false, transcription: true },
                              { audio: false, video: false, transcription: false }
                          ])
                ]);
                expect(createSpy).toHaveBeenCalledTimes(leaves ? 1 : 2);
                expect(recorder.isRecording).toBe(false);
                expect(recorder.path).toBeUndefined();
                expect(__testing__.reservedRecordingBytes).toBe(0);
            } finally {
                folderGate.resolve(folder);
                await recorder.stop({ save: false });
                await folder.delete();
                createSpy.mockRestore();
                await restore();
            }
        }
    );
    test("acknowledges start requests and reports disk failures through channel updates", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);

            mockFs.setAvailableDiskSpace(1);
            const recordingFailureEventPromise = once(user.sfuClient, "update");
            const startResult = await user.sfuClient.setRecording({ audio: true });
            const [recordingFailureEvent] = await recordingFailureEventPromise;

            expect(startResult).toBe(true);
            expect(recordingFailureEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        audio: false,
                        transcription: false,
                        video: false
                    },
                    stopCode: STOP_CODE.DISK_SPACE_EXHAUSTED
                }
            });
            expect(Object.values(user.sfuClient.recordingState).some(Boolean)).toBe(false);
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
            expect(user2.sfuClient.availableFeatures).toEqual({
                rtc: true,
                recording: { audio: true, video: true, transcription: true }
            });
            const recordingStartEventPromise = once(user1.sfuClient, "update");
            const startResult = await user2.sfuClient.setRecording({ audio: true });
            expect(startResult).toBe(true);
            const [recordingStartEvent] = await recordingStartEventPromise;
            expect(recordingStartEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        audio: true,
                        transcription: false,
                        video: false
                    }
                }
            });
            await waitFor(() => user2.sfuClient.recordingState.audio);
            const transcriptionEventPromise = once(user1.sfuClient, "update");
            const transcriptionResult = await user2.sfuClient.setRecording({
                transcription: true
            });
            const [transcriptionEvent] = await transcriptionEventPromise;
            expect(transcriptionResult).toBe(true);
            expect(transcriptionEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
                        audio: true,
                        transcription: true,
                        video: false
                    }
                }
            });
            await waitFor(() => user2.sfuClient.recordingState.transcription);
            const recordingEndEventPromise = once(user2.sfuClient, "update");
            const stopResult = await user1.sfuClient.setRecording({
                audio: false,
                video: false,
                transcription: false
            });
            const [recordingEventEnd] = await recordingEndEventPromise;
            expect(recordingEventEnd.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: {
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
    test("stops transcription-only recording when its last output is disabled", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const startUpdate = once(user.sfuClient, "update");
            expect(await user.sfuClient.setRecording({ transcription: true })).toBe(true);
            await startUpdate;
            expect(user.sfuClient.recordingState).toEqual({
                audio: false,
                transcription: true,
                video: false
            });
            const stopUpdate = once(user.sfuClient, "update");
            expect(await user.sfuClient.setRecording({ transcription: false })).toBe(true);
            const [stopEvent] = await stopUpdate;
            expect(user.sfuClient.recordingState).toEqual({
                audio: false,
                transcription: false,
                video: false
            });
            expect(stopEvent.detail).toEqual({
                name: CLIENT_UPDATE.CHANNEL_INFO_CHANGE,
                payload: {
                    state: { audio: false, video: false, transcription: false },
                    stopCode: STOP_CODE.USER_REQUEST
                }
            });
        } finally {
            await restore();
        }
    });
    test("preserves omitted outputs and rejects active media changes", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            expect(await user.sfuClient.setRecording({})).toBe(true);
            const startUpdate = once(user.sfuClient, "update");
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(true);
            await startUpdate;
            expect(await user.sfuClient.setRecording({})).toBe(true);
            expect(await user.sfuClient.setRecording({ audio: true, video: false })).toBe(true);
            expect(await user.sfuClient.setRecording({ video: true })).toBe(false);
            expect(await user.sfuClient.setRecording({ audio: false, transcription: true })).toBe(
                false
            );
            expect(user.sfuClient.recordingState).toEqual({
                audio: true,
                video: false,
                transcription: false
            });
        } finally {
            await restore();
        }
    });
    test("normalizes recording flags from the wire before later updates", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const startUpdate = once(user.sfuClient, "update");
            const malformedFlags = { audio: "yes", video: 0, transcription: "" };
            // @ts-expect-error malformed flags must reach the server through the WebSocket.
            expect(await user.sfuClient.setRecording(malformedFlags)).toBe(true);
            await startUpdate;
            expect(user.sfuClient.recordingState).toEqual({
                audio: true,
                video: false,
                transcription: false
            });
            const transcriptionUpdate = once(user.sfuClient, "update");
            expect(
                await user.sfuClient.setRecording({
                    audio: true,
                    video: false,
                    transcription: true
                })
            ).toBe(true);
            await transcriptionUpdate;
            expect(user.sfuClient.recordingState).toEqual({
                audio: true,
                video: false,
                transcription: true
            });
        } finally {
            await restore();
        }
    });
    test("enforces output permissions while allowing a permitted user to stop all outputs", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        try {
            const channelUUID = await network.getChannelUUID();
            const starter = await network.connect(channelUUID, 1);
            const user = await network.connect(channelUUID, 2);
            user.session.updatePermissions({
                audioRecording: false,
                videoRecording: false,
                transcription: false
            });
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(false);
            expect(
                await user.sfuClient.setRecording({
                    audio: false,
                    video: false,
                    transcription: false
                })
            ).toBe(false);
            user.session.updatePermissions({ audioRecording: true });
            expect(await user.sfuClient.setRecording({ video: true })).toBe(false);
            expect(await user.sfuClient.setRecording({ transcription: true })).toBe(false);
            const startUpdate = once(user.sfuClient, "update");
            expect(await starter.sfuClient.setRecording({ audio: true, transcription: true })).toBe(
                true
            );
            await startUpdate;
            expect(await user.sfuClient.setRecording({ transcription: false })).toBe(false);
            expect(user.sfuClient.recordingState).toEqual({
                audio: true,
                video: false,
                transcription: true
            });
            expect(user.session.startupData).toEqual({
                availableFeatures: {
                    rtc: true,
                    recording: { audio: true, video: false, transcription: false }
                },
                recordingState: { audio: true, video: false, transcription: true }
            });
            user.session.updatePermissions({ audioRecording: false });
            expect(await user.sfuClient.setRecording({})).toBe(false);
            expect(
                await user.sfuClient.setRecording({
                    audio: false,
                    transcription: false
                })
            ).toBe(false);
            expect(user.sfuClient.recordingState).toEqual({
                audio: true,
                video: false,
                transcription: true
            });
            user.session.updatePermissions({ audioRecording: true });
            const stopUpdate = once(user.sfuClient, "update");
            expect(await user.sfuClient.setRecording({ audio: false, transcription: false })).toBe(
                true
            );
            await stopUpdate;
            expect(user.sfuClient.recordingState).toEqual({
                audio: false,
                video: false,
                transcription: false
            });
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
            const starter = await network.connect(channelUUID, 1, { userId: 11 });
            const updater = await network.connect(channelUUID, 2, { userId: 22 });

            expect(await starter.sfuClient.setRecording({ audio: true })).toBe(true);
            expect(await updater.sfuClient.setRecording({ transcription: true })).toBe(true);
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
            expect(metadata.userId).toBe(11);
            expect(metadata).not.toHaveProperty("partnerId");
            expect(metadata).not.toHaveProperty("labels");
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
    test("resets the recording starter between users and guests", async () => {
        const { restore, network, getChannel } = await recordingSetup({ RECORDING: "true" });
        const config = await import("#src/config.ts");
        const auth = await import("#src/core/services/auth.ts");
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
        let now = 1_000_000;
        const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const channelUUID = await network.getChannelUUID();
            const recorder = getChannel(channelUUID)!.recorder!;
            await network.connect(channelUUID, 4);
            for (const [sessionId, userId] of [
                [1, 11],
                [2, undefined],
                [3, 22]
            ] as const) {
                const starter = await network.connect(channelUUID, sessionId, { userId });
                expect(await starter.sfuClient.setRecording({ audio: true })).toBe(true);
                await waitFor(() => recorder.path !== undefined);
                const recordingName = path.basename(recorder.path!).replace(/-\d+$/, "");
                now += config.recording.minDuration + 1;
                await recorder.stop();
                const metadata = JSON.parse(
                    auth.decrypt(
                        await mockFs.readFile(
                            path.join(
                                config.dir.recordings,
                                recordingName,
                                config.recording.metadataFileName
                            )
                        )
                    )
                );
                expect(metadata.userId).toBe(userId);
                expect(Object.hasOwn(metadata, "userId")).toBe(userId !== undefined);
                expect(metadata).not.toHaveProperty("partnerId");
            }
        } finally {
            dateNowSpy.mockRestore();
            await restore();
        }
    });
    test.each([
        { offset: -1, saved: false },
        { offset: 0, saved: true }
    ])("saves=$saved at minDuration $offset ms", async ({ offset, saved }) => {
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });
        const config = await import("#src/config.ts");
        const { mockFs } = await import("#tests/utils/mockFileSystem.ts");
        const { __testing__ } = await import("#src/core/services/resources.ts");
        let now = 1_000_000;
        const dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const recorder = getChannel(channelUUID)!.recorder!;
            expect(await user.sfuClient.setRecording({ audio: true })).toBe(true);
            await waitFor(() => recorder.path !== undefined);
            const resourcePath = recorder.path!;
            const recordingName = path.basename(resourcePath).replace(/-\d+$/, "");
            const recordingPath = path.join(config.dir.recordings, recordingName);
            now += config.recording.minDuration + offset;
            await recorder.stop();
            expect(mockFs.exists(resourcePath)).toBe(false);
            expect(mockFs.exists(recordingPath)).toBe(saved);
            expect(mockFs.exists(path.join(recordingPath, config.recording.metadataFileName))).toBe(
                saved
            );
            expect(recorder.isRecording).toBe(false);
            expect(__testing__.reservedRecordingBytes).toBe(0);
        } finally {
            dateNowSpy.mockRestore();
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
            await network.connect(channelUUID, 2);
            await user.sfuClient.setRecording({ audio: true, video: true });

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

    test("defers recording activation until the first outgoing RTP packet", async () => {
        const { restore, network, getChannel } = await recordingSetup({
            RECORDING: "true"
        });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await network.connect(channelUUID, 2);
            const channel = getChannel(channelUUID)!;
            const consumerPromise = new Promise<Consumer>((resolve) => {
                channel.router!.observer.once("newtransport", (transport) => {
                    transport.observer.once("newconsumer", resolve);
                });
            });
            const mark = jest.spyOn(channel.recorder!, "mark");

            await user.sfuClient.setRecording({ audio: true });
            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);
            const consumer = await consumerPromise;

            // The consumer is resumed and RTP tracing is armed, but until a packet
            // is actually forwarded the stream must not be marked active.
            await waitFor(() => !consumer.paused && consumer.listenerCount("trace") === 1);
            expect(mark.mock.calls.some(([, info]) => info.active)).toBe(false);

            const rtpTrace = { type: "rtp", direction: "out", timestamp: 0, info: {} } as const;
            consumer.emit("trace", rtpTrace);
            expect(mark.mock.calls.filter(([, info]) => info.active)).toHaveLength(1);

            // Tracing is torn down after the first packet so it does not fire for
            // every subsequent one, and the stream is only ever activated once.
            expect(consumer.listenerCount("trace")).toBe(0);
            consumer.emit("trace", rtpTrace);
            expect(mark.mock.calls.filter(([, info]) => info.active)).toHaveLength(1);
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
            await network.connect(channelUUID, 2);

            const audioTrack = new FakeMediaStreamTrack({ kind: "audio" });
            await user.sfuClient.updateUpload(STREAM_TYPE.AUDIO, audioTrack);

            const videoTrack = new FakeMediaStreamTrack({ kind: "video" });
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, videoTrack);
            await user.sfuClient.updateUpload(STREAM_TYPE.SCREEN, null);

            await user.sfuClient.setRecording({ audio: true, video: true });

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
            await network.connect(channelUUID, 3);

            await user1.sfuClient.setRecording({ audio: true });
            await waitFor(() => user1.sfuClient.recordingState.audio);

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
            await network.connect(channelUUID, 2);
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

            await user.sfuClient.setRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.audio);

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
            await network.connect(channelUUID, 2);

            await user.sfuClient.setRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.audio);

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
                        audio: false,
                        transcription: false,
                        video: false
                    },
                    stopCode: STOP_CODE.RECORDING_FAILED
                }
            });
            await waitFor(() => Boolean(resourcePath && !mockFs.exists(resourcePath)));
            expect(ffmpegProcess!.killed).toBe(true);
            expect(recorder.isRecording).toBe(false);
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
            await network.connect(channelUUID, 2);
            await user.sfuClient.setRecording({ audio: true });
            await waitFor(() => user.sfuClient.recordingState.audio);

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
                expect(recorder.isRecording).toBe(false);
                expect(mockFs.exists(resourcePath)).toBe(false);
            } finally {
                createTransportSpy.mockRestore();
            }
        } finally {
            await restore();
        }
    });

    test("keeps recording when session replacement force closes its writer", async () => {
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
            await network.connect(channelUUID, 2);
            await user.sfuClient.setRecording({ audio: true });
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
            expect(process!.killed).toBe(true);
            expect(stopCode).toBeUndefined();
            expect(recorder.isRecording).toBe(true);
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
            await network.connect(channelUUID, 2);

            await user.sfuClient.setRecording({ audio: true, video: true });
            await waitFor(() => user.sfuClient.recordingState.audio);

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
            await jest.advanceTimersByTimeAsync(30_001);
            await stopPromise;
            await failureUpdatePromise;

            expect(killSignals).toEqual(["SIGINT", "SIGKILL"]);
            expect(mockFs.exists(resourcePath!)).toBe(false);
        } finally {
            cameraClose.resolve();
            audioProcess?.emit("close", null, "SIGKILL");
            jest.useRealTimers();
            await restore();
        }
    });

    test.each([
        { type: STREAM_TYPE.CAMERA, limit: 4 },
        { type: STREAM_TYPE.SCREEN, limit: 1 }
    ])(
        "records the latest $limit $type streams and resumes a waiting stream",
        async ({ type, limit }) => {
            mockSpawn.mockClear();
            mockSpawn.mockImplementation((_cmd, args) => {
                const process = new MockChildProcess("ffmpeg", args || []);
                process.stdin = new PassThrough();
                return process;
            });
            const { restore, network, getChannel } = await recordingSetup({
                RECORDING: "true"
            });
            try {
                const channelUUID = await network.getChannelUUID();
                const users = [];
                for (let id = 1; id <= limit + 1; id++) {
                    const user = await network.connect(channelUUID, id);
                    await user.sfuClient.updateUpload(
                        type,
                        new FakeMediaStreamTrack({ kind: "video" })
                    );
                    users.push(user);
                }
                const consumers = new Map<string, Consumer>();
                getChannel(channelUUID)!.router!.observer.on("newtransport", (transport) => {
                    transport.observer.once("newconsumer", (consumer) => {
                        consumers.set(consumer.producerId, consumer);
                    });
                });
                await users[0].sfuClient.setRecording({ video: true });
                await waitFor(() => consumers.size === users.length);
                const recordingConsumers = users.map(
                    (user) => consumers.get(user.session.producers[type]!.id)!
                );
                await waitFor(() =>
                    recordingConsumers.slice(1).every((consumer) => !consumer.paused)
                );
                expect(recordingConsumers.map((consumer) => consumer.paused)).toEqual([
                    true,
                    ...Array<boolean>(limit).fill(false)
                ]);
                await users[limit].sfuClient.updateUpload(type, null);
                await waitFor(() => !recordingConsumers[0].paused);
                expect(recordingConsumers.map((consumer) => consumer.paused)).toEqual([
                    ...Array<boolean>(limit).fill(false),
                    true
                ]);
            } finally {
                await restore();
            }
        }
    );
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
                await screenUser.sfuClient.setRecording({ video: true });
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

    test("does not scan or schedule processing when recording is disabled", async () => {
        const config = await import("#src/config.ts");
        const enabled = jest.replaceProperty(config.recording, "enabled", false);
        const intervalSpy = jest.spyOn(global, "setInterval");
        try {
            await mediaService.start();
            expect(mockFsModule.readdir).not.toHaveBeenCalled();
            expect(intervalSpy).not.toHaveBeenCalled();
        } finally {
            enabled.restore();
            intervalSpy.mockRestore();
        }
    });

    test.each([
        { name: "audio recording", video: false },
        { name: "video recording without video output", video: true }
    ])("should process a valid $name", async ({ video }) => {
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
            video,
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
        expect(mockFetch).toHaveBeenCalledWith(
            `${routingAddress}/routing?start_ms=${metadata.startedAt}&end_ms=${metadata.stoppedAt}&mimetype=audio%2Fogg`,
            expect.anything()
        );
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true
        });
    });

    test("discards recording after a metadata read failure", async () => {
        const recordingName = "unreadable_session";
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

        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(mockFsModule.readFile).toHaveBeenCalledTimes(1);
        await mediaService.__testing__.oneProcessingBatch();
        expect(mockFsModule.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true,
            force: true
        });
        expect(mockFsModule.readFile).toHaveBeenCalledTimes(1);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("does not upload again when recording cleanup fails", async () => {
        const { MediaCompiler } = await import("#src/recording/models/media_compiler.ts");
        const recordingDir = "/mock/recordings/cleanup_failure";
        const metadataPath = path.join(recordingDir, "metadata.bin");
        const audioPath = path.join(recordingDir, "audio.ogg");
        mockFs.write(
            metadataPath,
            JSON.stringify({
                routingAddress: "http://routing.local",
                channelKey: "key",
                startedAt: 1000,
                stoppedAt: Date.now() - 1000,
                timeStamps: [],
                audio: true,
                video: false,
                transcription: false
            })
        );
        mockFs.write(audioPath, "audio");
        const compileAudio = jest
            .spyOn(MediaCompiler.prototype, "getAudio")
            .mockResolvedValue(audioPath);
        mockFetch
            .mockResolvedValueOnce(Response.json({ destination: "http://upload.local" }))
            .mockResolvedValueOnce(new Response());
        const remove = mockFsModule.rm.getMockImplementation()!;
        mockFsModule.rm.mockRejectedValue(new Error("cleanup failed"));
        try {
            await mediaService.start();
            expect(mockFs.exists(recordingDir)).toBe(true);
            expect(mockFs.exists(metadataPath)).toBe(false);
            expect(mockFs.exists(`${metadataPath}.processing`)).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            mockFsModule.rm.mockImplementation(remove);
            await mediaService.__testing__.oneProcessingBatch();
            expect(mockFs.exists(recordingDir)).toBe(false);
            expect(compileAudio).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        } finally {
            mockFsModule.rm.mockImplementation(remove);
            compileAudio.mockRestore();
        }
    });

    test("archives successful recordings when FFmpeg logging is enabled", async () => {
        const config = await import("#src/config.ts");
        const logging = jest.replaceProperty(config, "FFMPEG_LOGGING", true);
        const recordingDir = "/mock/recordings/debug_recording";
        mockFs.write(
            path.join(recordingDir, "metadata.bin"),
            JSON.stringify({
                routingAddress: "http://routing.local",
                channelKey: "key",
                startedAt: 1000,
                stoppedAt: Date.now() - 1000,
                timeStamps: [],
                audio: false,
                video: false,
                transcription: false
            })
        );
        try {
            await mediaService.start();
            expect(mockFs.exists(recordingDir)).toBe(false);
            expect(mockFs.exists("/mock/debug/debug_recording/metadata.bin.processing")).toBe(true);
        } finally {
            logging.restore();
        }
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
            recursive: true,
            force: true
        });
        expect(mockFs.exists(recordingDir)).toBe(false);
        expect(mockFs.exists(freshRecordingDir)).toBe(true);
        expect(mockFs.exists(path.join(freshRecordingDir, "metadata.bin"))).toBe(true);
        expect(mockFs.exists(path.join(freshRecordingDir, "metadata.bin.processing"))).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
        loadAverage.mockReturnValue([0, 0, 0]);
        await mediaService.__testing__.oneProcessingBatch();
        expect(mockFs.exists(freshRecordingDir)).toBe(false);
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

    test("rejects compilation when ffprobe is terminated", async () => {
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

    test("removes partial output when ffmpeg fails", async () => {
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
        mockSpawn.mockImplementation((command, args, options) => {
            if (command !== "ffmpeg") {
                return spawn(command, args, options);
            }
            const process = makeManualProcess(args as string[]);
            setTimeout(() => {
                mockFs.write((args as string[]).at(-1)!, "partial");
                process.emit("close", 1);
            });
            return process;
        });

        await expect(new MediaCompiler(options).getAudio()).rejects.toThrow();
        expect(mockFs.exists(path.join(workingDir, "recording_1000.partial.ogg"))).toBe(false);
        expect(mockFs.exists(path.join(workingDir, "recording_1000.ogg"))).toBe(false);
        expect(mockSpawn.mock.calls.filter(([command]) => command === "ffmpeg")).toHaveLength(1);
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

    test("cancels an unused upload response without requiring a legacy completion callback", async () => {
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
                userId: 42,
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
            expect.objectContaining({ method: "POST" })
        );
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const auth = await import("#src/core/services/auth.ts");
        expect(auth.sign).toHaveBeenCalledWith(expect.objectContaining({ user_id: 42 }), "key");
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(textSpy).not.toHaveBeenCalled();
    });

    test.each([undefined, 42])(
        "acknowledges an upload with fresh JWTs for user %p",
        async (userId) => {
            const { MediaUploader } = await import("#src/recording/models/media_uploader.ts");
            const auth = await import("#src/core/services/auth.ts");
            const filePath = "/mock/audio.ogg";
            mockFsInstance.write(filePath, "audio");
            const uploadGate = Promise.withResolvers<Response>();
            const completionResponse = new Response("ignored");
            const cancelSpy = jest.spyOn(completionResponse.body!, "cancel");
            const nowSpy = jest.spyOn(Date, "now").mockReturnValue(100_000);
            mockFetch
                .mockResolvedValueOnce(
                    Response.json({
                        destination: "http://upload.local",
                        method: "PUT",
                        headers: { "x-upload-token": "cloud-token" },
                        response_status: 201,
                        requires_completion: true
                    })
                )
                .mockReturnValueOnce(uploadGate.promise)
                .mockResolvedValueOnce(completionResponse);
            const uploader = new MediaUploader({
                routingTimeoutMs: 1000,
                uploadTimeoutMs: 1000
            });
            const upload = uploader.uploadMedia({
                filePath,
                mimetype: "audio/ogg",
                metadata: {
                    channelName: "channel",
                    channelUUID: "uuid",
                    routingAddress: "http://routing.local",
                    channelKey: "key",
                    userId,
                    startedAt: 1000,
                    stoppedAt: 2000,
                    timeStamps: [],
                    audio: true,
                    video: false,
                    transcription: false
                }
            });
            try {
                await waitFor(() => mockFetch.mock.calls.length === 2);
                expect(auth.sign).toHaveBeenCalledTimes(1);
                const identity = userId === undefined ? {} : { user_id: userId };
                expect(auth.sign).toHaveBeenNthCalledWith(
                    1,
                    { iat: 100, exp: 220, ...identity },
                    "key"
                );
                expect(mockFetch).toHaveBeenNthCalledWith(
                    2,
                    "http://upload.local",
                    expect.objectContaining({
                        method: "PUT",
                        headers: {
                            "Content-Type": "audio/ogg",
                            "Content-Length": "999",
                            "x-upload-token": "cloud-token"
                        }
                    })
                );
                nowSpy.mockReturnValue(300_000);
                uploadGate.resolve(new Response(null, { status: 201 }));
                await upload;
                expect(mockFetch).toHaveBeenNthCalledWith(
                    3,
                    "http://routing.local/complete?start_ms=1000&end_ms=2000",
                    expect.objectContaining({
                        method: "POST",
                        headers: { Authorization: "Bearer mock_jwt" }
                    })
                );
                expect(mockFetch).toHaveBeenCalledTimes(3);
                expect(auth.sign).toHaveBeenNthCalledWith(
                    2,
                    { iat: 300, exp: 420, ...identity },
                    "key"
                );
                expect(cancelSpy).toHaveBeenCalledTimes(1);
            } finally {
                uploadGate.resolve(new Response(null, { status: 201 }));
                await upload;
                nowSpy.mockRestore();
            }
        }
    );

    test.each([
        { audio: false, video: false, userId: undefined, expected: "false" },
        { audio: true, video: true, userId: 42, expected: "true" }
    ])("uses the Odoo transcription route with media output $expected", async (options) => {
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
                userId: options.userId,
                startedAt: 1000,
                stoppedAt: 2000,
                timeStamps: [],
                audio: options.audio,
                video: options.video,
                transcription: true
            }
        });

        expect(mockFetch).toHaveBeenCalledWith(
            `http://routing.local/transcribe?start_ms=1000&end_ms=2000&has_media_output=${options.expected}`,
            expect.objectContaining({ method: "POST" })
        );
        const auth = await import("#src/core/services/auth.ts");
        const claims = jest.mocked(auth.sign).mock.calls[0]?.[0];
        expect(Reflect.get(claims ?? {}, "user_id")).toBe(options.userId);
        expect(Object.hasOwn(claims ?? {}, "user_id")).toBe(options.userId !== undefined);
        expect(claims).not.toHaveProperty("partner_id");
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

    test.each(
        [
            { phase: "compiler", status: 503, requests: 0 },
            { phase: "transcription", status: 503, requests: 1 },
            { phase: "routing", status: 503, requests: 2 },
            { phase: "upload", status: 503, requests: 3 },
            { phase: "upload", status: 200, requests: 3 },
            { phase: "completion", status: 503, requests: 4 }
        ].flatMap((failure) =>
            [false, true].map((ffmpegLogging) => ({ ...failure, ffmpegLogging }))
        )
    )(
        "discards $phase failure ($status) without retry with logging=$ffmpegLogging",
        async ({ phase, status, requests, ffmpegLogging }) => {
            const config = await import("#src/config.ts");
            const logging = jest.replaceProperty(config, "FFMPEG_LOGGING", ffmpegLogging);
            const { MediaCompiler } = await import("#src/recording/models/media_compiler.ts");
            const recordingName = "session_route_fail";
            const routingAddress = "http://www.oodo.test/routing";
            const recordingDir = `/mock/recordings/${recordingName}`;
            const audioPath = path.join(recordingDir, "audio", "audio_1.ogg");
            const metadata = {
                channelName: "Test Channel",
                routingAddress,
                channelKey: "key123",
                stoppedAt: Date.now() - 1000,
                startedAt: 1000,
                timeStamps: [fileState(STREAM_TYPE.AUDIO, "audio_1.ogg", 1100)],
                audio: true,
                video: false,
                transcription: true
            };
            mockFsInstance.write(path.join(recordingDir, "metadata.bin"), JSON.stringify(metadata));
            mockFsInstance.write(audioPath, "dummy audio");
            const compileAudio = jest.spyOn(MediaCompiler.prototype, "getAudio");
            compileAudio.mockResolvedValue(audioPath);
            if (phase === "compiler") {
                compileAudio.mockRejectedValue(new Error("compiler failed"));
            }
            mockFetch.mockImplementation(async (url: string | URL | Request) => {
                const urlString = url.toString();
                const requestPhase = urlString.includes("/transcribe?")
                    ? "transcription"
                    : urlString.includes("/routing?")
                    ? "routing"
                    : urlString === "http://upload.local"
                    ? "upload"
                    : "completion";
                if (phase === requestPhase) {
                    return new Response(null, { status });
                }
                if (requestPhase === "routing") {
                    return Response.json({
                        destination: "http://upload.local",
                        response_status: 201,
                        requires_completion: true
                    });
                }
                return new Response(null, { status: 201 });
            });
            try {
                await mediaService.start();
                const params = `start_ms=${metadata.startedAt}&end_ms=${metadata.stoppedAt}`;
                const expectedRequests = [
                    `${routingAddress}/transcribe?${params}&has_media_output=true`,
                    `${routingAddress}/routing?${params}&mimetype=audio%2Fogg`,
                    "http://upload.local",
                    `${routingAddress}/complete?${params}`
                ].slice(0, requests);
                expect(mockFetch.mock.calls.map(([url]) => url.toString())).toEqual(
                    expectedRequests
                );
                expect(mockFsInstance.exists(recordingDir)).toBe(false);
                expect(mockFsInstance.exists(`/mock/debug/${recordingName}`)).toBe(false);
                expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, {
                    recursive: true,
                    force: true
                });
                await mediaService.__testing__.oneProcessingBatch();
                expect(compileAudio).toHaveBeenCalledTimes(1);
                expect(mockFetch.mock.calls.map(([url]) => url.toString())).toEqual(
                    expectedRequests
                );
            } finally {
                compileAudio.mockRestore();
                logging.restore();
            }
        }
    );

    test("discards recording when routing returns no destination", async () => {
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
        expect(mockFsModuleInstance.rm).toHaveBeenCalledWith(recordingDir, {
            recursive: true,
            force: true
        });
        expect(mockFsInstance.exists(recordingDir)).toBe(false);
        await mediaService.__testing__.oneProcessingBatch();
        expect(mockFetch).toHaveBeenCalledTimes(1);
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
