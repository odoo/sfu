import { describe, expect } from "@jest/globals";

import { setConfig } from "./utils/utils";
import { RECORDER_STATE } from "#src/models/recorder.ts";

async function recordingSetup(config: Record<string, string>) {
    const restoreConfig = setConfig(config);
    const { LocalNetwork } = await import("#tests/utils/network");
    const { Channel } = await import("#src/models/channel");
    const network = new LocalNetwork();
    await network.start("0.0.0.0", 61254);
    return {
        restore: () => {
            restoreConfig();
            network.close();
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
});
