/**
 * Reddit gatherer — sentiment from r/wallstreetbets, r/stocks, r/investing, r/options.
 *
 * Subreddit responses are cached in KV for 10 minutes to minimize API calls
 * and avoid Reddit's aggressive rate limiting (429s) on datacenter IPs.
 * Includes retry with backoff for transient failures.
 */

import type { Env } from "../../../env.d";
import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { calculateTimeDecay, detectSentiment, getEngagementMultiplier, getFlairMultiplier } from "../helpers/sentiment";
import { extractTickers, tickerCache } from "../helpers/ticker";

// ---------------------------------------------------------------------------
// Cache & retry config
// ---------------------------------------------------------------------------

/** How long to cache subreddit data in KV (seconds) */
const CACHE_TTL = 600; // 10 minutes

/** Max retries for a single subreddit fetch */
const MAX_RETRIES = 2;

/** Base delay for exponential backoff (ms) */
const BACKOFF_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// Subreddit fetching with KV cache + retry
// ---------------------------------------------------------------------------

interface RedditPost {
  title?: string;
  selftext?: string;
  created_utc?: number;
  ups?: number;
  num_comments?: number;
  link_flair_text?: string;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{ data: RedditPost }>;
  };
}

/**
 * Fetch hot posts from a subreddit with KV caching and retry logic.
 */
async function fetchSubredditPosts(
  sub: string,
  env: Env,
  log: StrategyContext["log"],
  sleep: StrategyContext["sleep"]
): Promise<RedditPost[]> {
  const cacheKey = `reddit:sub:${sub}`;

  // Check KV cache first
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) {
    log("Reddit", "cache_hit", { subreddit: sub });
    return cached as RedditPost[];
  }

  // Fetch with retry + backoff
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`, {
        headers: {
          "User-Agent": "web:mahoraga:v2.0 (by /u/mahoraga_bot)",
          Accept: "application/json",
        },
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : BACKOFF_BASE_MS * Math.pow(2, attempt);

        log("Reddit", "rate_limited", {
          subreddit: sub,
          attempt: attempt + 1,
          waitMs,
          retryAfter,
        });

        if (attempt < MAX_RETRIES) {
          await sleep(waitMs);
          continue;
        }
        return [];
      }

      if (!res.ok) {
        log("Reddit", "fetch_error", {
          subreddit: sub,
          status: res.status,
          attempt: attempt + 1,
        });
        return [];
      }

      const data = (await res.json()) as RedditListingResponse;
      const posts = data.data?.children?.map((c) => c.data) || [];

      // Cache in KV
      await env.CACHE.put(cacheKey, JSON.stringify(posts), {
        expirationTtl: CACHE_TTL,
      });

      log("Reddit", "fetched", {
        subreddit: sub,
        postCount: posts.length,
      });

      return posts;
    } catch (error) {
      log("Reddit", "fetch_exception", {
        subreddit: sub,
        attempt: attempt + 1,
        error: String(error),
      });

      if (attempt < MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      return [];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main gatherer
// ---------------------------------------------------------------------------

async function gatherReddit(ctx: StrategyContext): Promise<Signal[]> {
  const subreddits = ["wallstreetbets", "stocks", "investing", "options"];
  const tickerData = new Map<
    string,
    {
      mentions: number;
      weightedSentiment: number;
      rawSentiment: number;
      totalQuality: number;
      upvotes: number;
      comments: number;
      sources: Set<string>;
      bestFlair: string | null;
      bestFlairMult: number;
      freshestPost: number;
    }
  >();

  for (const sub of subreddits) {
    const sourceWeight = SOURCE_CONFIG.weights[`reddit_${sub}` as keyof typeof SOURCE_CONFIG.weights] || 0.7;

    try {
      const posts = await fetchSubredditPosts(sub, ctx.env, ctx.log, ctx.sleep);

      for (const post of posts) {
        const text = `${post.title || ""} ${post.selftext || ""}`;
        const tickers = extractTickers(text, ctx.config.ticker_blacklist);
        const rawSentiment = detectSentiment(text);

        const timeDecay = calculateTimeDecay(post.created_utc || Date.now() / 1000);
        const engagementMult = getEngagementMultiplier(post.ups || 0, post.num_comments || 0);
        const flairMult = getFlairMultiplier(post.link_flair_text);
        const qualityScore = timeDecay * engagementMult * flairMult * sourceWeight;

        for (const ticker of tickers) {
          if (!tickerData.has(ticker)) {
            tickerData.set(ticker, {
              mentions: 0,
              weightedSentiment: 0,
              rawSentiment: 0,
              totalQuality: 0,
              upvotes: 0,
              comments: 0,
              sources: new Set(),
              bestFlair: null,
              bestFlairMult: 0,
              freshestPost: 0,
            });
          }
          const d = tickerData.get(ticker)!;
          d.mentions++;
          d.rawSentiment += rawSentiment;
          d.weightedSentiment += rawSentiment * qualityScore;
          d.totalQuality += qualityScore;
          d.upvotes += post.ups || 0;
          d.comments += post.num_comments || 0;
          d.sources.add(sub);

          if (flairMult > d.bestFlairMult) {
            d.bestFlair = post.link_flair_text || null;
            d.bestFlairMult = flairMult;
          }

          if ((post.created_utc || 0) > d.freshestPost) {
            d.freshestPost = post.created_utc || 0;
          }
        }
      }

      // Stagger requests to avoid bursting (only matters for cache misses)
      await ctx.sleep(2000);
    } catch (error) {
      ctx.log("Reddit", "subreddit_error", { subreddit: sub, error: String(error) });
    }
  }

  const signals: Signal[] = [];
  const alpaca = createAlpacaProviders(ctx.env);

  for (const [symbol, data] of tickerData) {
    if (data.mentions >= 2) {
      if (!tickerCache.isKnownSecTicker(symbol)) {
        const cached = tickerCache.getCachedValidation(symbol);
        if (cached === false) continue;
        if (cached === undefined) {
          const isValid = await tickerCache.validateWithAlpaca(symbol, alpaca);
          if (!isValid) {
            ctx.log("Reddit", "invalid_ticker_filtered", { symbol });
            continue;
          }
        }
      }

      const avgRawSentiment = data.rawSentiment / data.mentions;
      const avgQuality = data.totalQuality / data.mentions;
      const finalSentiment = data.totalQuality > 0 ? data.weightedSentiment / data.mentions : avgRawSentiment * 0.5;
      const freshness = calculateTimeDecay(data.freshestPost);

      signals.push({
        symbol,
        source: "reddit",
        source_detail: `reddit_${Array.from(data.sources).join("+")}`,
        sentiment: finalSentiment,
        raw_sentiment: avgRawSentiment,
        volume: data.mentions,
        upvotes: data.upvotes,
        comments: data.comments,
        quality_score: avgQuality,
        freshness,
        best_flair: data.bestFlair,
        subreddits: Array.from(data.sources),
        source_weight: avgQuality,
        reason: `Reddit(${Array.from(data.sources).join(",")}): ${data.mentions} mentions, ${data.upvotes} upvotes, quality:${(avgQuality * 100).toFixed(0)}%`,
        timestamp: Date.now(),
      });
    }
  }

  return signals;
}

export const redditGatherer: Gatherer = {
  name: "reddit",
  gather: gatherReddit,
};
