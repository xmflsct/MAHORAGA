/**
 * OpenInsider gatherer — insider trading signals from openinsider.com.
 *
 * No API key required. Scrapes the latest insider purchases page to detect
 * notable insider buying activity (Form 4 filings). Insider buying is one of
 * the strongest bullish signals — insiders buy for one reason only.
 *
 * Cached in KV for 30 minutes (insider filings don't update frequently).
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { tickerCache } from "../helpers/ticker";

// ---------------------------------------------------------------------------
// Cache config
// ---------------------------------------------------------------------------

const CACHE_KEY = "openinsider:latest";
const CACHE_TTL = 1800; // 30 minutes

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

interface InsiderTrade {
  filingDate: string;
  ticker: string;
  company: string;
  insiderName: string;
  title: string;
  tradeType: string; // "P - Purchase" or "S - Sale"
  price: number;
  qty: number;
  value: number;
  ownedAfter: number;
}

/**
 * Parse the OpenInsider HTML table to extract insider trades.
 *
 * OpenInsider renders a <table class="tinytable"> with columns:
 *   X | Filing Date | Trade Date | Ticker | Company Name | Insider Name | Title |
 *   Trade Type | Price | Qty | Owned | ΔOwn | Value
 */
function parseInsiderHTML(html: string): InsiderTrade[] {
  const trades: InsiderTrade[] = [];

  // Match each table row
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[0];

    // Skip header rows
    if (row.includes("<th")) continue;

    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    // Reset lastIndex for cellRegex
    cellRegex.lastIndex = 0;

    while ((cellMatch = cellRegex.exec(row)) !== null) {
      // Strip HTML tags and trim
      const text = (cellMatch[1] || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .trim();
      cells.push(text);
    }

    // OpenInsider tables typically have 13+ columns
    if (cells.length < 12) continue;

    // Column mapping (0-indexed):
    //  0: X (checkbox)
    //  1: Filing Date
    //  2: Trade Date
    //  3: Ticker
    //  4: Company Name
    //  5: Insider Name
    //  6: Title
    //  7: Trade Type
    //  8: Price
    //  9: Qty
    // 10: Owned
    // 11: ΔOwn
    // 12: Value

    const ticker = cells[3]?.toUpperCase();
    if (!ticker || ticker.length < 1 || ticker.length > 5) continue;

    const tradeType = cells[7] || "";
    const priceStr = (cells[8] || "").replace(/[$,]/g, "");
    const qtyStr = (cells[9] || "").replace(/[,+]/g, "");
    const valueStr = (cells[12] || "").replace(/[$,+]/g, "");
    const ownedStr = (cells[10] || "").replace(/[,+]/g, "");

    const price = parseFloat(priceStr);
    const qty = parseInt(qtyStr, 10);
    const value = parseFloat(valueStr);
    const ownedAfter = parseInt(ownedStr, 10);

    if (Number.isNaN(price) || Number.isNaN(value)) continue;

    trades.push({
      filingDate: cells[1] || "",
      ticker,
      company: cells[4] || "",
      insiderName: cells[5] || "",
      title: cells[6] || "",
      tradeType,
      price,
      qty: Number.isNaN(qty) ? 0 : Math.abs(qty),
      value: Math.abs(value),
      ownedAfter: Number.isNaN(ownedAfter) ? 0 : ownedAfter,
    });
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Sentiment scoring for insider trades
// ---------------------------------------------------------------------------

/**
 * Score an insider purchase. Higher = more bullish signal.
 * Factors: trade value, insider title, % ownership change.
 */
function scoreInsiderBuy(trade: InsiderTrade): number {
  let score = 0.3; // Base sentiment for any insider purchase

  // Large purchases are stronger signals
  if (trade.value >= 1_000_000) score += 0.4;
  else if (trade.value >= 500_000) score += 0.3;
  else if (trade.value >= 100_000) score += 0.2;
  else if (trade.value >= 50_000) score += 0.1;

  // C-suite purchases are more meaningful
  const titleUpper = trade.title.toUpperCase();
  if (titleUpper.includes("CEO") || titleUpper.includes("CHIEF EXECUTIVE")) score += 0.2;
  else if (titleUpper.includes("CFO") || titleUpper.includes("CHIEF FINANCIAL")) score += 0.15;
  else if (titleUpper.includes("COO") || titleUpper.includes("PRESIDENT")) score += 0.1;
  else if (titleUpper.includes("DIR") || titleUpper.includes("DIRECTOR")) score += 0.05;

  return Math.min(score, 1.0);
}

/**
 * Calculate freshness based on filing date.
 */
function calculateInsiderFreshness(filingDate: string): number {
  const date = new Date(filingDate);
  if (Number.isNaN(date.getTime())) return 0.5; // fallback for unparseable dates

  const ageMs = Date.now() - date.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 4) return 1.0;
  if (ageHours < 12) return 0.9;
  if (ageHours < 24) return 0.8;
  if (ageHours < 48) return 0.6;
  return 0.4;
}

// ---------------------------------------------------------------------------
// Main gatherer
// ---------------------------------------------------------------------------

async function gatherOpenInsider(ctx: StrategyContext): Promise<Signal[]> {
  // Check KV cache first
  const cached = await ctx.env.CACHE.get(CACHE_KEY, "json");
  if (cached) {
    ctx.log("OpenInsider", "cache_hit", {});
    return cached as Signal[];
  }

  try {
    // Fetch latest insider purchases (buys only, which are bullish signals)
    const res = await fetch(
      "http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=1&fdr=&td=0&tdr=&feession=&cession=&sidTicker=&ta=1&hession=1&hpession=1&hdession=1&foession=0&sc=3&vl=&vh=&ocl=&och=&session=1&ession=1&ntransl=&ntransh=&tession=",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      }
    );

    if (!res.ok) {
      ctx.log("OpenInsider", "fetch_error", { status: res.status });
      return [];
    }

    const html = await res.text();
    const trades = parseInsiderHTML(html);

    ctx.log("OpenInsider", "fetched", { tradeCount: trades.length });

    // Filter to purchases only (buys are the strongest signal)
    const purchases = trades.filter((t) => t.tradeType.toLowerCase().includes("purchase") || t.tradeType.startsWith("P"));

    // Aggregate per ticker
    const tickerData = new Map<
      string,
      {
        trades: InsiderTrade[];
        totalValue: number;
        bestScore: number;
        totalScore: number;
        bestFreshness: number;
      }
    >();

    for (const trade of purchases) {
      if (!tickerData.has(trade.ticker)) {
        tickerData.set(trade.ticker, {
          trades: [],
          totalValue: 0,
          bestScore: 0,
          totalScore: 0,
          bestFreshness: 0,
        });
      }
      const d = tickerData.get(trade.ticker)!;
      const score = scoreInsiderBuy(trade);
      const freshness = calculateInsiderFreshness(trade.filingDate);

      d.trades.push(trade);
      d.totalValue += trade.value;
      d.totalScore += score;
      d.bestScore = Math.max(d.bestScore, score);
      d.bestFreshness = Math.max(d.bestFreshness, freshness);
    }

    // Convert to signals with Alpaca validation
    const signals: Signal[] = [];
    const alpaca = createAlpacaProviders(ctx.env);
    const SOURCE_WEIGHT = 0.9; // insider trading is a very high-quality signal

    for (const [symbol, data] of tickerData) {
      // Validate ticker with Alpaca (same pattern as other gatherers)
      if (!tickerCache.isKnownSecTicker(symbol)) {
        const cached = tickerCache.getCachedValidation(symbol);
        if (cached === false) continue;
        if (cached === undefined) {
          const isValid = await tickerCache.validateWithAlpaca(symbol, alpaca);
          if (!isValid) {
            ctx.log("OpenInsider", "invalid_ticker_filtered", { symbol });
            continue;
          }
        }
      }

      const avgScore = data.totalScore / data.trades.length;
      // Multiple insiders buying = cluster signal, much stronger
      const clusterBonus = data.trades.length > 1 ? Math.min(0.2, data.trades.length * 0.05) : 0;
      const sentiment = Math.min(1.0, avgScore + clusterBonus);

      const topInsider = data.trades.reduce((a, b) => (b.value > a.value ? b : a));
      const tradeCount = data.trades.length;

      signals.push({
        symbol,
        source: "openinsider",
        source_detail: `openinsider_purchase${tradeCount > 1 ? "_cluster" : ""}`,
        sentiment: sentiment * SOURCE_WEIGHT,
        raw_sentiment: sentiment,
        volume: tradeCount,
        freshness: data.bestFreshness,
        source_weight: SOURCE_WEIGHT,
        reason: `Insider Buy: ${tradeCount} purchase${tradeCount > 1 ? "s" : ""}, $${formatValue(data.totalValue)} total (${topInsider.insiderName}${topInsider.title ? `, ${topInsider.title}` : ""})`,
        timestamp: Date.now(),
      });
    }

    // Cache in KV
    await ctx.env.CACHE.put(CACHE_KEY, JSON.stringify(signals), {
      expirationTtl: CACHE_TTL,
    });

    ctx.log("OpenInsider", "gathered_signals", { count: signals.length });
    return signals;
  } catch (error) {
    ctx.log("OpenInsider", "error", { message: String(error) });
    return [];
  }
}

function formatValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

export const openInsiderGatherer: Gatherer = {
  name: "openinsider",
  gather: gatherOpenInsider,
};
