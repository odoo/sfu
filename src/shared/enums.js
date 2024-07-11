// separate file to avoid circular dependencies or increasing bundle size (despite tree shaking)
// it also allows documentation to be shared between client and server

export const WS_CLOSE_CODE = {
    CLEAN: 1000,
    LEAVING: 1001,
    ERROR: 1011,
    // 4000-4999 range available for app specific use
    AUTHENTICATION_FAILED: 4106,
    TIMEOUT: 4107,
    KICKED: 4108,
    CHANNEL_FULL: 4109,
};

export const SERVER_REQUEST = {
    /** Requests the creation of a consumer that is used to forward a track to the client */
    INIT_CONSUMER: "INIT_CONSUMER",
    /** Requests the creation of upload and download transports */
    INIT_TRANSPORTS: "INIT_TRANSPORTS",
    /** Requests any response to keep the session alive */
    PING: "PING",
};

export const SERVER_MESSAGE = {
    /** Signals that the server wants to send a message to all the other members of that channel */
    BROADCAST: "BROADCAST",
    /** Signals the clients that one of the session in their channel has left. */
    SESSION_LEAVE: "SESSION_LEAVE",
    /**  Signals the clients that the info (talking, mute,...) of one of the session in their channel has changed. */
    INFO_CHANGE: "S_INFO_CHANGE",
};

export const CLIENT_REQUEST = {
    /** Requests the server to connect the client-to-server transport, this occurs the first time a producer is added to this transport */
    CONNECT_CTS_TRANSPORT: "CONNECT_CTS_TRANSPORT",
    /** Requests the server to connect the server-to-client transport, this occurs the first time a consumer is added to this transport */
    CONNECT_STC_TRANSPORT: "CONNECT_STC_TRANSPORT",
    /** Requests the creation of a consumer that is used to upload a track to the server */
    INIT_PRODUCER: "INIT_PRODUCER",
};

export const CLIENT_MESSAGE = {
    /** Signals that the client wants to send a message to all the other members of that channel */
    BROADCAST: "BROADCAST",
    /** Signals that the client wants to change how it consumes a track (like pausing or ending the download) */
    CONSUMPTION_CHANGE: "CONSUMPTION_CHANGE",
    /** Signals that the info (talking, mute,...) of this client has changed. */
    INFO_CHANGE: "C_INFO_CHANGE",
    /** Signals that the client wants to change how it produces a track (like pausing or ending the upload) */
    PRODUCTION_CHANGE: "PRODUCTION_CHANGE",
};
