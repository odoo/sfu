import type { SpawnOptions, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import { describe, expect, jest, test } from "@jest/globals";
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";

import { RECORDER_STATE } from "#src/models/recorder.ts";
import { STREAM_TYPE } from "#src/shared/enums.ts";

import { withMockEnv } from "#tests/utils/utils";

type ChildProcessLike = {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: number | string) => boolean;
    killed: boolean;
    pid: number;
} & ChildProcess;

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => {
    const original = jest.requireActual("node:child_process") as {
        spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;
    };
    return {
        ...original,
        spawn: (command: string, args: string[], options: SpawnOptions): ChildProcessLike => {
            if (command === "ffmpeg") {
                return mockSpawn(command, args, options) as ChildProcessLike;
            }
            return original.spawn(command, args, options);
        }
    };
});

async function recordingSetup(env: Record<string, string>) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfu-test-"));
    const resourcesPath = path.join(tmpDir, "resources");
    const recordingPath = path.join(tmpDir, "recordings");

    // making sure that during the tests, we don't clog the resources and recordings directories
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
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
        getChannel: (uuid: string) => Channel.records.get(uuid),
        network
    };
}

describe("Recording & Transcription", () => {
    test("Does not record when the feature is disabled", async () => {
        const { restore } = await recordingSetup({ RECORDING: "" });
        const config = await import("#src/config");
        expect(config.recording.enabled).toBe(false);
        restore();
    });
    test("can record", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        expect(user2.sfuClient.availableFeatures.recording).toBe(true);
        const startResult = (await user2.sfuClient.startRecording()) as boolean;
        expect(startResult).toBe(true);
        const stopResult = (await user2.sfuClient.stopRecording()) as boolean;
        expect(stopResult).toBe(false);
        restore();
    });
    test("can transcribe", async () => {
        const { restore, network } = await recordingSetup({ RECORDING: "enabled" });
        const channelUUID = await network.getChannelUUID();
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        expect(user2.sfuClient.availableFeatures.transcription).toBe(true);
        const startResult = (await user2.sfuClient.startTranscription()) as boolean;
        expect(startResult).toBe(true);
        const stopResult = (await user2.sfuClient.stopTranscription()) as boolean;
        expect(stopResult).toBe(false);
        restore();
    });
    test("can record and transcribe simultaneously", async () => {
        const { restore, network, getChannel } = await recordingSetup({ RECORDING: "true" });
        const channelUUID = await network.getChannelUUID();
        const channel = getChannel(channelUUID);
        const user1 = await network.connect(channelUUID, 1);
        await user1.isConnected;
        const user2 = await network.connect(channelUUID, 3);
        await user2.isConnected;
        await user2.sfuClient.startTranscription();
        await user1.sfuClient.startRecording();
        const recorder = channel!.recorder!;
        expect(recorder.isRecording).toBe(true);
        expect(recorder.isTranscribing).toBe(true);
        expect(recorder.state).toBe(RECORDER_STATE.STARTED);
        await user1.sfuClient.stopRecording();
        // stopping the recording while a transcription is active should not stop the transcription
        expect(recorder.isRecording).toBe(false);
        expect(recorder.isTranscribing).toBe(true);
        expect(recorder.state).toBe(RECORDER_STATE.STARTED);
        await user2.sfuClient.stopTranscription();
        expect(recorder.isRecording).toBe(false);
        expect(recorder.isTranscribing).toBe(false);
        expect(recorder.state).toBe(RECORDER_STATE.STOPPED);
        restore();
    });

    test("Spawns FFMPEG for both audio and video streams", async () => {
        mockSpawn.mockImplementation(() => {
            const mp = new EventEmitter() as ChildProcessLike;
            mp.stdin = new PassThrough();
            mp.stdout = new PassThrough();
            mp.stderr = new PassThrough();
            mp.kill = jest.fn() as (signal?: number | string) => boolean;
            mp.killed = false;
            return mp;
        });

        const { restore, network } = await recordingSetup({ RECORDING: "true" });

        try {
            const channelUUID = await network.getChannelUUID();
            const user = await network.connect(channelUUID, 1);
            await user.isConnected;
            await user.sfuClient.startRecording();

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
});
