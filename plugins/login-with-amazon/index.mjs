import { readFile } from "node:fs/promises";
import { fetchText, isPluginMain, runCapabilityPlugin } from "../lib/runtime.mjs";

export const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
const identityPolicy = {
	allowedHosts: ["api.amazon.com"],
	maxBytes: 262144,
	maxRedirects: 0,
};

function safeLabel(value) {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (!normalized || normalized.length > 254 || /[\0\r\n]/.test(normalized)) return null;
	return normalized;
}

function maskEmail(value) {
	const email = safeLabel(value);
	if (!email) return null;
	const at = email.lastIndexOf("@");
	if (at < 1 || at === email.length - 1 || email.indexOf("@") !== at) return null;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	return `${local.length === 1 ? "*" : `${local[0]}${"*".repeat(Math.min(8, local.length - 1))}`}@${domain}`;
}

function maskName(value) {
	const name = safeLabel(value);
	if (!name) return null;
	return name.length === 1 ? "*" : `${name[0]}${"*".repeat(Math.min(8, name.length - 1))}`;
}

export function parseAmazonIdentity(source, checkedAt = new Date()) {
	const profile = JSON.parse(source);
	if (!profile || typeof profile !== "object" || Array.isArray(profile)
		|| !Object.hasOwn(profile, "user_id")
		|| typeof profile.user_id !== "string"
		|| !profile.user_id
		|| profile.user_id !== profile.user_id.trim()
		|| Buffer.byteLength(profile.user_id, "utf8") > 512
		|| /[\0\r\n]/.test(profile.user_id)
		|| !(checkedAt instanceof Date)
		|| !Number.isFinite(checkedAt.getTime())) {
		throw new Error("Amazon identity response is invalid");
	}
	return {
		checkedAt: checkedAt.toISOString(),
		maskedAccount: maskEmail(profile.email) ?? maskName(profile.name),
		providerId: "login-with-amazon",
		subject: profile.user_id,
	};
}

async function resolveIdentity(_input, authorization) {
	if (authorization?.kind !== "bearer"
		|| typeof authorization.value !== "string"
		|| authorization.value.length < 20
		|| authorization.value.length > 8192
		|| /[\0\r\n]/.test(authorization.value)) {
		throw new Error("Amazon authorization is invalid");
	}
	const source = await fetchText("https://api.amazon.com/user/profile", {
		...identityPolicy,
		headers: {
			accept: "application/json",
			authorization: `Bearer ${authorization.value}`,
		},
	});
	return parseAmazonIdentity(source);
}

if (isPluginMain(import.meta.url)) {
	await runCapabilityPlugin(manifest, {
		"login-with-amazon/identity": {
			"identity.resolve": resolveIdentity,
		},
	});
}