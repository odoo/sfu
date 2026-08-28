import crypto from "node:crypto";

import { describe, beforeEach, afterEach, expect } from "@jest/globals";

import * as auth from "#src/services/auth";
import { AuthenticationError } from "#src/utils/errors";

describe("Auth Service", () => {
    const testKey = "TEST2VjcmV0S2V5VGhhdElzMzJCeXRlc0xvbmdBdExldA==";
    const alternateKey = "TESTWx0ZXJuYXRlU2VjcmV0S2V5VGhhdElzMzJCeXRlcw==";
    const JWT_HEADER = { alg: "HS256", typ: "JWT" };
    const base64UrlSegment = /^[A-Za-z0-9_-]+$/;
    const THIRD_PARTY_TOKEN = {
        token: `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRhIjoidGhpcmQgcGFydHkiLCJleHAiOjQxMDI0NDQ4MDB9.qABdbUQwxY5MqEVPdqU_0YJVJPDjD-EbgcYIszBms5k`,
        key: testKey,
        payload: { data: "third party", exp: 4102444800 }
    };
    beforeEach(() => {
        auth.start(testKey);
    });
    afterEach(() => {
        auth.close();
    });
    function strictBase64UrlDecode(segment: string): Buffer {
        expect(segment).toMatch(base64UrlSegment);
        expect(segment).not.toContain("=");
        return Buffer.from(segment, "base64url");
    }
    function makeToken(header: unknown, claims: unknown): string {
        const headerSegment = auth.base64Encode(JSON.stringify(header));
        const claimsSegment = auth.base64Encode(JSON.stringify(claims));
        const signedData = `${headerSegment}.${claimsSegment}`;
        const signature = crypto
            .createHmac("sha256", Buffer.from(testKey, "base64"))
            .update(signedData)
            .digest("base64url");
        return `${signedData}.${signature}`;
    }
    test("should sign and verify a valid JWT", () => {
        const payload = {
            iss: "test-issuer",
            sub: "1234567890",
            channelUUID: "channel-123",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60
        };
        const token = auth.sign(payload);
        const result = auth.verify(token);
        expect(result).toEqual(payload);
    });
    test("should emit JWT segments accepted by a strict Base64url verifier", () => {
        const payload = {
            iss: "test-issuer",
            sub: "1234567890",
            data: "+/=",
            exp: Math.floor(Date.now() / 1000) + 60
        };
        const token = auth.sign(payload);
        const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
        const header = JSON.parse(strictBase64UrlDecode(headerSegment).toString());
        const decodedPayload = JSON.parse(strictBase64UrlDecode(payloadSegment).toString());
        const expectedSignature = crypto
            .createHmac("sha256", Buffer.from(testKey, "base64"))
            .update(`${headerSegment}.${payloadSegment}`)
            .digest("base64url");

        expect(token.split(".")).toHaveLength(3);
        expect(header).toEqual(JWT_HEADER);
        expect(decodedPayload).toEqual(payload);
        expect(signatureSegment).toMatch(base64UrlSegment);
        expect(signatureSegment).not.toContain("=");
        expect(signatureSegment).toBe(expectedSignature);
    });
    test("should verify a token signed by a third party", () => {
        const payload = auth.verify(THIRD_PARTY_TOKEN.token, THIRD_PARTY_TOKEN.key);
        expect(payload).toEqual(THIRD_PARTY_TOKEN.payload);
    });
    test("should reject a token signed with the wrong key", () => {
        const payload = {
            sub: "1234567890",
            name: "Test User",
            exp: Math.floor(Date.now() / 1000) + 60
        };
        const token = auth.sign(payload, alternateKey);
        expect(() => auth.verify(token)).toThrow(AuthenticationError);
    });
    test("should reject a token with tampered payload", () => {
        const payload = {
            sub: "1234567890",
            name: "Test User",
            exp: Math.floor(Date.now() / 1000) + 60
        };
        const token = auth.sign(payload);
        const [header, , signature] = token.split(".");
        const tamperedPayload = auth.base64Encode(
            JSON.stringify({ sub: "1234567890", name: "Hacker" })
        );
        const tamperedToken = `${header}.${tamperedPayload}.${signature}`;
        expect(() => auth.verify(tamperedToken)).toThrow(AuthenticationError);
    });
    test("should reject an expired token", () => {
        const payload = {
            sub: "1234567890",
            exp: Math.floor(Date.now() / 1000)
        };
        const token = auth.sign(payload);
        expect(() => auth.verify(token)).toThrow(AuthenticationError);
    });
    test.each([
        ["missing", { sub: "1234567890" }],
        ["non-numeric", { sub: "1234567890", exp: "tomorrow" }]
    ])("should reject a token with a %s expiration", (_description, claims) => {
        const token = makeToken(JWT_HEADER, claims);
        expect(() => auth.verify(token)).toThrow(AuthenticationError);
    });
    test("should reject a token that is not valid yet", () => {
        const payload = {
            sub: "1234567890",
            nbf: Math.floor(Date.now() / 1000) + 3600,
            exp: Math.floor(Date.now() / 1000) + 7200
        };
        const token = auth.sign(payload);
        expect(() => auth.verify(token)).toThrow(AuthenticationError);
    });
    test("should reject a token issued in the future (beyond clock skew)", () => {
        const payload = {
            sub: "1234567890",
            iat: Math.floor(Date.now() / 1000) + 120,
            exp: Math.floor(Date.now() / 1000) + 3600
        };
        const token = auth.sign(payload);
        expect(() => auth.verify(token)).toThrow(AuthenticationError);
    });
    test("should accept a token with future iat within clock skew", () => {
        const payload = {
            sub: "1234567890",
            iat: Math.floor(Date.now() / 1000) + 30,
            exp: Math.floor(Date.now() / 1000) + 60
        };
        const token = auth.sign(payload);
        const result = auth.verify(token);
        expect(result).toEqual(payload);
    });
    test("should reject a malformed token", () => {
        const malformedTokens = [0, "header.payload", "not.a.jwt"];
        for (const token of malformedTokens) {
            expect(() => auth.verify(token as string)).toThrow(AuthenticationError);
        }
    });
    test.each([
        ["header", null, { exp: 4102444800 }],
        ["claims", JWT_HEADER, null]
    ])("should reject a token with null %s", (_description, header, claims) => {
        expect(() => auth.verify(makeToken(header, claims))).toThrow(AuthenticationError);
    });
    test("verifying should fail with an unsupported algorithm", () => {
        const token = "eyJhbGciOiJFUzUxMiIsInR5cCI6IkpXVCJ9.e30.AA";
        expect(() => auth.verify(token, testKey)).toThrow("Unsupported algorithm: ES512");
    });
});
