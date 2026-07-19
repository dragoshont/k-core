import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../../../contracts/plugin-manifest.schema.json";
import protocolV2Schema from "../../../contracts/plugin-protocol.v2.schema.json";
import type { CapabilityPluginManifestV2, PluginManifest } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validateManifest = ajv.compile(manifestSchema as object);
const validateProtocolV2 = ajv.compile(protocolV2Schema as object);

function validationError(label: string, validate: ValidateFunction) {
	return new Error(`${label} is invalid: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
}

function assertHosts(hosts: string[]) {
	for (const host of hosts) {
		if (host.includes("..")) throw new Error("allowedHosts contains an invalid host pattern");
	}
}

function assertV2Semantics(manifest: CapabilityPluginManifestV2) {
	const ids = manifest.capabilities.map((capability) => capability.capabilityId);
	if (new Set(ids).size !== ids.length) throw new Error("capabilityId values must be unique");
	for (const capability of manifest.capabilities) {
		if (!capability.capabilityId.startsWith(`${manifest.pluginId}/`)) {
			throw new Error("capabilityId must use the pluginId namespace");
		}
	}
}

export function assertManifestConforms(value: unknown): asserts value is PluginManifest {
	if (!validateManifest(value)) throw validationError("plugin manifest", validateManifest);
	const manifest = value as PluginManifest;
	assertHosts(manifest.schemaVersion === 1 ? manifest.allowedHosts : manifest.runtime.allowedHosts);
	if (manifest.schemaVersion === 2) assertV2Semantics(manifest);
}

export function assertProtocolV2Envelope(value: unknown) {
	if (!validateProtocolV2(value)) throw validationError("plugin protocol response", validateProtocolV2);
}