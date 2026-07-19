import type { AppRequest } from "./app-types";
import { ProblemError } from "./problems";

export function assertMediaType(request: AppRequest, expected: "application/json" | "application/x-www-form-urlencoded") {
	const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== expected) {
		throw new ProblemError(415, "unsupported_media_type", "Unsupported media type", `Expected ${expected}.`);
	}
}

export function parseUrlEncoded(bodyText: string) {
	const params = new URLSearchParams(bodyText);
	return Object.fromEntries(params.entries());
}

export function parseJson(bodyText: string) {
	if (!bodyText) {
		throw new ProblemError(400, "invalid_json", "Invalid JSON", "A JSON object is required.");
	}
	try {
		const value = JSON.parse(bodyText) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new ProblemError(400, "invalid_json", "Invalid JSON", "A JSON object is required.");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ProblemError) {
			throw error;
		}
		throw new ProblemError(400, "invalid_json", "Invalid JSON", "The request body is not valid JSON.");
	}
}