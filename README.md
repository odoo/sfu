# Odoo SFU

## Overview

Contains the code for the SFU (Selective Forwarding Unit) server 
used in [Odoo Discuss](https://www.odoo.com/app/discuss). The SFU server is responsible for handling the WebRTC connections
between users and providing channels to coordinate these connections.

The server is not stand-alone, it does not serve any HTML or any interface code for calls. It only contains
the SFU and a [client bundle/library](#client-api-bundle) to connect to it.

The SFU is powered by the [Mediasoup](https://mediasoup.org/) WebRTC library.

## Prerequisites
- [Node.js 22.16.0 (LTS)](https://nodejs.org/en/download)
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
        npm PROXY=1 PUBLIC_IP=134.123.222.111 AUTH_KEY=u6bsUQEWrHdKIuYplirRnbBmLbrKV5PxKG7DtA71mng= run start
    ```

The available environment variables are:

- **PUBLIC_IP** (required): used to establish webRTC connections to the server
- **AUTH_KEY** (required): the base64 encoded encryption key used for authentication
- **HTTP_INTERFACE**:  HTTP/WS interface, defaults to "0.0.0.0" (listen on all interfaces)
- **PORT**: port for HTTP/WS, defaults to standard ports
- **RTC_INTERFACE**: Interface address for RTC, defaults to "0.0.0.0"
- **PROXY**: set if behind a proxy, the proxy must properly implement "x-forwarded-for", "x-forwarded-proto" and "x-forwarded-host"
- **AUDIO_CODECS**: comma separated list of audio codecs to use, default to all available
- **VIDEO_CODECS**: comma separated list of video codecs to use, default to all available
- **RTC_MIN_PORT**: Lower bound for the range of ports used by the RTC server, must be open in both TCP and UDP
- **RTC_MAX_PORT**: Upper bound for the range of ports used by the RTC server, must be open in both TCP and UDP
- **MAX_BUF_IN**: if set, limits the incoming buffer size per session (user)
- **MAX_BUF_OUT**: if set, limits the outgoing buffer size per session (user)
- **MAX_BITRATE_IN**: if set, limits the incoming bitrate per session (user), defaults to 8mbps
- **MAX_BITRATE_OUT**: if set, limits the outgoing bitrate per session (user), defaults to 10mbps
- **MAX_VIDEO_BITRATE**: if set, defines the `maxBitrate` of the highest encoding layer (simulcast), defaults to 4mbps
- **CHANNEL_SIZE**: the maximum amount of users per channel, defaults to 100
- **RECORDING**: enables the recording feature, defaults to false
- **RECORDING_PATH**: the path where the recordings will be saved, defaults to `${tmpDir}/recordings`.
- **WORKER_LOG_LEVEL**: "none" | "error" | "warn" | "debug", will only work if `DEBUG` is properly set.
- **LOG_LEVEL**: "none" | "error" | "warn" | "info" | "debug" | "verbose"
- **LOG_TIMESTAMP**: adds a timestamp to the log lines, defaults to true, to disable it, set to "disable", "false", "none", "no" or "0"
- **LOG_COLOR**: If set, colors the log lines based on their level
- **DEBUG**: an env variable used by the [debug](https://www.npmjs.com/package/debug) module. e.g.: `DEBUG=*`, `DEBUG=mediasoup*`


See [config.js](./src/config.js) for more details and examples.

## Binding the SFU and the Odoo server together

### On the SFU
Set the `AUTH_KEY` env variable with  the base64 encryption key that can be used to authenticate connections to the server.

### On Odoo 
Go to the Discuss settings and configure the `RTC Server URL` and `RTC server KEY` fields. The `RTC server KEY`
must be the same base64 encoded string as `AUTH_KEY` on the SFU server.

## Inter-process communication with the SFU server

The SFU server responds to the following IPC signals:

- `SIGFPE(8)`: Restarts the server.
- `SIGALRM(14)`: Initiates a soft reset by closing all sessions, but keeps services alive.
- `SIGIO(29)`: Prints server statistics, such as the number of channels, sessions, bitrate.

See [server.js](./src/server.js) for more details.

## Documentation

- [Architecture](./doc/architecture.md)
- [HTTP API](./doc/http.md)
- [Recording](./doc/recording.md)
- [Client API bundle](./doc/client.md)
