import type { AppResponse } from "./app-types";
import { BASE_RESPONSE_HEADERS } from "./response-security";

export interface ProblemShape {
	code: string;
	detail?: string;
	requestId: string;
	retryAt?: string | null;
	status: number;
	title: string;
	type: string;
}

export class ProblemError extends Error {
	headers?: Record<string, string>;
	retryAt?: string | null;
	status: number;
	title: string;
	type: string;

	constructor(
		status: number,
		public code: string,
		title: string,
		detail?: string,
		options?: { headers?: Record<string, string>; retryAt?: string | null; type?: string },
	) {
		super(detail ?? title);
		this.status = status;
		this.title = title;
		this.type = options?.type ?? `urn:k:problem:${code}`;
		this.headers = options?.headers;
		this.retryAt = options?.retryAt ?? null;
		this.name = "ProblemError";
	}
}

export function toProblemShape(error: unknown, requestId: string): ProblemShape {
	if (error instanceof ProblemError) {
		return {
			code: error.code,
			detail: error.message === error.title ? undefined : error.message,
			requestId,
			retryAt: error.retryAt ?? null,
			status: error.status,
			title: error.title,
			type: error.type,
		};
	}

	return {
		code: "internal_error",
		requestId,
		status: 500,
		title: "Internal server error",
		type: "urn:k:problem:internal_error",
	};
}

export function problemJson(error: unknown, requestId: string): AppResponse {
	const shape = toProblemShape(error, requestId);
	const headers: Record<string, string | string[]> = {
		...BASE_RESPONSE_HEADERS,
		"content-type": "application/problem+json; charset=utf-8",
	};

	if (error instanceof ProblemError && error.headers) {
		for (const [name, value] of Object.entries(error.headers)) {
			headers[name.toLowerCase()] = value;
		}
	}

	return {
		body: JSON.stringify(shape),
		headers,
		status: shape.status,
	};
}