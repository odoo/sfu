import fs from "node:fs/promises";
import { createReadStream } from "node:fs";

import * as config from "#src/config.ts";
import { sign } from "#src/core/services/auth.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

type RoutingResponse = {
    destination: string;
    method?: string;
    headers?: Record<string, string>;
    response_status?: number;
};

const logger = new Logger("MEDIA_UPLOADER");
const MAX_ROUTING_RESPONSE_BYTES = 64 * 1024;

export class MediaUploader {
    private readonly _routingTimeoutMs: number;
    private readonly _uploadTimeoutMs: number;

    constructor({
        routingTimeoutMs,
        uploadTimeoutMs
    }: {
        routingTimeoutMs: number;
        uploadTimeoutMs: number;
    }) {
        this._routingTimeoutMs = routingTimeoutMs;
        this._uploadTimeoutMs = uploadTimeoutMs;
    }

    async transcribe({ filePath, metadata }: { filePath: string; metadata: SealedMetaData }) {
        const fileStats = await fs.stat(filePath);
        const queryParams = ["start_ms=" + metadata.startedAt, "end_ms=" + metadata.stoppedAt];
        const response = await this._fetchWithTimeout(
            `${metadata.routingAddress}/transcribe?${queryParams.join("&")}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this._makeJwt(metadata.channelKey)}`,
                    "Content-Type": config.recording.audio.mimeType,
                    "Content-Length": fileStats.size.toString()
                },
                // FIXME remove linter error suppression
                // @ts-expect-error: Node fetch supports ReadStream
                // The reason is that the current tsconfig uses both ES2024 and DOM
                // because part of the SFU codebase runs on the client (client.ts)
                // this causes the linter to treat this fetch as a client fetch
                // it could probably fixed with some tsconfig compositing trickery
                // that takes client.ts, tests and shared files into account
                body: createReadStream(filePath),
                duplex: "half"
            },
            this._uploadTimeoutMs
        );
        await this._discardResponse(
            response,
            `Failed to upload audio to ${metadata.routingAddress}`
        );
    }

    async uploadMedia({
        filePath,
        metadata,
        mimetype
    }: {
        filePath: string;
        metadata: SealedMetaData;
        mimetype: string;
    }) {
        logger.info(`Uploading ${filePath} to ${metadata.routingAddress}`);
        const params = new URLSearchParams({
            start_ms: String(metadata.startedAt),
            end_ms: String(metadata.stoppedAt),
            mimetype
        });
        const response = await this._fetchWithTimeout(
            `${metadata.routingAddress}/routing?${params}`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${this._makeJwt(metadata.channelKey)}`
                }
            },
            this._routingTimeoutMs
        );
        const jsonResponse = JSON.parse(
            await this._readRoutingResponse(
                response,
                `Failed to obtain routing from ${metadata.routingAddress}`
            )
        ) as RoutingResponse;
        if (!jsonResponse.destination) {
            throw new Error(`No upload destination returned by ${metadata.routingAddress}/routing`);
        }
        const fileStats = await fs.stat(filePath);
        const uploadResponse = await this._fetchWithTimeout(
            jsonResponse.destination,
            {
                method: jsonResponse.method ?? "POST",
                headers: {
                    "Content-Type": mimetype,
                    ...jsonResponse.headers,
                    "Content-Length": fileStats.size.toString()
                },
                // @ts-expect-error: same as above
                body: createReadStream(filePath),
                duplex: "half"
            },
            this._uploadTimeoutMs
        );
        await this._discardResponse(
            uploadResponse,
            `Failed to upload files to ${metadata.routingAddress}`,
            jsonResponse.response_status
        );
    }

    private _makeJwt(key: string) {
        const nowSeconds = Date.now() / 1000;
        return sign(
            {
                exp: nowSeconds + 120,
                iat: nowSeconds
            },
            key
        );
    }

    private async _checkResponse(
        response: Response,
        errorMessage: string,
        expectedStatus?: number
    ) {
        if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`${errorMessage}: ${response.status} ${response.statusText}`);
        }
    }

    private async _discardResponse(
        response: Response,
        errorMessage: string,
        expectedStatus?: number
    ) {
        await this._checkResponse(response, errorMessage, expectedStatus);
        await response.body?.cancel().catch(() => undefined);
    }

    private async _readRoutingResponse(response: Response, errorMessage: string) {
        await this._checkResponse(response, errorMessage);
        const reader = response.body?.getReader();
        if (!reader) {
            return response.text();
        }
        const decoder = new TextDecoder();
        let body = "";
        let receivedBytes = 0;
        try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                const { value } = chunk;
                receivedBytes += value.byteLength;
                if (receivedBytes > MAX_ROUTING_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    throw new Error(`Routing response exceeds ${MAX_ROUTING_RESPONSE_BYTES} bytes`);
                }
                body += decoder.decode(value, { stream: true });
            }
            return body + decoder.decode();
        } finally {
            reader.releaseLock();
        }
    }

    private _fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
        return fetch(url, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs)
        });
    }
}
