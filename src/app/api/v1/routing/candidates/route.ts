import { NextResponse } from "next/server";
import { z } from "zod";

import { authorizeInferenceMetadata } from "@/app/api/v1/_helpers/inferenceMetadataAuth";
import { isModelAllowedForKey } from "@/lib/db/apiKeys";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { checkRateLimit } from "@/shared/utils/rateLimiter";
import {
  getSanitizedAutoComboCandidateSnapshot,
  isUnknownAutoChannelError,
} from "@omniroute/open-sse/handlers/autoComboCandidates.ts";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";

export const dynamic = "force-dynamic";

const channelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(?:auto|[a-zA-Z0-9][a-zA-Z0-9:_-]*)$/);

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const auth = await authorizeInferenceMetadata(request);
  if (!auth.authorized) return auth.response;

  const rateLimit = await checkRateLimit(
    `candidate-snapshot:${auth.apiKeyMetadata?.id ?? "anonymous"}`,
    [{ limit: 60, window: 60 }]
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(buildErrorBody(429, "Candidate snapshot rate limit exceeded"), {
      status: 429,
      headers: CORS_HEADERS,
    });
  }

  const parsedChannel = channelSchema.safeParse(
    new URL(request.url).searchParams.get("channel") || "auto"
  );
  if (!parsedChannel.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid auto channel"), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  if (
    auth.apiKey &&
    !(await isModelAllowedForKey(
      auth.apiKey,
      parsedChannel.data === "auto" ? "auto" : `auto/${parsedChannel.data}`
    ))
  ) {
    return NextResponse.json(buildErrorBody(403, "Model access denied"), {
      status: 403,
      headers: CORS_HEADERS,
    });
  }

  try {
    const snapshot = await getSanitizedAutoComboCandidateSnapshot(
      parsedChannel.data,
      auth.apiKeyMetadata?.id ?? null,
      {
        allowedConnectionIds: auth.apiKeyMetadata?.allowedConnections ?? null,
      }
    );
    return NextResponse.json(snapshot, {
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isUnknownAutoChannelError(error)) {
      return NextResponse.json(buildErrorBody(404, "Unknown auto channel"), {
        status: 404,
        headers: CORS_HEADERS,
      });
    }
    return NextResponse.json(buildErrorBody(500, "Failed to build candidate snapshot"), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
}
