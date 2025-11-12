export type JSONSerializable =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JSONSerializable }
    | JSONSerializable[];

export type StreamType = "audio" | "camera" | "screen";

export type StringLike = Buffer | string;

export type StartupData = {
    availableFeatures: AvailableFeatures;
    isRecording: boolean;
};
export type AvailableFeatures = {
    rtc: boolean;
    recording: boolean;
};

import type { DownloadStates } from "#src/client.ts";
import type { SessionId, SessionInfo, TransportConfig } from "#src/models/session.ts";

import type {
    DtlsParameters,
    MediaKind,
    ProducerOptions,
    RtpCapabilities,
    RtpParameters
    // eslint-disable-next-line node/no-unpublished-import
} from "mediasoup-client/lib/types";
import type { CLIENT_MESSAGE, CLIENT_REQUEST, SERVER_MESSAGE, SERVER_REQUEST } from "./enums";

export type BusMessage =
    | { name: typeof CLIENT_MESSAGE.BROADCAST; payload: JSONSerializable }
    | {
          name: typeof CLIENT_MESSAGE.CONSUMPTION_CHANGE;
          payload: { sessionId: SessionId; states: DownloadStates };
      }
    | {
          name: typeof CLIENT_MESSAGE.INFO_CHANGE;
          payload: { info: SessionInfo; needRefresh?: boolean };
      }
    | {
          name: typeof CLIENT_MESSAGE.PRODUCTION_CHANGE;
          payload: { type: StreamType; active: boolean };
      }
    | {
          name: typeof CLIENT_REQUEST.CONNECT_CTS_TRANSPORT;
          payload: { dtlsParameters: DtlsParameters };
      }
    | {
          name: typeof CLIENT_REQUEST.CONNECT_STC_TRANSPORT;
          payload: { dtlsParameters: DtlsParameters };
      }
    | {
          name: typeof CLIENT_REQUEST.INIT_PRODUCER;
          payload: { type: StreamType; kind: MediaKind; rtpParameters: RtpParameters };
      }
    | { name: typeof CLIENT_REQUEST.START_RECORDING; payload?: never }
    | { name: typeof CLIENT_REQUEST.STOP_RECORDING; payload?: never }
    | {
          name: typeof SERVER_MESSAGE.BROADCAST;
          payload: { senderId: SessionId; message: JSONSerializable };
      }
    | { name: typeof SERVER_MESSAGE.SESSION_LEAVE; payload: { sessionId: SessionId } }
    | { name: typeof SERVER_MESSAGE.INFO_CHANGE; payload: Record<SessionId, SessionInfo> }
    | {
          name: typeof SERVER_MESSAGE.CHANNEL_INFO_CHANGE;
          payload: { isRecording: boolean; isTranscribing: boolean };
      }
    | {
          name: typeof SERVER_REQUEST.INIT_CONSUMER;
          payload: {
              id: string;
              kind: MediaKind;
              producerId: string;
              rtpParameters: RtpParameters;
              sessionId: SessionId;
              active: boolean;
              type: StreamType;
          };
      }
    | {
          name: typeof SERVER_REQUEST.INIT_TRANSPORTS;
          payload: {
              capabilities: RtpCapabilities;
              stcConfig: TransportConfig;
              ctsConfig: TransportConfig;
              producerOptionsByKind: Record<MediaKind, ProducerOptions>;
          };
      }
    | { name: typeof SERVER_REQUEST.PING; payload?: never };

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
