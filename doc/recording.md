# Recording

see [recording/\*](../src/recording) for more details.

The SFu can record streams from a channel (depending on permissions and sfu setup).

Recording happens in two steps:

1. each streams is recorded in real time individually (the "raw recording").
2. later, the raw recordings are processed to produce one "combination" file.

The two phase approach allow for the real time part to be light (only writing packets to file, no transcoding), and then the compiling phase (composition/mixing and transcoding) can be done later with no real time constraint (so the heavy work can be done when the SFU is not under too much load).

## Architecture

```mermaid
flowchart TB

    R["Recorder <br> Channel Level"] ---> RT1["SessionRecorder <br> Session 1"] & RT2["SessionRecorder <br> Session 2"]
    R ---> RTN["SessionRecorder <br> Session N"] & RTN1["SessionRecorder <br> Session N+1"] & RTN0["SessionRecorder <br> Session N+X"]
    RT1 -- audio --> MSA1["MediaSink <br> Audio"]
    RT1 -- screen --> MSS1["MediaSink <br> Screen"]
    RT2 -- screen --> MSS2["MediaSink <br> Screen"]
    RT2 -- camera --> MSC2["MediaSink <br> Camera"]
    RT2 -- audio --> MSA2["MediaSink <br> Audio"]
    MSA1 --> FFA1["MediaWriter <br> Audio Process"]
    MSS1 --> FFS1["MediaWriter <br> Screen Process"]
    MSA2 --> FFA2["MediaWriter <br> Audio Process"]
    MSS2 --> FFS2["MediaWriter <br> Screen Process"]
    MSC2 --> FFC2["MediaWriter <br> Camera Process"]
    FFS1 --> DIR[("Recording Directory")]
    FFA1 --> DIR
    FFS2 --> DIR
    FFC2 --> DIR
    FFA2 --> DIR
```

### Components

1.  **Recorder (Channel Level)**
    Manages recording for an entire `Channel`.
    Handles the lifecycle of recording and holds the `SessionRecorder`s for current sessions and listens for new sessions joining the channel to create them dynamically.

2.  **SessionRecorder (Session Level)**
    Bound to a specific rtc `Session`.
    Monitors the user's producers (audio, camera, screen). When a user releases a stream (e.g., turns on camera), the `SessionRecorder` detects it and manages a `MediaSink` for each.

    -   **Inputs:** `audio`, `camera`, `screen` flags determine which streams to record.

3.  **MediaSink (Stream Level / RTP)**
    Handles a single stream type (e.g., just the camera) for a session.
    bridges the Mediasoup `Producer` (source) to the `MediaWriter` (ffmpeg) process (sink), and manages the lifecycle of the port, transport, consumer and ffmpeg process
    it also handles thhe "allowed"/"active" flags

4.  **MediaWriter (Process Level)**
    Represents a single child process writing to a file.
    Receives RTP packets on a specified port and writes them to a file container. Essentially a wrapper to abstract ffmpeg.

## Output Structure

recordings are saved as `${timestamp}-${channelUUID}` inside `config.dir.recordings` (`${DATA_PATH}/recordings`)

```text
{timestamp}-{channelUUID}/
├── metadata.bin
├── audio/
│   └── {timestamp}-{sessionID}-{streamType}.webm
│   └── 1765292341216-987-audio.webm
│   └── 1765292441216-988-audio.webm
├── camera/
│   └── {timestamp}-{sessionID}-{streamType}.webm
│   └── 1765292341216-985-camera.mp4
│   └── 1765292341219-987-camera.webm
│   └── 1765292341219-987-camera.webm.log
└── screen/
    └── 1765292341216-987-screen.mp4
```

container extensions depend on the stream codec and `.log` files are written when `FFMPEG_LOGGING` is enabled

#### metadata file (`metadata.bin`)

the metadata is encrypted at rest because it contains participant labels, routing data and the channel key

after decryption it contains the recording timeline and upload contract

```json
{
  "channelName": "discuss-channel-1234",
  "channelUUID": "e71d3571-60c8-4c4a-9c49-7686f9a24690",
  "routingAddress": "http://www.oodo.com/discuss/recording/routing/1234",
  "channelKey": "base64-channel-key",
  "partnerId": 42, // optional partner that started the recording
  "audio": true,
  "video": true,
  "transcription": false,
  "labels": {
    "session-123": "Ada"
  },
  "startedAt": 1670000000000,
  "stoppedAt": 1670000060000,
  "timeStamps": [
    {
      "tag": "file_state_change",
      "timestamp": 1670000005000,
      "info": {
        "filename": "1670000005000-session-123-audio.webm",
        "type": "audio",
        "sessionId": "session-123",
        "active": true,
        "available": true
      }
    },
    ...
  ]
}
```

the first `file_state_change` with `active: true` marks the start of a file and the last event with `active: false` marks the end

timestamps are the source of truth because one file can span active and inactive periods without restarting FFmpeg

## scheduler service and post-processing

the scheduler scans finalized raw recordings sequentially and defers media processing while CPU load is high

### [scheduler service](../src/recording/services/scheduler.ts)

the scheduler manage retry timing, TTL cleanup and final folder removal

### [media compiler](../src/recording/models/media_compiler.ts)

one compiler combines the raw streams for one recording into its final audio and video artifacts

#### upload

audio is posted to `${routingAddress}/audio`

video is posted to the destination returned by `${routingAddress}/routing`
