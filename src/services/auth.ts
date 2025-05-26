import crypto from "node:crypto";

import * as config from "#src/config.ts";
import { Logger } from "#src/utils/utils.ts";
import { AuthenticationError } from "#src/utils/errors.ts";
import type { SessionId } from "#src/models/session.ts";

/**
 * JsonWebToken (JOSE) header
 * @see https://datatracker.ietf.org/doc/html/rfc7519#section-5
 */
interface JWTHeader {
    /** Algorithm used to sign the token */
    alg: string;
    /** Type of the token, usually "JWT" */
    typ: string;
}
/**
 * JsonWebToken claims
 * @see https://datatracker.ietf.org/doc/html/rfc7519#section-4
 */
interface RegisteredJWTClaims {
    /** Expiration time (in seconds since epoch) */
    exp?: number;
    /** Issued at (in seconds since epoch) */
    iat?: number;
    /** Not before (in seconds since epoch) */
    nbf?: number;
    /** Issuer */
    iss?: string;
    /** Subject */
    sub?: string;
    /** Audience */
    aud?: string;
    /** JWT ID */
    jti?: string;
}
/**
 * Private JWT claims specific to the SFU
 */
interface PrivateJWTClaims {
    sfu_channel_uuid?: string;
    session_id?: SessionId;
    ice_servers?: object[];
    sessionIdsByChannel?: Record<string, SessionId[]>;
    /** If provided when requesting a channel, this key will be used instead of the global key to verify JWTs related to this channel */
    key?: string;
}
export type JWTClaims = RegisteredJWTClaims & PrivateJWTClaims;

interface ParsedJWT {
    /** JWT header */
    header: JWTHeader;
    /** JWT claims/payload */
    claims: JWTClaims;
    /** Signature buffer */
    signature: Buffer;
    /** Data that was signed (header.payload) */
    signedData: string;
}
/**
 * JWT signing options
 */
interface SignOptions {
    /** Algorithm to use for signing */
    algorithm?: ALGORITHM;
}
/**
 * Supported signing algorithms
 */
export enum ALGORITHM {
    HS256 = "HS256"
}

/**
 * Algorithm implementation functions
 */
const ALGORITHM_FUNCTIONS: Record<ALGORITHM, (data: string, key: Buffer) => Buffer> = {
    [ALGORITHM.HS256]: (data: string, key: Buffer) =>
        crypto.createHmac("sha256", key).update(data).digest()
};

let jwtKey: Buffer | undefined;
const logger = new Logger("AUTH");

export function start(key?: string | Buffer): void {
    const keyB64str = key || config.AUTH_KEY;
    if (!keyB64str) {
        throw new Error("AUTH_KEY is required for authentication service");
    }

    jwtKey = Buffer.isBuffer(keyB64str) ? keyB64str : Buffer.from(keyB64str, "base64");
    logger.info("auth key set");
}

export function close(): void {
    jwtKey = undefined;
}

export function base64Encode(data: Buffer | string): string {
    if (typeof data === "string") {
        data = Buffer.from(data);
    }
    return data.toString("base64");
}

function base64Decode(str: string): Buffer {
    let output = str;
    const paddingLength = 4 - (output.length % 4);
    if (paddingLength < 4) {
        output += "=".repeat(paddingLength);
    }
    return Buffer.from(output, "base64");
}

/**
 * Signs and creates a JsonWebToken
 *
 * @param claims - The claims to include in the token
 * @param key - Optional key, defaults to the configured jwtKey
 * @param options - Signing options
 * @returns The signed JsonWebToken
 * @throws {AuthenticationError} If signing fails
 */
export function sign(
    claims: JWTClaims,
    key: Buffer | string = jwtKey!,
    options: SignOptions = {}
): string {
    const { algorithm = ALGORITHM.HS256 } = options;

    if (!key) {
        throw new AuthenticationError("JWT signing key is not set");
    }
    const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    const header: JWTHeader = { alg: algorithm, typ: "JWT" };
    const headerB64 = base64Encode(JSON.stringify(header));
    const claimsB64 = base64Encode(JSON.stringify(claims));
    const signedData = `${headerB64}.${claimsB64}`;
    const algorithmFunction = ALGORITHM_FUNCTIONS[algorithm];
    if (!algorithmFunction) {
        throw new AuthenticationError(`Unsupported algorithm: ${algorithm}`);
    }
    const signature = algorithmFunction(signedData, keyBuffer);
    const signatureB64 = base64Encode(signature);
    return `${headerB64}.${claimsB64}.${signatureB64}`;
}

/**
 * @throws {AuthenticationError} If token format is invalid
 */
function parseJwt(token: string): ParsedJWT {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new AuthenticationError("Invalid JWT format");
    }
    const [headerB64, claimsB64, signatureB64] = parts;
    try {
        const header = JSON.parse(base64Decode(headerB64).toString()) as JWTHeader;
        const claims = JSON.parse(base64Decode(claimsB64).toString()) as JWTClaims;
        const signature = base64Decode(signatureB64);
        const signedData = `${headerB64}.${claimsB64}`;
        return { header, claims, signature, signedData };
    } catch {
        throw new AuthenticationError("Invalid JWT format");
    }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

/**
 * @throws {AuthenticationError} If verification fails
 */
export function verify(jsonWebToken: string, key: Buffer | string = jwtKey!): JWTClaims {
    if (!key) {
        throw new AuthenticationError("JWT verification key is not set");
    }
    const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    let parsedJWT: ParsedJWT;
    try {
        parsedJWT = parseJwt(jsonWebToken);
    } catch {
        throw new AuthenticationError("Invalid JWT format");
    }
    const { header, claims, signature, signedData } = parsedJWT;
    const algorithmFunction = ALGORITHM_FUNCTIONS[header.alg as ALGORITHM];
    if (!algorithmFunction) {
        throw new AuthenticationError(`Unsupported algorithm: ${header.alg}`);
    }
    const expectedSignature = algorithmFunction(signedData, keyBuffer);
    if (!safeEqual(signature, expectedSignature)) {
        throw new AuthenticationError("Invalid signature");
    }
    // Note: exp, iat, and nbf are in seconds (NumericDate per RFC7519)
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) {
        throw new AuthenticationError("Token expired");
    }
    if (claims.nbf && claims.nbf > now) {
        throw new AuthenticationError("Token not valid yet");
    }
    if (claims.iat && claims.iat > now + 60) {
        throw new AuthenticationError("Token issued in the future");
    }
    return claims;
}
