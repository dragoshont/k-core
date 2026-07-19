import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Buffer(value: Buffer | string) {
	return createHash("sha256").update(value).digest();
}

export function sha256Hex(value: Buffer | string) {
	return sha256Buffer(value).toString("hex");
}

export function hmacSha256Buffer(secret: string, value: string) {
	return createHmac("sha256", secret).update(value).digest();
}

export function hmacSha256Hex(secret: string, value: string) {
	return hmacSha256Buffer(secret, value).toString("hex");
}

export function randomBase64Url(bytes = 32) {
	return randomBytes(bytes).toString("base64url");
}

export function constantTimeBufferEqual(left: Buffer, right: Buffer) {
	if (left.length !== right.length) {
		return false;
	}

	return timingSafeEqual(left, right);
}