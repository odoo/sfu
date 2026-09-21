# Client API (bundle)

See [client.ts](../src/client.ts) and check the `build` script in [package.json](../package.json) for more details on how to build the bundle.

The bundle can be imported in the client(js) code that implements the call feature like this:

```js
import { SfuClient, SFU_CLIENT_STATE } from "/bundle/odoo_sfu.js";
const sfu = new SfuClient();
```

`availableFeatures` contains `rtc` and `recording`. The `recording` object
describes the session's allowed `audio`, `video` and `transcription` outputs.
These permissions are separate from `recordingState`, which contains the
channel's active outputs.

`SfuClient` exposes the following API:

- connect()
    ```js
    sfu.connect("https://my-sfu.com", jsonWebToken, { iceServers });
    ```
    The client forwards the signed JWT unchanged. Its optional `user_id` claim
    identifies the authenticated Odoo user for recording attribution.
- disconnect()
    ```js
    sfu.disconnect();
    sfu.state === SFU_CLIENT_STATE.DISCONNECTED; // true
    ```
- broadcast()
    ```js
    // in the sender's client
    sfu.broadcast("hello");
    ```
    ```js
    // in the clients of other members of that channel
    sfu.addEventListener("update", ({ detail: { name, payload } }) => {
        switch (name) {
            case "broadcast":
                {
                    const { senderId, message } = payload;
                    console.log(`${senderId} says: "${message}"`); // 87 says "hello"
                }
                return;
            // ...
        }
    });
    ```
- updateUpload()
    ```js
    const audioStream = await window.navigator.mediaDevices.getUserMedia({
        audio: true,
    });
    const audioTrack = audioStream.getAudioTracks()[0];
    await sfu.updateUpload("audio", audioTrack); // we upload a new audio track to the server
    await sfu.updateUpload("audio", undefined); // we stop uploading audio
    ```
- updateDownload()
    ```js
    sfu.updateDownload(remoteSessionId, {
        camera: false, // we want to stop downloading their camera
        screen: true, // we want to download their screen
    });
    ```
- updateInfo()
    ```js
    sfu.updateInfo({
        isMuted: true,
        isCameraOn: false,
        // ...
    });
    ```
- getStats()
    ```js
    const { uploadStats, downloadStats, ...producerStats } = await sfu.getStats();
    typeof uploadStats === "RTCStatsReport"; // true
    typeof producerStats["camera"] === "RTCStatsReport"; // true
    // see https://w3c.github.io/webrtc-pc/#rtcstatsreport-object
    ```
- setRecording({ audio?: boolean, video?: boolean, transcription?: boolean })

    Omitted flags keep their current values. An update that leaves all outputs
    disabled stops the recording. Audio and video cannot change during an active
    recording except to stop it. Transcription may change while audio or video
    remains active. The boolean acknowledges acceptance and the
    `update`/`channel_info_change` event carries the resulting state.
    Starting requires at least two participants. Otherwise the request returns
    `false`. Recording stops when a participant leaves one person behind.
    Disconnected clients, request timeouts and a closed Bus reject with `Error`.

    ```js
        const startAcknowledged = await sfuClient.setRecording({
            audio: true,
        });
        const updateAcknowledged = await sfuClient.setRecording({ transcription: true });
        const stopAcknowledged = await sfuClient.setRecording({
            audio: false,
            video: false,
            transcription: false,
        });
    ```

- @fires "update"
    ```js
    sfu.addEventListener("update", ({ detail: { name, payload } }) => {
        switch (name) {
            case "channel_info_change": {
                const { audio, transcription, video } = payload.state;
                const isRecording = Boolean(audio || transcription || video);
                const { stopCode } = payload;
                return;
            }
            case "track":
                {
                    const { sessionId, type, track, active } = payload;
                    const remoteParticipantViewer = findParticipantById(sessionId);
                    if (type === "camera") {
                        remoteParticipantViewer.cameraTrack = track;
                        remoteParticipantViewer.isCameraOn = active; // indicates whether the track is active or paused
                    }
                }
                return;
            // ...
        }
    });
    ```
- @fires "stateChange"
    ```js
    sfu.addEventListener("stateChange", ({ detail: { state, cause } }) => {
        switch (state) {
            case SFU_CLIENT_STATE.CONNECTED:
                console.log("Connected to the SFU server.");
                // we can start uploading now
                client.updateUpload("audio", myMicrophoneTrack);
                client.updateUpload("camera", myWebcamTrack);
                break;
            case SFU_CLIENT_STATE.CLOSED:
                console.log("Connection to the SFU server closed.");
                break;
            // ...
        }
    });
    ```
