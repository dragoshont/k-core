import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { ProviderEncryptedValue, ProviderSecretContext } from "./types";
import { PROVIDER_CONNECTOR_IDS, ProviderSubjectHashKey, ProviderTokenKeyring } from "./types";

export const PROVIDER_TOKEN_DECRYPTION_ERROR = "Provider token decryption failed";
const PROVIDER_TOKEN_ENCRYPTION_ERROR = "Provider token encryption failed";
const TOKEN_NONCE_BYTES = 12;
const TOKEN_TAG_BYTES = 16;
const TOKEN_KINDS = ["access", "refresh"] as const;


function tokenAad(context: ProviderSecretContext) {
	if ("authorizationId" in context) {
		const values = [context.profileId, context.authorizationId, context.connectorId, context.kind];
		if (values.some((value) => !value || value.includes("\0"))
			|| !PROVIDER_CONNECTOR_IDS.includes(context.connectorId)) {
			throw new Error("Provider token context is invalid");
		}
		return Buffer.from(`k-provider-authorization-v1\0${values.join("\0")}`, "utf8");
	}
	const values = [
		context.profileId,
		context.accountId,
		context.connectorId,
		context.kind,
		String(context.revision),
	];
	if (values.some((value) => !value || value.includes("\0"))
		|| !PROVIDER_CONNECTOR_IDS.includes(context.connectorId)
		|| !TOKEN_KINDS.includes(context.kind)
		|| !Number.isSafeInteger(context.revision)
		|| context.revision < 1) {
		throw new Error("Provider token context is invalid");
	}
	return Buffer.from(`k-provider-token-v1\0${values.join("\0")}`, "utf8");
}

export function encryptProviderToken(
	plaintext: Buffer | string,
	context: ProviderSecretContext,
	keyring: ProviderTokenKeyring,
): ProviderEncryptedValue {
	const plaintextBytes = Buffer.isBuffer(plaintext) ? Buffer.from(plaintext) : Buffer.from(plaintext, "utf8");
	try {
		if (plaintextBytes.byteLength === 0) throw new Error(PROVIDER_TOKEN_ENCRYPTION_ERROR);
		const aad = tokenAad(context);
		return keyring.useActiveKey((keyId, key) => {
			const nonce = randomBytes(TOKEN_NONCE_BYTES);
			const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TOKEN_TAG_BYTES });
			cipher.setAAD(aad);
			const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
			return { ciphertext, keyId, nonce, tag: cipher.getAuthTag() };
		});
	} catch {
		throw new Error(PROVIDER_TOKEN_ENCRYPTION_ERROR);
	} finally {
		plaintextBytes.fill(0);
	}
}

export function decryptProviderToken(
	encrypted: ProviderEncryptedValue,
	context: ProviderSecretContext,
	keyring: ProviderTokenKeyring,
) {
	try {
		if (encrypted.nonce.byteLength !== TOKEN_NONCE_BYTES
			|| encrypted.tag.byteLength !== TOKEN_TAG_BYTES
			|| encrypted.ciphertext.byteLength === 0) {
			throw new Error(PROVIDER_TOKEN_DECRYPTION_ERROR);
		}
		const aad = tokenAad(context);
		const plaintext = keyring.useKey(encrypted.keyId, (key) => {
			const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce, { authTagLength: TOKEN_TAG_BYTES });
			decipher.setAAD(aad);
			decipher.setAuthTag(encrypted.tag);
			return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
		});
		if (!plaintext) throw new Error(PROVIDER_TOKEN_DECRYPTION_ERROR);
		return plaintext;
	} catch {
		throw new Error(PROVIDER_TOKEN_DECRYPTION_ERROR);
	}
}

export function providerSubjectHmac(issuer: string, subject: string, subjectHashKey: ProviderSubjectHashKey) {
	if (!issuer || !subject || issuer.includes("\0") || subject.includes("\0")) {
		throw new Error("Provider subject identity is invalid");
	}
	return subjectHashKey.use((key) => createHmac("sha256", key).update(`${issuer}\0${subject}`, "utf8").digest());
}