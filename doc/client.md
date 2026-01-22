# Client API (bundle)
See [client.js](./src/client.js), and check the `build` script in [package.json](./package.json) for more details on how to build the bundle.

The bundle can be imported in the client(js) code that implements the call feature like this:

```js
import { SfuClient, SFU_CLIENT_STATE } from "/bundle/odoo_sfu.js";
const sfu = new SfuClient();
```
`SfuClient` exposes the following API:

- connect()
    ```js
    sfu.connect("https://my-sfu.com", jsonWebToken, { iceServers });
    ```
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
- startRecording({ video: boolean, transcription: boolean }) / stopRecording()
    ```js
        // return if you were allowed to do the action or not
        allowed = await sfuClient.stopRecording();
        allowed = await sfuClient.startRecording({ video: false, transcription: false });
        // when recording has started or stopped, a "update"/"channel_info_change" event
        // is emitted by the sfuClient (see below).
    ```

- @fires "update"
    ```js
    sfu.addEventListener("update", ({ detail: { name, payload } }) => {
        switch (name) {
            case "channel_info_change":
                const { recording, transcription, video } = payload.recordingState;
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
