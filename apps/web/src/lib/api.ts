import { createSaathClient } from "@saath/contracts";
import { publicEnv } from "./env";

export function createBrowserApiClient(args: {
  getAccessToken: () => string | null;
  refreshTokens: () => Promise<string | null>;
}) {
  return createSaathClient({
    baseUrl: publicEnv.NEXT_PUBLIC_API_URL,
    getAccessToken: args.getAccessToken,
    refreshTokens: args.refreshTokens,
  });
}
