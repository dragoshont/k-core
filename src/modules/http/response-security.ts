export const BASE_RESPONSE_HEADERS = {
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
	"permissions-policy": "camera=(), microphone=(), geolocation=()",
	"referrer-policy": "no-referrer",
	"strict-transport-security": "max-age=31536000; includeSubDomains",
	"x-content-type-options": "nosniff",
} as const;