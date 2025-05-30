export type JSONSerializable =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JSONSerializable }
    | JSONSerializable[];

export type StreamType = "audio" | "camera" | "screen";
