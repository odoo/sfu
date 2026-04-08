# Odoo SFU

> [!WARNING]  
> Early phase of developments, the readme may not be up to date, or be incorrect,
> needs some cleanup, remove todos, fix broken links (since some files were moved). will finalize when the PR is ready
> Current documentation is split/rewrite of the old readme, some parts may still be split into
> secondary documentataion files
>

## Overview

Contains the code for the SFU (Selective Forwarding Unit) server 
used in [Odoo Discuss](https://www.odoo.com/app/discuss). The SFU server is responsible for handling the WebRTC connections
between users and providing channels to coordinate these connections.

The server is not stand-alone, it does not serve any HTML or any interface code for calls. It only contains
the SFU and a [client bundle/library](#client-api-bundle) to connect to it.

The SFU uses [Mediasoup](https://mediasoup.org/) WebRTC library for the routing/transport of streams.

## Prerequisites
- [Node.js 24.13.0 (LTS)](https://nodejs.org/en/download)
- [FFmpeg 8](https://ffmpeg.org/download.html) (if using the recording feature)

## Before deployment

Build the client bundle

 ```bash
     npm install
     npm run build
 ```

Once the bundle is built, it can be added to the assets of your main server, and
interacted with as described [here](#client-api-bundle).

## Deployment

1. Install dependencies.
    ```bash
        npm ci -omit=dev
    ```
2. Run the SFU server.
    ```bash
        npm PROXY=1 PUBLIC_IP=sfu.example.com AUTH_KEY=u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng= run start
    ```

The available environment variables are:

| Variable            | Default         | Required | Description                                                                        |
| :------------------ | :-------------- | :------: | :--------------------------------------------------------------------------------- |
| `PUBLIC_IP`         | -               |   Yes    | Used to establish WebRTC connections to the server.                                |
| `AUTH_KEY`          | -               |   Yes    | The base64 encoded encryption key used for JWT authentication.                     |
| `HTTP_INTERFACE`    | `0.0.0.0`       |    No    | HTTP and WebSocket listening interface.                                            |
| `PORT`              | `8070`          |    No    | Port for HTTP and WebSocket.                                                       |
| `RTC_INTERFACE`     | `0.0.0.0`       |    No    | Interface address for RTC.                                                         |
| `PROXY`             | `false`         |    No    | Set to true if behind a proxy to trust forwarding headers.                         |
| `AUDIO_CODECS`      | All             |    No    | Comma separated list of audio codecs to use (e.g., `opus,PCMU,PCMA`).              |
| `VIDEO_CODECS`      | All             |    No    | Comma separated list of video codecs to use (e.g., `VP8,H264,VP9`).                |
| `RTC_MIN_PORT`      | `40000`         |    No    | Lower bound for the range of ports used by the RTC server (TCP/UDP).               |
| `RTC_MAX_PORT`      | `49999`         |    No    | Upper bound for the range of ports used by the RTC server (TCP/UDP).               |
| `NUM_WORKERS`       | CPU count       |    No    | Number of mediasoup workers to spawn.                                              |
| `MAX_BUF_IN`        | `0` (unlimited) |    No    | Maximum incoming buffer size in bytes for SCTP messages per session.               |
| `MAX_BUF_OUT`       | `0` (unlimited) |    No    | Maximum outgoing buffer size in bytes for SCTP messages per session.               |
| `MAX_BITRATE_IN`    | `8000000`       |    No    | Maximum incoming bitrate in bps per session (upload).                              |
| `MAX_BITRATE_OUT`   | `10000000`      |    No    | Maximum outgoing bitrate in bps per session (download).                            |
| `MAX_VIDEO_BITRATE` | `4000000`       |    No    | Maximum bitrate in bps for the highest simulcast video layer.                      |
| `CHANNEL_SIZE`      | `100`           |    No    | Maximum amount of concurrent users per channel.                                    |
| `LOG_LEVEL`         | `error`         |    No    | SFU log level (`none`, `error`, `warn`, `info`, `debug`, `verbose`).               |
| `LOG_TIMESTAMP`     | `true`          |    No    | Prefix timestamps to log lines.                                                    |
| `LOG_COLOR`         | TTY detection   |    No    | Colors log lines based on their level.                                             |
| `DEBUG`             | -               |    No    | Used by the [debug](https://www.npmjs.com/package/debug) module (e.g., `DEBUG=*`). |
| `WORKER_LOG_LEVEL`  | `none`          |    No    | Mediasoup worker log level. Requires `DEBUG` to be active.                         |
| `DATA_PATH`         | `/tmp/odoo_sfu` |    No    | Base path for SFU local storage (`recordings`, `resources`, `debug` subfolders).   |


Recording specific env variables:

| Variable                                | Default            | Required | Description                                                                                                            |
| :-------------------------------------- | :----------------- | :------: | :--------------------------------------------------------------------------------------------------------------------- |
| `RECORDING`                             | `false`            |    No    | Enables the recording feature.                                                                                         |
| `LOCAL_KEY`                             | Randomly generated |    No    | 32-byte base64 key for encrypting local data. If missing, data loses persistence between restarts.                     |
| `DYNAMIC_MIN_PORT` / `DYNAMIC_MAX_PORT` | `50000` / `59999`  |    No    | Range of ports used for recording routing.                                                                             |
| `KEEP_RECORDINGS`                       | `false`            |    No    | If true, keeps raw recording files after they are uploaded.                                                            |
| `FFMPEG_LOGGING`                        | `false`            |    No    | If true, generates `.log` files alongside ffmpeg outputs and archives processed recordings under `${DATA_PATH}/debug`. |

See [config.js](./src/config.js) for more details.

## Binding the SFU and the Odoo server together

### On the SFU
Set the `AUTH_KEY` env variable with  the base64 encryption key that can be used to authenticate connections to the server.

### On Odoo 
Go to the Discuss settings and configure the `RTC Server URL` and `RTC server KEY` fields. The `RTC server KEY`
must be the same base64 encoded string as `AUTH_KEY` on the SFU server. Or pass the as env variables (`ODOO_SFU_URL` and `ODOO_SFU_KEY`).

## Inter-process communication with the SFU server

The SFU server responds to the following IPC signals:

- `SIGFPE(8)`: Restarts the server.
- `SIGALRM(14)`: Initiates a soft reset by closing all sessions, but keeps services alive.
- `SIGIO(29)`: Prints server statistics, such as the number of channels, sessions, bitrate.

See [server.js](./src/server.js) for more details.

## Documentation

- [Architecture](./doc/architecture.md)
- [Full Network Flow](./doc/network_flow.md)
- [HTTP API](./doc/http.md)
- [Recording](./doc/recording.md)
- [Client API bundle](./doc/client.md)

// TODO maybe a section for dev (testing, profiling,...),
already written a bit at https://www.odoo.com/odoo/knowledge/46743 so
could unify
