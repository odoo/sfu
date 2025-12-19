# Recording
see [media.ts](../src/services/media.ts) and [recording/*](../src/models/recording) for more details.

The recording feature in the SFU allows for capturing audio, video from camera, and screen sharing streams from a channel. It is designed to handle each stream independently to produce raw recording files that can be processed later (e.g., for transcription, composition, or playback).

## Architecture

The recording architecture follows a hierarchical structure, managing resources from the channel level down to individual system processes.

```mermaid
flowchart TB
   
    R["Recorder <br> Channel Level"] --> RT1["RecordingTask <br> Session 1"] & RT2["RecordingTask <br> Session 2"]
    R ---> RTN["RecordingTask <br> Session N"] & RTN1["RecordingTask <br> Session N+1"] & RTN0["RecordingTask <br> Session N+X"]
    RT1 -- audio --> MOA1["MediaOutput <br> Audio"]
    RT1 -- screen --> MOS1["MediaOutput <br> Screen"]
    RT2 -- screen --> MOS2["MediaOutput <br> Screen"]
    RT2 -- camera --> MOC2["MediaOutput <br> Camera"]
    RT2 -- audio --> MOA2["MediaOutput <br> Audio"]
    MOA1 --> FFA1["MediaWriter <br> Audio Process"]
    MOS1 --> FFS1["MediaWriter <br> Screen Process"]
    MOA2 --> FFA2["MediaWriter <br> Audio Process"]
    MOS2 --> FFS2["MediaWriter <br> Screen Process"]
    MOC2 --> FFC2["MediaWriter <br> Camera Process"]
    FFS1 --> DIR[("Recording Directory")]
    FFA1 --> DIR
    FFS2 --> DIR
    FFC2 --> DIR
    FFA2 --> DIR
```

### Components

1.  **Recorder (Channel Level)**
    *   **Scope:** Manages recording for an entire `Channel`.
    *   **Responsibility:** Handles the lifecycle of recording and holds the  `RecordingTask`s for current sessions and listens for new sessions joining the channel to create tasks for them dynamically.

2.  **RecordingTask (Session Level)**
    *   **Scope:** Bound to a specific rtc `Session`.
    *   **Responsibility:** Monitors the user's producers (audio, camera, screen). When a user releases a stream (e.g., turns on camera), the `RecordingTask` detects it and delegates the recording logic to a `MediaOutput`.
    *   **Inputs:** `audio`, `camera`, `screen` flags determine which streams to record.

3.  **MediaOutput (Stream Level / RTP)**
    *   **Scope:** Handles a single stream type (e.g., just the camera) for a session.
    *   **Responsibility:** Bridges the Mediasoup `Producer` (source) to the `MediaWriter` (ffmpeg) process (sink), and manages the lifecycle of the port, transport, consumer, and ffmpeg process.

4.  **MediaWriter (Process Level)**
    *   **Scope:** Represents a single child process writing to a file.
    *   **Responsibility:** Receives RTP packets on a specified port and writes them to a file container. Essentially a wrapper around the ffmpeg API.


## Settings & Environment Variables

The recording feature is configured via environment variables in `src/config.ts`.

| Variable           | Type    | Description                                                               | Default                    |
| :----------------- | :------ | :------------------------------------------------------------------------ | :------------------------- |
| `RECORDING`        | boolean | Master switch to enable/disable the recording feature.                    | `false`                    |
| `RECORDING_PATH`   | string  | Directory where the raw recordings are saved.                             | `/tmp/odoo_sfu/recordings` |
| `DYNAMIC_MIN_PORT` | number  | Start of the port range for internal RTP routing (MediaOutput -> FFMPEG). | `50000`                    |
| `DYNAMIC_MAX_PORT` | number  | End of the port range for internal RTP routing.                           | `59999`                    |

**Important Note:** The `DYNAMIC_MIN_PORT` and `DYNAMIC_MAX_PORT` range **MUST NOT** overlap with the `RTC_MIN_PORT` and `RTC_MAX_PORT` range used for client connections.

## Output Structure

Recordings are saved in a directory named `{channelName}_{timestamp}` inside `RECORDING_PATH`.

```text
{channelName}_{timestamp}/
├── metadata.json
├── audio/
│   └── {sessionID}-{streamType}-{timestamp}.webm
│   └── 987-audio-1765292341216.webm
│   └── 988-audio-1765292441216.webm
├── video/
│   └── 989-video-1765492341216.mp4 // extension depends on codec
│   └── 987-video-1765292341216.webm
│   └── 987-video-1765292341216.log // if LOG_LEVEL=debug
└── screen/
    └── 987-screen-1765592341216.webm
```

#### Contents:
*   **metadata.json:** Top-level metadata file containing timestamps and upload info.
*   **audio/:** Folder containing all audio stream recordings.
*   **video/:** Folder containing all camera stream recordings.
*   **screen/:** Folder containing all screen sharing stream recordings.

#### Metadata File (`metadata.json`)

Contains the timestamps of the recording, and the address to which the file should be uploaded to.

```json
{
  "channelName": "discuss-channel-1234",
  "routingAddress": "http://www.oodo.com/discuss/recording/routing/1234",
  "video": true,
  "transcription": false,
  "startedAt": 1670000000000,
  "stoppedAt": 1670000060000,
  "timeStamps": [
    {
      "tag": "file_state_change",
      "timestamp": 1670000005000,
      "info": {
        "filename": "session-123-audio-167...webm",
        "type": "audio",
        "active": true
      }
    },
    ...
  ]
}
```
The first occurence of `file_state_change` with `active: true` marks the start of a file, and the last one with `active: false` marks the end, 
each file can have any arbitrary amount of state changes, when not active the content is essentially empty but the inner timestamps are still being marked.

## Media Service & Post-Processing

While the **Recorder** handles the real-time capture of streams, the **Media Service** is responsible for the asynchronous post-processing of these raw files.

### 1. Service Workflow (`src/services/media.ts`)

The Media Service runs as a background maintenance task:
1.  **Monitoring**: It wakes up periodically (default: every 10 minutes).
2.  **System Check**: It checks the system CPU load. If the load is too high, it skips that cycle to avoid affecting active real-time sessions.
3.  **Discovery**: It scans the `RECORDING_PATH` for recording directories.
4.  **Processing**: It delegates the actual file manipulation to the `MediaCompiler`.

### 2. Media Compiler (`src/models/recording/media_compiler.ts`)

The compiler transforms raw recording files into compiled recordings.

#### Upload (Planned)
After compilation, the service is responsible for uploading the generated artifacts based on the routing information obtained from the `routingAddress`.
