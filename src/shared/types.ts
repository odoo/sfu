export type JSONSerializable =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JSONSerializable }
    | JSONSerializable[];

export type StreamType = "audio" | "camera" | "screen";

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
import type { CLIENT_MESSAGE, CLIENT_REQUEST, SERVER_MESSAGE, SERVER_REQUEST } from "./enums.ts";

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
    | {
          name: typeof SERVER_MESSAGE.BROADCAST;
          payload: { senderId: SessionId; message: JSONSerializable };
      }
    | { name: typeof SERVER_MESSAGE.SESSION_LEAVE; payload: { sessionId: SessionId } }
    | { name: typeof SERVER_MESSAGE.INFO_CHANGE; payload: Record<SessionId, SessionInfo> }
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
