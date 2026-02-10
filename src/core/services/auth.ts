import crypto from "node:crypto";

import * as config from "#src/config.ts";
import { Logger, b64toBuffer } from "#src/utils/utils.ts";
import { AuthenticationError } from "#src/utils/errors.ts";
import type { StringLike } from "#src/shared/types.ts";

/**
 * JsonWebToken (JOSE) header
 * @see https://datatracker.ietf.org/doc/html/rfc7519#section-5
 */
type JWTHeader = {
    /** Algorithm used to sign the token */
    alg: string;
    /** Type of the token, usually "JWT" */
    typ: string;
};
/**
 * JsonWebToken claims
 * @see https://datatracker.ietf.org/doc/html/rfc7519#section-4
 */
export type JWTClaims = {
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
};

type ParsedJWT<T> = {
    /** JWT header */
    header: JWTHeader;
    /** JWT claims/payload */
    claims: JWTClaims & T;
    /** Signature buffer */
    signature: Buffer;
    /** Data that was signed (header.payload) */
    signedData: string;
};
/**
 * JWT signing options
 */
type SignOptions = {
    /** Algorithm to use for signing */
    algorithm?: ALGORITHM;
};
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
let localKey: Buffer | undefined;
const logger = new Logger("AUTH");

export function start(key?: StringLike): void {
    const authKeyB64str = key || config.AUTH_KEY;
    if (!authKeyB64str) {
        throw new Error("AUTH_KEY is required for authentication service");
    }
    jwtKey = b64toBuffer(authKeyB64str);
    const localKeyB64str = config.LOCAL_KEY;
    if (localKeyB64str) {
        localKey = b64toBuffer(localKeyB64str);
        if (localKey.length !== 32) {
            throw new Error(
                `Invalid LOCAL_KEY length: ${localKey.length} bytes. It must be 32 bytes (256 bits) for AES-256-GCM.`
            );
        }
    } else {
        localKey = crypto.randomBytes(32);
        logger.warn("LOCAL_KEY is not set, generating a random key");
    }
    logger.info(
        `ready with ${jwtKey.length} bytes auth key and ${localKey.length} bytes encryption key`
    );
}

export function close(): void {
    jwtKey = undefined;
    localKey = undefined;
}

export function base64Encode(data: StringLike): string {
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
export function sign<T>(
    claims: JWTClaims & T,
    key: StringLike = jwtKey!,
    { algorithm = ALGORITHM.HS256 }: SignOptions = {}
): string {
    if (!key) {
        throw new AuthenticationError("JWT signing key is not set");
    }
    const keyBuffer = b64toBuffer(key);
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
function parseJwt<T>(token: string): ParsedJWT<T> {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new AuthenticationError("Invalid JWT format");
    }
    const [headerB64, claimsB64, signatureB64] = parts;
    try {
        const header = JSON.parse(base64Decode(headerB64).toString()) as JWTHeader;
        const claims = JSON.parse(base64Decode(claimsB64).toString()) as JWTClaims & T;
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
export function verify<T>(jsonWebToken: string, key: StringLike = jwtKey!): T & JWTClaims {
    if (!key) {
        throw new AuthenticationError("JWT verification key is not set");
    }
    const keyBuffer = b64toBuffer(key);
    let parsedJWT: ParsedJWT<T>;
    try {
        parsedJWT = parseJwt<T>(jsonWebToken);
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

/**
 * Encrypts a string using AES-256-GCM
 *
 * @param str The string to encrypt
 * @param key Must be a 32bytes Buffer
 */
export function encrypt(str: StringLike, key: Buffer = localKey!) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(str), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(str: StringLike, key: Buffer = localKey!) {
    if (Buffer.isBuffer(str)) {
        str = str.toString("utf-8");
    }
    const [ivHex, tagHex, encryptedHex] = str.split(":");
    if (ivHex === undefined || tagHex === undefined || encryptedHex === undefined) {
        throw new Error("Invalid encrypted format");
    }
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf-8");
}
