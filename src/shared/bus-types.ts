// eslint-disable-next-line node/no-unpublished-import
import type { RtpCapabilities } from "mediasoup-client/lib/types";
import type { CLIENT_REQUEST, SERVER_REQUEST } from "./enums";
import type { BusMessage } from "./types";

export interface RequestMap {
    [CLIENT_REQUEST.CONNECT_CTS_TRANSPORT]: void;
    [CLIENT_REQUEST.CONNECT_STC_TRANSPORT]: void;
    [CLIENT_REQUEST.INIT_PRODUCER]: { id: string };
    [CLIENT_REQUEST.START_RECORDING]: boolean;
    [CLIENT_REQUEST.STOP_RECORDING]: boolean;
    [SERVER_REQUEST.INIT_CONSUMER]: void;
    [SERVER_REQUEST.INIT_TRANSPORTS]: RtpCapabilities;
    [SERVER_REQUEST.PING]: void;
}

export type RequestName = keyof RequestMap;

export type RequestMessage<T extends RequestName = RequestName> = Extract<BusMessage, { name: T }>;

export type ResponseFrom<T extends RequestName> = RequestMap[T];
