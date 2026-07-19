import { randomBase64Url } from "../common/crypto";
import { createHmac, timingSafeEqual } from "node:crypto";

function signature(secret: string, value: string) {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signCookieValue(secret: string, rawValue: string) {
	return `${rawValue}.${signature(secret, rawValue)}`;
}

export function verifySignedCookieValue(secret: string, signedValue: string | undefined) {
	if (!signedValue) {
		return null;
	}
	const index = signedValue.lastIndexOf(".");
	if (index <= 0) {
		return null;
	}
	const rawValue = signedValue.slice(0, index);
	const provided = Buffer.from(signedValue.slice(index + 1));
	const expected = Buffer.from(signature(secret, rawValue));
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		return null;
	}
	return rawValue;
}

export function issueCsrf(secret: string) {
	const rawToken = randomBase64Url(32);
	return { cookieValue: signCookieValue(secret, rawToken), token: rawToken };
}

export function buildSessionCookie(sessionToken: string | null) {
	if (!sessionToken) {
		return "__Host-k.sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
	}
	return `__Host-k.sid=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function buildCsrfCookie(signedToken: string | null) {
	if (!signedToken) {
		return "__Host-k.csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict";
	}
	return `__Host-k.csrf=${encodeURIComponent(signedToken)}; Path=/; Secure; SameSite=Strict`;
	}

export function buildOAuthBindingCookie(browserBinding: string | null) {
	if (!browserBinding) {
		return "__Host-k.oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
	}
	return `__Host-k.oauth=${encodeURIComponent(browserBinding)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function buildIntegrationReceiptCookie(receipt: string | null) {
	if (!receipt) {
		return "__Host-k.integration=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
	}
	return `__Host-k.integration=${encodeURIComponent(receipt)}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`;
}