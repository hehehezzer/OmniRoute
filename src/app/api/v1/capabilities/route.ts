import { NextResponse } from "next/server";

import { authorizeInferenceMetadata } from "@/app/api/v1/_helpers/inferenceMetadataAuth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return handleCorsOptions();
}

/** Lightweight feature negotiation for additive routing extensions. */
export async function GET(request: Request) {
  const auth = await authorizeInferenceMetadata(request);
  if (!auth.authorized) return auth.response;

  return NextResponse.json(
    {
      schema_version: 1,
      implementation: "omniroute-quattro-compatible",
      upstream_compatibility: "3.8.51",
      capabilities: {
        candidate_snapshot: true,
        routing_requirements: true,
        preferred_candidates: true,
        capability_routing: true,
        practical_context: true,
        cost_metadata: true,
        quota_state: true,
        routing_diagnostics: true,
        routing_header_transport: true,
      },
      endpoints: {
        candidate_snapshot: "/api/v1/routing/candidates?channel=auto",
        routing_diagnostics: "/api/v1/explain/routing",
      },
    },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } }
  );
}
