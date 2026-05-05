import crypto from "crypto";

/**
 * Generate HMAC-SHA256 signature for Unleashed API authentication
 * Signature is computed over the query string portion of the URL
 */
export function generateUnleashedSignature(
  queryString: string,
  apiKey: string
): string {
  const hmac = crypto.createHmac("sha256", apiKey);
  hmac.update(queryString);
  return hmac.digest("base64");
}

/**
 * Build a query string from parameters in sorted order
 * This is required for Unleashed HMAC signature generation
 */
export function buildQueryString(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  return sorted.map((key) => `${key}=${encodeURIComponent(params[key])}`).join("&");
}

/**
 * Create a complete Unleashed API request with proper HMAC authentication
 * Server-side only - credentials never exposed to client
 *
 * Unleashed uses two custom headers for auth:
 *   api-auth-id: the API ID (GUID)
 *   api-auth-signature: HMAC-SHA256 of the query string
 */
export function createUnleashedRequest(
  endpoint: string,
  queryParams: Record<string, string>,
  apiId: string,
  apiKey: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET"
): {
  url: string;
  headers: Record<string, string>;
  method: string;
} {
  const queryString = buildQueryString(queryParams);
  const signature = generateUnleashedSignature(queryString, apiKey);

  const url = queryString
    ? `https://api.unleashedsoftware.com/${endpoint}?${queryString}`
    : `https://api.unleashedsoftware.com/${endpoint}`;

  return {
    url,
    headers: {
      "api-auth-id": apiId,
      "api-auth-signature": signature,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    method,
  };
}
