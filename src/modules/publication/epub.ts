import yauzl, { type Entry, type ZipFile } from "yauzl";

const MAX_ENTRIES = 2000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;

export function validateEpub(path: string) {
	return new Promise<{ entries: number; expandedBytes: number }>((resolveValidation, reject) => {
		yauzl.open(path, { autoClose: true, lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
			if (openError || !zipFile) return reject(openError ?? new Error("could not open EPUB"));
			let entries = 0;
			let expandedBytes = 0;
			let hasContainer = false;
			let hasMimetype = false;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				zipFile.close();
				reject(error);
			};
			zipFile.on("error", fail);
			zipFile.on("entry", (entry: Entry) => {
				entries += 1;
				expandedBytes += entry.uncompressedSize;
				if (entries > MAX_ENTRIES || expandedBytes > MAX_EXPANDED_BYTES) return fail(new Error("EPUB archive exceeds limits"));
				if (entry.fileName.includes("\\") || entry.fileName.startsWith("/") || entry.fileName.split("/").includes("..")) return fail(new Error("EPUB archive contains an unsafe path"));
				if (entry.fileName === "META-INF/encryption.xml") return fail(new Error("Encrypted or DRM-protected EPUBs are not supported"));
				if (entry.fileName === "META-INF/container.xml") {
					if (hasContainer) return fail(new Error("EPUB contains duplicate container metadata"));
					hasContainer = true;
				}
				if (entry.fileName === "mimetype") {
					if (hasMimetype || entries !== 1 || entry.compressionMethod !== 0) return fail(new Error("EPUB mimetype must be the first uncompressed entry"));
					hasMimetype = true;
					zipFile.openReadStream(entry, (streamError, stream) => {
						if (streamError || !stream) return fail(streamError ?? new Error("Could not read EPUB mimetype"));
						const chunks: Buffer[] = [];
						stream.on("data", (chunk: Buffer) => chunks.push(chunk));
						stream.on("error", fail);
						stream.on("end", () => {
							if (!Buffer.concat(chunks).equals(Buffer.from("application/epub+zip"))) return fail(new Error("EPUB has an invalid mimetype"));
							zipFile.readEntry();
						});
					});
					return;
				}
				zipFile.readEntry();
			});
			zipFile.on("end", () => {
				if (settled) return;
				if (!hasContainer || !hasMimetype) return reject(new Error("EPUB is missing required structure"));
				settled = true;
				resolveValidation({ entries, expandedBytes });
			});
			zipFile.readEntry();
		});
	});
}