/**
 * Alpaca News gatherer — news-driven sentiment from the Alpaca News API.
 *
 * Uses the existing ALPACA_API_KEY / ALPACA_API_SECRET (no extra config).
 * Fetches recent news articles, extracts ticker mentions, and derives
 * bullish/bearish sentiment from headlines + summaries.
 *
 * Cached in KV for 10 minutes to stay within rate limits.
 */

import type { Signal } from "../../../core/types";
import type { Gatherer, StrategyContext } from "../../types";
import { detectSentiment } from "../helpers/sentiment";

// ---------------------------------------------------------------------------
// Cache config
// ---------------------------------------------------------------------------

const CACHE_KEY = "alpaca_news:latest";
const CACHE_TTL = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Alpaca News API types
// ---------------------------------------------------------------------------

interface AlpacaNewsArticle {
  id: number;
  headline: string;
  summary: string;
  author: string;
  created_at: string;
  updated_at: string;
  url: string;
  symbols: string[];
  source: string;
}

interface AlpacaNewsResponse {
  news: AlpacaNewsArticle[];
  next_page_token?: string;
}

// ---------------------------------------------------------------------------
// Headline-specific sentiment keywords (more news-oriented than social)
// ---------------------------------------------------------------------------

const NEWS_BULL_WORDS = [
  "upgrade",
  "beat",
  "beats",
  "surges",
  "soars",
  "jumps",
  "rallies",
  "rises",
  "gains",
  "breakout",
  "record",
  "outperform",
  "buy",
  "bullish",
  "growth",
  "profit",
  "revenue",
  "exceeds",
  "raised",
  "positive",
  "strong",
  "momentum",
  "catalyst",
  "approval",
  "launched",
  "partnership",
  "acquisition",
  "dividend",
  "buyback",
  "insider buying",
];

const NEWS_BEAR_WORDS = [
  "downgrade",
  "misses",
  "miss",
  "plunges",
  "drops",
  "falls",
  "tumbles",
  "slumps",
  "declines",
  "crash",
  "sell",
  "bearish",
  "warns",
  "warning",
  "risk",
  "loss",
  "deficit",
  "cuts",
  "layoffs",
  "recall",
  "lawsuit",
  "investigation",
  "fraud",
  "downside",
  "negative",
  "weak",
  "disappoints",
  "delays",
  "bankruptcy",
  "insider selling",
];

/**
 * News-specific sentiment detection using headline-optimized keywords.
 * Falls back to the general detectSentiment for the full text.
 */
function detectNewsSentiment(headline: string, summary: string): number {
  const text = `${headline} ${summary}`.toLowerCase();

  let bull = 0;
  let bear = 0;

  for (const w of NEWS_BULL_WORDS) if (text.includes(w)) bull++;
  for (const w of NEWS_BEAR_WORDS) if (text.includes(w)) bear++;

  // Blend with general sentiment detector for broader coverage
  const generalSentiment = detectSentiment(text);

  const total = bull + bear;
  if (total === 0) return generalSentiment * 0.5; // low-confidence fallback

  const newsSentiment = (bull - bear) / total;
  // Weight news keywords more heavily than general social keywords
  return newsSentiment * 0.7 + generalSentiment * 0.3;
}

/**
 * Calculate freshness score based on article age.
 */
function calculateNewsFreshness(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 1) return 1.0;
  if (ageHours < 2) return 0.9;
  if (ageHours < 4) return 0.8;
  if (ageHours < 8) return 0.6;
  if (ageHours < 24) return 0.4;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Main gatherer
// ---------------------------------------------------------------------------

async function gatherAlpacaNews(ctx: StrategyContext): Promise<Signal[]> {
  // Check KV cache first
  const cached = await ctx.env.CACHE.get(CACHE_KEY, "json");
  if (cached) {
    ctx.log("AlpacaNews", "cache_hit", {});
    return cached as Signal[];
  }

  try {
    const res = await fetch("https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc", {
      headers: {
        "APCA-API-KEY-ID": ctx.env.ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ctx.env.ALPACA_API_SECRET,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      ctx.log("AlpacaNews", "fetch_error", { status: res.status });
      return [];
    }

    const data = (await res.json()) as AlpacaNewsResponse;
    const articles = data.news || [];

    ctx.log("AlpacaNews", "fetched", { articleCount: articles.length });

    // Aggregate per ticker — multiple articles about the same ticker strengthen the signal
    const tickerData = new Map<
      string,
      {
        mentions: number;
        totalSentiment: number;
        totalFreshness: number;
        headlines: string[];
        sources: Set<string>;
      }
    >();

    for (const article of articles) {
      if (!article.symbols || article.symbols.length === 0) continue;

      const sentiment = detectNewsSentiment(article.headline, article.summary || "");
      const freshness = calculateNewsFreshness(article.created_at);

      for (const symbol of article.symbols) {
        // Filter non-stock-like symbols (crypto pairs, indexes, etc.)
        if (symbol.includes("/") || symbol.includes(".") || symbol.length > 5) continue;

        if (!tickerData.has(symbol)) {
          tickerData.set(symbol, {
            mentions: 0,
            totalSentiment: 0,
            totalFreshness: 0,
            headlines: [],
            sources: new Set(),
          });
        }

        const d = tickerData.get(symbol)!;
        d.mentions++;
        d.totalSentiment += sentiment * freshness; // freshness-weighted sentiment
        d.totalFreshness += freshness;
        d.headlines.push(article.headline.slice(0, 100));
        d.sources.add(article.source);
      }
    }

    // Convert to signals
    const signals: Signal[] = [];
    const SOURCE_WEIGHT = 0.85; // news is a high-quality source

    for (const [symbol, data] of tickerData) {
      const avgSentiment = data.totalSentiment / data.mentions;
      const avgFreshness = data.totalFreshness / data.mentions;

      // Only emit signals with some minimum activity or notable sentiment
      if (data.mentions >= 1 && Math.abs(avgSentiment) > 0.05) {
        signals.push({
          symbol,
          source: "alpaca_news",
          source_detail: `alpaca_news_${Array.from(data.sources).join("+")}`,
          sentiment: avgSentiment * SOURCE_WEIGHT,
          raw_sentiment: avgSentiment,
          volume: data.mentions,
          freshness: avgFreshness,
          source_weight: SOURCE_WEIGHT,
          reason: `News(${data.mentions} articles): ${data.headlines[0]}${data.mentions > 1 ? ` +${data.mentions - 1} more` : ""}`,
          timestamp: Date.now(),
        });
      }
    }

    // Cache in KV
    await ctx.env.CACHE.put(CACHE_KEY, JSON.stringify(signals), {
      expirationTtl: CACHE_TTL,
    });

    ctx.log("AlpacaNews", "gathered_signals", { count: signals.length });
    return signals;
  } catch (error) {
    ctx.log("AlpacaNews", "error", { message: String(error) });
    return [];
  }
}

export const alpacaNewsGatherer: Gatherer = {
  name: "alpaca_news",
  gather: gatherAlpacaNews,
};
