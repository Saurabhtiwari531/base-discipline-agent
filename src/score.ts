/**
 * Discipline Score (0-100) — a rolling plan-adherence score per wallet.
 *
 * This is roadmap item 3 and the seed of the future API product: a single
 * number a trader can share (Farcaster card later) that says "I follow my
 * own plan", backed by on-chain evidence.
 *
 * Design principles:
 *  - PURE recomputation from UserState.trades — no stored counters, no new
 *    tables. Restart-safe by construction (trades are already in SQLite).
 *  - Measures adherence to the USER'S OWN rules (maxTradesPerDay,
 *    maxPositionSizeUsd, no-trade hours) plus two universal catastrophes that
 *    are never "in plan": liquidations and revenge reentries.
 *  - Explainable: every deduction is a line item the user can read. A score
 *    nobody understands is a score nobody shares.
 *  - Per-category caps so the 4h-rate-limited reality of signals matches the
 *    score (one bad hour is punished once, not per-trade into oblivion).
 *
 * Known caveats (accepted for v1):
 *  - "Day" boundaries are server-local (same TZ caveat as heuristics).
 *  - trades are capped at 200 in memory/DB; hyperactive wallets may see the
 *    window truncated. Fine at current scale.
 */
import {
  inNoTradeWindow,
  LEVERAGE_ESCALATION_FACTOR,
  REENTRY_WINDOW_MS,
} from "./heuristics.js";
import type { TradeEvent, UserState } from "./types.js";

export const SCORE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-violation deduction weights and per-category caps (counts, not points). */
const WEIGHTS = {
  liquidation: { points: 25, maxCount: 2, label: "liquidation" },
  reentry: { points: 20, maxCount: 2, label: "re-entry within 30m of a liquidation" },
  oversized: { points: 10, maxCount: 3, label: "position over your size limit" },
  overtradedDay: { points: 8, maxCount: 3, label: "day over your trade limit" },
  leverageJump: { points: 8, maxCount: 2, label: "leverage jump ≥1.5x between opens" },
  noTradeHours: { points: 4, maxCount: 3, label: "trade inside your no-trade hours" },
} as const;

type ViolationKey = keyof typeof WEIGHTS;

export interface ScoreBreakdownItem {
  /** Human-readable violation label (already user-facing). */
  label: string;
  /** How many occurrences were counted (after the per-category cap). */
  count: number;
  /** Total points deducted for this category (negative number). */
  points: number;
}

export interface DisciplineScore {
  /** 0-100. 100 = no plan violations observed in the window. */
  score: number;
  windowDays: number;
  /** Trades that fell inside the window (perp + spot). */
  tradesObserved: number;
  /** Non-zero deduction line items, largest deduction first. */
  breakdown: ScoreBreakdownItem[];
  computedAt: number;
}

/** Calm, factual grade labels — no hype, consistent with the persona. */
export function scoreLabel(score: number): string {
  if (score >= 90) return "holding the line";
  if (score >= 70) return "mostly on plan";
  if (score >= 40) return "slipping";
  return "off the plan";
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Compute the score as of `now`, over the trailing SCORE_WINDOW_DAYS.
 * Pure: reads state.trades / state.rules only, mutates nothing.
 */
export function computeDisciplineScore(
  state: UserState,
  now: number = Date.now(),
): DisciplineScore {
  const windowStart = now - SCORE_WINDOW_DAYS * DAY_MS;
  const inWindow = state.trades.filter(
    (t) => t.timestamp >= windowStart && t.timestamp <= now,
  );

  const counts: Record<ViolationKey, number> = {
    liquidation: 0,
    reentry: 0,
    oversized: 0,
    overtradedDay: 0,
    leverageJump: 0,
    noTradeHours: 0,
  };

  // --- universal catastrophes (never "in plan") ---

  const liquidations = inWindow.filter((t) => t.isPerp && t.isLiquidation);
  counts.liquidation = liquidations.length;

  // A perp open within REENTRY_WINDOW_MS after any liquidation = revenge reentry.
  const perpOpensAll = state.trades.filter((t) => t.isPerp && t.perpAction === "open");
  for (const liq of liquidations) {
    const revenge = perpOpensAll.some(
      (o) =>
        o.timestamp > liq.timestamp &&
        o.timestamp - liq.timestamp <= REENTRY_WINDOW_MS,
    );
    if (revenge) counts.reentry++;
  }

  // Leverage jumping >=1.5x between consecutive opens (later open in window).
  const leveredOpens = perpOpensAll.filter((t) => typeof t.leverage === "number");
  for (let i = 1; i < leveredOpens.length; i++) {
    const prev = leveredOpens[i - 1]!;
    const curr = leveredOpens[i]!;
    if (curr.timestamp < windowStart) continue;
    if (curr.leverage! >= prev.leverage! * LEVERAGE_ESCALATION_FACTOR) {
      counts.leverageJump++;
    }
  }

  // --- adherence to the user's own stated rules ---

  // Oversized positions (only when the user actually set a size limit).
  if (state.rules.maxPositionSizeUsd > 0) {
    counts.oversized = inWindow.filter(
      (t) => t.usdValue > state.rules.maxPositionSizeUsd,
    ).length;
  }

  // Days that exceeded the user's own daily trade limit.
  const byDay = new Map<number, number>();
  for (const t of inWindow) {
    const day = startOfLocalDay(t.timestamp);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  for (const n of byDay.values()) {
    if (n > state.rules.maxTradesPerDay) counts.overtradedDay++;
  }

  // Trades inside the user's own no-trade hours.
  counts.noTradeHours = inWindow.filter((t) =>
    inNoTradeWindow(
      new Date(t.timestamp).getHours(),
      state.rules.noTradeStartHour,
      state.rules.noTradeEndHour,
    ),
  ).length;

  // --- apply weights + caps ---

  const breakdown: ScoreBreakdownItem[] = [];
  let deducted = 0;
  for (const key of Object.keys(WEIGHTS) as ViolationKey[]) {
    const raw = counts[key];
    if (raw === 0) continue;
    const w = WEIGHTS[key];
    const counted = Math.min(raw, w.maxCount);
    const points = counted * w.points;
    deducted += points;
    breakdown.push({ label: w.label, count: counted, points: -points });
  }
  breakdown.sort((a, b) => a.points - b.points); // biggest deduction first

  return {
    score: Math.max(0, 100 - deducted),
    windowDays: SCORE_WINDOW_DAYS,
    tradesObserved: inWindow.length,
    breakdown,
    computedAt: now,
  };
}

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

/**
 * Shareable text card (Farcaster-ready). Factual and minimal — the image card
 * comes later; this text must stand on its own.
 */
export function formatScoreCard(wallet: string, s: DisciplineScore): string {
  const lines = [
    `🛡 Discipline Score: ${s.score}/100 — ${scoreLabel(s.score)}`,
    "",
    `${s.windowDays}-day plan adherence · ${shortWallet(wallet)}`,
    `${s.tradesObserved} trade(s) observed`,
  ];
  if (s.breakdown.length === 0) {
    lines.push("No plan violations in the window.");
  } else {
    lines.push("Points lost:");
    for (const item of s.breakdown) {
      lines.push(`· ${item.label}: ${item.count} (${item.points})`);
    }
  }
  return lines.join("\n");
}
