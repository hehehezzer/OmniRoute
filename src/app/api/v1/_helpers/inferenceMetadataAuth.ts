import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export async function authorizeInferenceMetadata(request: Request): Promise<
  | {
      authorized: true;
      apiKey: string | null;
      apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
    }
  | { authorized: false; response: Response }
> {
  const apiKey = extractApiKey(request);
  const apiKeyValid = apiKey ? await isValidApiKey(apiKey) : false;
  const dashboardValid = !apiKeyValid ? await isDashboardSessionAuthenticated(request) : false;

  if (!apiKeyValid && !dashboardValid && isRequireApiKeyEnabled()) {
    return {
      authorized: false,
      response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required"),
    };
  }

  const metadata = apiKeyValid && apiKey ? await getApiKeyMetadata(apiKey).catch(() => null) : null;
  if (metadata?.allowedEndpoints?.length && !metadata.allowedEndpoints.includes("models")) {
    return {
      authorized: false,
      response: errorResponse(HTTP_STATUS.FORBIDDEN, "Endpoint access denied"),
    };
  }
  return { authorized: true, apiKey: apiKeyValid ? apiKey : null, apiKeyMetadata: metadata };
}
