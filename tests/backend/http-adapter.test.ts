import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readNodeBody, response } from "../../src/modules/http/app-types";
import { problemJson, ProblemError } from "../../src/modules/http/problems";

function request(body: string, contentLength?: number) {
  const stream = Readable.from([body]) as import("node:http").IncomingMessage;
  stream.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return stream;
}

describe("Node HTTP adapter", () => {
  it("rejects declared oversized request bodies before reading", async () => {
    await expect(readNodeBody(request("small", 65 * 1024))).rejects.toMatchObject({ code: "request_too_large", status: 413 });
  });

  it("rejects streamed request bodies after 64 KiB", async () => {
    await expect(readNodeBody(request("x".repeat(65 * 1024)))).rejects.toMatchObject({ code: "request_too_large", status: 413 });
  });

  it("adds baseline security headers to every response", () => {
    const result = response(200, "ok", { "content-type": "text/plain" });
    expect(result.headers).toMatchObject({
      "cache-control": "no-store",
      "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
    });
  });

  it("adds the same baseline security headers to problem responses", () => {
    const result = problemJson(new ProblemError(429, "auth_throttled", "Too many attempts"), "request-id");
    expect(result.headers).toMatchObject({
      "cache-control": "no-store",
      "content-security-policy": expect.stringContaining("frame-ancestors 'none'"),
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
    });
  });
});
