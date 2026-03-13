import fs from "node:fs/promises";
import { createReadStream } from "node:fs";

import * as config from "#src/config.ts";
import { sign } from "#src/core/services/auth.ts";
import type { SealedMetaData } from "#src/recording/models/recorder.ts";
import { Logger } from "#src/utils/utils.ts";

type RoutingResponse = {
    destination: string;
};

const logger = new Logger("MEDIA_UPLOADER");

export class MediaUploader {
    private readonly _requestTimeoutMs: number;

    constructor({ requestTimeoutMs }: { requestTimeoutMs: number }) {
        this._requestTimeoutMs = requestTimeoutMs;
    }

    async uploadAudio({
        filePath,
        metadata,
        mainMedia
    }: {
        filePath: string;
        metadata: SealedMetaData;
        mainMedia: boolean;
    }) {
        const fileStats = await fs.stat(filePath);
        const queryParams = ["start=" + metadata.startedAt, "end=" + metadata.stoppedAt];
        if (metadata.transcription) {
            queryParams.push("transcribe=True");
        }
        if (mainMedia) {
            queryParams.push("main_media=True");
        }
        const paramString = queryParams.length ? "?" + queryParams.join("&") : "";
        const response = await this._fetchWithTimeout(
            `${metadata.routingAddress}/audio${paramString}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this._makeJwt(metadata.channelKey)}`,
                    "Content-Type": `audio/${config.recording.audio.ext}`,
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
            }
        );
        if (!response.ok) {
            throw new Error(
                `Failed to upload audio to ${metadata.routingAddress}: ${response.status} ${response.statusText}`
            );
        }
        return await response.text();
    }

    async uploadVideo({ filePath, metadata }: { filePath: string; metadata: SealedMetaData }) {
        logger.debug(`Uploading files to ${metadata.routingAddress}`);
        const response = await this._fetchWithTimeout(`${metadata.routingAddress}/routing`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${this._makeJwt(metadata.channelKey)}`
            }
        });
        if (!response.ok) {
            throw new Error(
                `Failed to obtain routing from ${metadata.routingAddress}: ${response.status} ${response.statusText}`
            );
        }
        const jsonResponse = (await response.json()) as RoutingResponse;
        if (!jsonResponse.destination) {
            logger.warn(`No upload destination returned by ${metadata.routingAddress}/routing`);
            return;
        }
        const fileStats = await fs.stat(filePath);
        const uploadResponse = await this._fetchWithTimeout(jsonResponse.destination, {
            method: "POST",
            headers: {
                "Content-Type": `video/${config.recording.video.ext}`,
                "Content-Length": fileStats.size.toString()
            },
            // @ts-expect-error: same as above
            body: createReadStream(filePath),
            duplex: "half"
        });
        if (!uploadResponse.ok) {
            throw new Error(
                `Failed to upload files to ${metadata.routingAddress}: ${uploadResponse.status} ${uploadResponse.statusText}`
            );
        }
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

    private async _fetchWithTimeout(url: string, init: RequestInit = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this._requestTimeoutMs);
        try {
            return await fetch(url, {
                ...init,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }
}
