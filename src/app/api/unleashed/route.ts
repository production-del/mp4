import { NextRequest, NextResponse } from "next/server";
import { createUnleashedRequest } from "@/lib/unleashed/auth";

interface UnleashedProxyRequest {
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * Unleashed API proxy endpoint
 * Handles HMAC-SHA256 authentication server-side
 * Credentials are never exposed to the client
 */
export async function POST(request: NextRequest) {
  try {
    const apiId = process.env.UNLEASHED_API_ID;
    const apiKey = process.env.UNLEASHED_API_KEY;

    if (!apiId || !apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: {
            statusCode: 500,
            errorCode: "MISSING_CREDENTIALS",
            errorDetail: "Unleashed API credentials not configured",
          },
        },
        { status: 500 }
      );
    }

    const proxyRequest: UnleashedProxyRequest = await request.json();
    const {
      endpoint,
      method = "GET",
      query = {},
      body,
    } = proxyRequest;

    // Validate endpoint to prevent abuse
    if (!endpoint || typeof endpoint !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: {
            statusCode: 400,
            errorCode: "INVALID_ENDPOINT",
            errorDetail: "Endpoint is required and must be a string",
          },
        },
        { status: 400 }
      );
    }

    // Create the authenticated request
    const { url, headers } = createUnleashedRequest(
      endpoint,
      query,
      apiId,
      apiKey,
      method
    );

    // Make the request to Unleashed API
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body && (method === "POST" || method === "PUT")) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    // Handle response
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return NextResponse.json(
        {
          success: false,
          error: {
            statusCode: response.status,
            errorCode: errorData.errorCode || "API_ERROR",
            errorDetail:
              errorData.errorDetail ||
              response.statusText ||
              "Unknown error",
          },
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Unleashed proxy error:", error);
    return NextResponse.json(
      {
        success: false,
        error: {
          statusCode: 500,
          errorCode: "PROXY_ERROR",
          errorDetail:
            error instanceof Error ? error.message : "Unknown error",
        },
      },
      { status: 500 }
    );
  }
}
