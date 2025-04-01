import crypto from "node:crypto";

import * as config from "#src/config.js";
import { Logger } from "#src/utils/utils.js";
import { AuthenticationError } from "#src/utils/errors.js";

/**
 * JsonWebToken header
 * https://datatracker.ietf.org/doc/html/rfc7519#section-5
 *
 * @typedef {Object} JWTHeader
 * @property {string} alg - Algorithm used to sign the token
 * @property {string} typ - Type of the token, usually "JWT"
 */

/**
 * @typeDef {Object} PrivateJWTClaims
 * @property {string} sfu_channel_uuid
 * @property {number} session_id
 * @property {Object[]} ice_servers
 */

/**
 * JsonWebToken claims
 * https://datatracker.ietf.org/doc/html/rfc7519#section-4
 *
 * @typedef {PrivateJWTClaims & Object} JWTClaims
 * @property {number} [exp] - Expiration time (in seconds since epoch)
 * @property {number} [iat] - Issued at (in seconds since epoch)
 * @property {number} [nbf] - Not before (in seconds since epoch)
 * @property {string} [iss] - Issuer
 * @property {string} [sub] - Subject
 * @property {string} [aud] - Audience
 * @property {string} [jti] - JWT ID
 */

let jwtKey;
const logger = new Logger("AUTH");
const ALGORITHM = {
    HS256: "HS256",
};
const ALGORITHM_FUNCTIONS = {
    [ALGORITHM.HS256]: (data, key) => crypto.createHmac("sha256", key).update(data).digest(),
};

/**
 * @param {WithImplicitCoercion<string>} [key] buffer/b64 str
 */
export function start(key) {
    const keyB64str = key || config.AUTH_KEY;
    jwtKey = Buffer.from(keyB64str, "base64");
    logger.info(`auth key set`);
}

export function close() {
    jwtKey = undefined;
}

/**
 * @param {Buffer|string} data - The data to encode
 * @returns {string} - base64 encoded string
 */
export function base64Encode(data) {
    if (typeof data === "string") {
        data = Buffer.from(data);
    }
    return data.toString("base64");
}

/**
 * @param {string} str base64 encoded string
 * @returns {Buffer}
 */
function base64Decode(str) {
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
 * @param {JWTClaims} claims - The claims to include in the token
 * @param {WithImplicitCoercion<string>} [key] - Optional key, defaults to the configured jwtKey
 * @param {Object} [options]
 * @param {string} [options.algorithm] - The algorithm to use, defaults to HS256
 * @returns {string} - The signed JsonWebToken
 * @throws {AuthenticationError}
 */
export function sign(claims, key = jwtKey, { algorithm = ALGORITHM.HS256 } = {}) {
    if (!key) {
        throw new AuthenticationError("JWT signing key is not set");
    }
    const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    const headerB64 = base64Encode(JSON.stringify({ alg: algorithm, typ: "JWT" }));
    const claimsB64 = base64Encode(JSON.stringify(claims));
    const signedData = `${headerB64}.${claimsB64}`;
    const signature = ALGORITHM_FUNCTIONS[algorithm]?.(signedData, keyBuffer);
    if (!signature) {
        throw new AuthenticationError(`Unsupported algorithm: ${algorithm}`);
    }
    const signatureB64 = base64Encode(signature);
    return `${headerB64}.${claimsB64}.${signatureB64}`;
}

/**
 * Parses a JsonWebToken into its components
 *
 * @param {string} token
 * @returns {{header: JWTHeader, claims: JWTClaims, signature: Buffer, signedData: string}}
 */
function parseJwt(token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new AuthenticationError("Invalid JWT format");
    }
    const [headerB64, claimsB64, signatureB64] = parts;
    const header = JSON.parse(base64Decode(headerB64).toString());
    const claims = JSON.parse(base64Decode(claimsB64).toString());
    const signature = base64Decode(signatureB64);
    const signedData = `${headerB64}.${claimsB64}`;

    return { header, claims, signature, signedData };
}

function safeEqual(a, b) {
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
 * @param {string} jsonWebToken
 * @param {WithImplicitCoercion<string>} [key] buffer/b64 str
 * @returns {JWTClaims} claims
 * @throws {AuthenticationError}
 */
export function verify(jsonWebToken, key = jwtKey) {
    const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, "base64");
    let parsedJWT;
    try {
        parsedJWT = parseJwt(jsonWebToken);
    } catch {
        throw new AuthenticationError("Invalid JWT format");
    }
    const { header, claims, signature, signedData } = parsedJWT;
    const expectedSignature = ALGORITHM_FUNCTIONS[header.alg]?.(signedData, keyBuffer);
    if (!expectedSignature) {
        throw new AuthenticationError(`Unsupported algorithm: ${header.alg}`);
    }
    if (!safeEqual(signature, expectedSignature)) {
        throw new AuthenticationError("Invalid signature");
    }
    // `exp`, `iat` and `nbf` are in seconds (`NumericDate` per RFC7519)
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
