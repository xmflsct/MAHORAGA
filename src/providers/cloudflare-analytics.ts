import type { Env } from "../env.d";

export interface GatewayCosts {
  total_cost: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
}

/**
 * REST API response from:
 *   GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs
 *
 * Each log entry has `cost`, `tokens_in`, `tokens_out`.
 * `result_info` carries aggregate counters across the full result set.
 */
interface LogEntry {
  id: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  success: boolean;
  cached: boolean;
  model: string;
  provider: string;
  created_at: string;
}

interface LogsResponse {
  result: LogEntry[];
  result_info: {
    count: number;
    total_count: number;
    page: number;
    per_page: number;
  };
  success: boolean;
  errors?: Array<{ message: string }>;
}

/**
 * Fetch real cost data from Cloudflare AI Gateway via the REST logs API.
 *
 * Requires:
 *  - CLOUDFLARE_API_TOKEN (standard Cloudflare API token with AI Gateway > Read)
 *  - CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID
 *  - CLOUDFLARE_AI_GATEWAY_ID
 *
 * Fetches the last 100 log entries (or up to `limit`) and sums cost/token fields
 * from the per-request data returned by the API.
 *
 * @param env   Worker environment bindings
 * @param limit Max log entries to aggregate (default 100)
 * @returns Aggregated cost data, or null if unavailable / not configured
 */
export async function fetchGatewayCosts(
  env: Env,
  limit = 100,
): Promise<GatewayCosts | null> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID;

  if (!token || !accountId || !gatewayId) {
    return null;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?per_page=${limit}&order_by=created_at&order_by_direction=desc`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[CF Analytics] REST request failed (${response.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as LogsResponse;

    if (!data.success || data.errors?.length) {
      console.warn(
        `[CF Analytics] API errors: ${data.errors?.map((e) => e.message).join(", ") ?? "unknown"}`,
      );
      return null;
    }

    // Aggregate cost and tokens from individual log entries
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    for (const entry of data.result) {
      totalCost += entry.cost ?? 0;
      totalTokensIn += entry.tokens_in ?? 0;
      totalTokensOut += entry.tokens_out ?? 0;
    }

    return {
      total_cost: totalCost,
      total_requests: data.result_info?.total_count ?? data.result.length,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
    };
  } catch (error) {
    console.warn(`[CF Analytics] Failed to fetch gateway costs: ${String(error)}`);
    return null;
  }
}
