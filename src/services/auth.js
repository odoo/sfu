import jwt from "jsonwebtoken";

import * as config from "#src/config.js";
import { Logger } from "#src/utils/utils.js";
import { AuthenticationError } from "#src/utils/errors.js";

let jwtKey;
const logger = new Logger("AUTH");

/**
 * @param {WithImplicitCoercion<string>} [key] buffer/b64 str
 */
export async function start(key) {
    const keyB64str = key || config.AUTH_KEY;
    jwtKey = Buffer.from(keyB64str, "base64");
    logger.info(`auth key set`);
}

export function close() {
    jwtKey = undefined;
}

/**
 * @param {string} jsonWebToken
 * @param {WithImplicitCoercion<string>} [key] buffer/b64 str
 * @returns {Promise<any>} json serialized data
 * @throws {AuthenticationError}
 */
export async function verify(jsonWebToken, key = jwtKey) {
    try {
        return jwt.verify(jsonWebToken, key, {
            algorithms: ["HS256"],
        });
    } catch {
        throw new AuthenticationError("JsonWebToken verification error");
    }
}
