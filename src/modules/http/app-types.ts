import { ProblemError } from "./problems";
import { BASE_RESPONSE_HEADERS } from "./response-security";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface AppRequest {
	bodyText: string;
	headers: Record<string, string | undefined>;
	method: string;
	remoteAddress: string | null;
	url: URL;
}

export interface AppResponse {
	body: Buffer | string;
	headers?: Record<string, string | string[]>;
	status: number;
}

export interface SessionCookieSet {
	csrfToken?: string;
	sessionToken?: string | null;
}

export function getHeader(request: AppRequest, name: string) {
	return request.headers[name.toLowerCase()];
}

export function parseCookies(request: AppRequest) {
	const rawCookie = getHeader(request, "cookie");
	const cookies: Record<string, string> = {};

	if (!rawCookie) {
		return cookies;
	}

	for (const part of rawCookie.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}

		const index = trimmed.indexOf("=");
		if (index <= 0) {
			continue;
		}

		cookies[trimmed.slice(0, index)] = decodeURIComponent(trimmed.slice(index + 1));
	}

	return cookies;
}

export async function readNodeBody(request: import("node:http").IncomingMessage) {
	const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
		throw new ProblemError(413, "request_too_large", "Request is too large");
	}

	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += buffer.byteLength;
		if (bytes > MAX_REQUEST_BODY_BYTES) {
			throw new ProblemError(413, "request_too_large", "Request is too large");
		}
		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString("utf8");
}

export function response(status: number, body: Buffer | string, headers?: Record<string, string | string[]>) {
	return {
		body,
		headers: {
			...BASE_RESPONSE_HEADERS,
			...headers,
		},
		status,
	} satisfies AppResponse;
}