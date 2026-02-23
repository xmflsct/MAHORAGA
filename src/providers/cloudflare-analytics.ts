import type { Env } from "../env.d";

export interface GatewayCosts {
  total_cost: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
}

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

interface CachedCosts {
  total_cost: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
  last_log_created_at: string | null;
}

/**
 * Fetch all-time gateway costs by incrementally syncing new log entries
 * into a D1 running-total cache.
 *
 * Flow:
 *  1. Read the current running totals + last synced timestamp from D1
 *  2. Fetch log entries from CF REST API newer than that timestamp
 *  3. Paginate through all new entries (50 per page, ordered oldest-first)
 *  4. Add new entries' cost/tokens to the running totals
 *  5. Write updated totals back to D1
 *  6. Return the all-time totals
 *
 * Falls back to null if CF credentials aren't configured.
 */
export async function fetchGatewayCosts(env: Env): Promise<GatewayCosts | null> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID;

  if (!token || !accountId || !gatewayId) {
    return null;
  }

  try {
    // 1. Read cached running totals from D1
    const cached = await env.DB.prepare(
      "SELECT total_cost, total_requests, tokens_in, tokens_out, last_log_created_at FROM gateway_cost_cache WHERE id = 1",
    ).first<CachedCosts>();

    let totalCost = cached?.total_cost ?? 0;
    let totalRequests = cached?.total_requests ?? 0;
    let tokensIn = cached?.tokens_in ?? 0;
    let tokensOut = cached?.tokens_out ?? 0;
    let lastCreatedAt = cached?.last_log_created_at ?? null;

    // 2. Fetch new log entries from CF API (paginated, oldest-first so we process chronologically)
    let page = 1;
    let hasMore = true;
    let newestTimestamp = lastCreatedAt;

    while (hasMore) {
      let url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs?per_page=50&page=${page}&order_by=created_at&order_by_direction=asc`;

      if (lastCreatedAt) {
        url += `&start_date=${lastCreatedAt}`;
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.warn(`[CF Analytics] REST request failed (${response.status}): ${text.slice(0, 200)}`);
        break;
      }

      const data = (await response.json()) as LogsResponse;
      if (!data.success || !data.result) break;

      for (const entry of data.result) {
        // Skip entries at or before the last synced timestamp (start_date is inclusive)
        if (lastCreatedAt && entry.created_at <= lastCreatedAt) continue;

        totalCost += entry.cost ?? 0;
        tokensIn += entry.tokens_in ?? 0;
        tokensOut += entry.tokens_out ?? 0;
        totalRequests++;

        if (!newestTimestamp || entry.created_at > newestTimestamp) {
          newestTimestamp = entry.created_at;
        }
      }

      // If we got fewer than 50 results, we've reached the end
      if (data.result.length < 50) {
        hasMore = false;
      } else {
        page++;
        // Safety cap: don't paginate more than 20 pages (1000 entries) per sync
        if (page > 20) {
          hasMore = false;
        }
      }
    }

    // 3. Write updated totals back to D1
    if (newestTimestamp && newestTimestamp !== lastCreatedAt) {
      await env.DB.prepare(
        `UPDATE gateway_cost_cache
         SET total_cost = ?, total_requests = ?, tokens_in = ?, tokens_out = ?,
             last_log_created_at = ?, updated_at = datetime('now')
         WHERE id = 1`,
      )
        .bind(totalCost, totalRequests, tokensIn, tokensOut, newestTimestamp)
        .run();
    }

    return {
      total_cost: totalCost,
      total_requests: totalRequests,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    };
  } catch (error) {
    console.warn(`[CF Analytics] Failed to fetch gateway costs: ${String(error)}`);
    return null;
  }
}
