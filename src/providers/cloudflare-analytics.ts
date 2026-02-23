import type { Env } from "../env.d";

export interface GatewayCosts {
  total_cost: number;
  total_requests: number;
  tokens_in: number;
  tokens_out: number;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        requests?: Array<{
          count: number;
          sum?: {
            cost?: number;
            tokensIn?: number;
            tokensOut?: number;
          };
        }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Fetch real cost data from Cloudflare AI Gateway via GraphQL analytics API.
 *
 * Requires:
 *  - CLOUDFLARE_API_TOKEN (standard Cloudflare API token with AI Gateway > Read)
 *  - CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID
 *  - CLOUDFLARE_AI_GATEWAY_ID
 *
 * @param env  Worker environment bindings
 * @param since  Optional start date (defaults to 24 hours ago)
 * @returns Aggregated cost data, or null if unavailable
 */
export async function fetchGatewayCosts(
  env: Env,
  since?: Date,
): Promise<GatewayCosts | null> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID;

  if (!token || !accountId || !gatewayId) {
    return null;
  }

  const start = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = new Date();

  const query = `
    query GatewayCosts($accountTag: String!, $filter: AccountAiGatewayRequestsAdaptiveGroupsFilter_InputObject!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          requests: aiGatewayRequestsAdaptiveGroups(
            limit: 1
            filter: $filter
          ) {
            count
            sum {
              cost
              tokensIn
              tokensOut
            }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: accountId,
    filter: {
      datetimeHour_geq: start.toISOString(),
      datetimeHour_leq: end.toISOString(),
      gateway: gatewayId,
    },
  };

  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      console.warn(`[CF Analytics] GraphQL request failed: ${response.status}`);
      return null;
    }

    const result = (await response.json()) as GraphQLResponse;

    if (result.errors?.length) {
      console.warn(`[CF Analytics] GraphQL errors: ${result.errors.map((e) => e.message).join(", ")}`);
      return null;
    }

    const bucket = result.data?.viewer?.accounts?.[0]?.requests?.[0];
    if (!bucket) {
      // No data for the period — return zeroes rather than null
      return { total_cost: 0, total_requests: 0, tokens_in: 0, tokens_out: 0 };
    }

    return {
      total_cost: bucket.sum?.cost ?? 0,
      total_requests: bucket.count,
      tokens_in: bucket.sum?.tokensIn ?? 0,
      tokens_out: bucket.sum?.tokensOut ?? 0,
    };
  } catch (error) {
    console.warn(`[CF Analytics] Failed to fetch gateway costs: ${String(error)}`);
    return null;
  }
}
