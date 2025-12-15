# HTTP API
see [http.js](./src/services/http.js) for more details.

- GET `/v1/noop`: health check endpoint.
- GET `/v1/stats`: returns the server statistics as an array with one entry per channel, in JSON:
    ```json
    [
        {
            "createDate": "2023-10-25T04:57:45.453Z",
            "uuid": "86079c25-9cf8-4d58-9dea-cef44cf845e2",
            "remoteAddress": "whoever-requested-the-room.com",
            "sessionsStats": {
                "incomingBitRate": {
                    "audio": 5,
                    "camera": 700000,
                    "screen": 0,
                    "total": 700005
                    },
                "count": 3,
                "cameraCount": 2,
                "screenCount": 0
            },
            "webRtcEnabled": true
        }
    ]
    ```
- GET `/v1/channel`: Creates or retrieves a channel for hosting an RTC conference.

    ### Headers
    - `Authorization: Bearer <JWT>` (**Required**)
        - The JWT must contain an `iss` (issuer) claim.
        - **Idempotency**: The `iss` claim identifies the caller and ensures that subsequent requests with the same issuer return the same channel. To create multiple distinct channels, the caller must provide unique `iss` values.
        - **JWT Claims**:
            - `iss` (string, required): Format is typically `domain` or `domain::unique_id`.
            - `key` (string, optional): A private key used for specific channel operations/verification (if not provided, authentication will be using the global key).

    ### Query Parameters
    - `webRTC` (string, optional): Defaults to `"true"`.
        - Set to `"false"` to create a signaling-only channel without WebRTC media capabilities.
    - `recordingAddress` (string, optional):
        - If provided, enables recording for the channel.
        - Specifies the HTTP endpoint that the SFU can contact for the routing of the recording.

    ### Response
    Returns a JSON object containing the channel details:
    ```json
    {
        "uuid": "31dcc5dc-4d26-453e-9bca-ab1f5d268303",
        "url": "https://example-odoo-sfu.com"
    }
    ```
    - `uuid`: The unique identifier of the channel.
    - `url`: The base URL of the SFU server, used for WebSocket connections.

- POST `/v1/disconnect` disconnects sessions, expects the body to be a Json Web Token formed as such:
    ```js
  jwt.sign(
    {
      "sessionIdsByChannel": {
        [channelUUID]: [sessionId1, sessionId2]
      }
    },
    "HS256",
  );
    ```
