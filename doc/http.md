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
- GET `/v1/channel`: create a channel and returns information required to connect to it in JSON:
   ```json
   {
      "uuid": "31dcc5dc-4d26-453e-9bca-ab1f5d268303",
      "url": "https://example-odoo-sfu.com"
  }
  ```

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
