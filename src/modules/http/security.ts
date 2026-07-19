import ipaddr from "ipaddr.js";
import type { AppRequest } from "./app-types";
import type { AppConfig, ParsedCidr } from "../config";

export interface BoundaryResult {
	clientAddress?: string;
	ok: boolean;
	reason?: string;
}

function normalizeAddress(value: string) {
	return ipaddr.process(value.trim());
}

function matchesAny(address: string, cidrs: ParsedCidr[]) {
	try {
		const parsed = normalizeAddress(address);
		return cidrs.some((cidr) => parsed.kind() === cidr.address.kind() && parsed.match([cidr.address, cidr.prefix]));
	} catch {
		return false;
	}
}

function singleForwardedValue(headerValue: string | undefined) {
	if (!headerValue || headerValue.includes(",")) {
		return null;
	}

	const value = headerValue.trim();
	return value || null;
}

export function validatePrivateBoundary(request: AppRequest, config: AppConfig): BoundaryResult {
	const remoteAddress = request.remoteAddress;
	if (!remoteAddress || !matchesAny(remoteAddress, config.trustedProxyCidrs)) {
		return { ok: false, reason: "untrusted_proxy" };
	}

	const forwardedProto = singleForwardedValue(request.headers["x-forwarded-proto"]);
	const forwardedHost = singleForwardedValue(request.headers["x-forwarded-host"]);
	if (forwardedProto !== config.publicOrigin.protocol.slice(0, -1) || forwardedHost !== config.publicOrigin.host) {
		return { ok: false, reason: "origin_mismatch" };
	}

	const clientAddress = singleForwardedValue(request.headers["x-forwarded-for"]);
	if (!clientAddress || !matchesAny(clientAddress, config.allowedPrivateClientCidrs)) {
		return { ok: false, reason: "untrusted_client" };
	}

	return { clientAddress, ok: true };
}

export function validateSameOrigin(request: AppRequest, config: AppConfig) {
	const origin = request.headers.origin;
	if (origin) {
		return origin === config.publicOrigin.origin;
	}

	const referer = request.headers.referer;
	if (!referer) {
		return false;
	}

	try {
		return new URL(referer).origin === config.publicOrigin.origin;
	} catch {
		return false;
	}
}

export function isPrivateCidrValue(value: string) {
	const [addressText, prefixText] = value.split("/");
	const address = normalizeAddress(addressText);
	const prefix = Number.parseInt(prefixText, 10);
	if (Number.isNaN(prefix)) {
		return false;
	}

	const range = address.range();
	return ["linkLocal", "loopback", "private", "uniqueLocal"].includes(range);
}