/**
 * Heuristics layer — decides WHEN to intervene.
 *
 * Non-negotiable design rules (see CLAUDE.md):
 *  - This file, not the LLM, decides whether a message is warranted.
 *  - The same signal type fires at most once per 4 hours (rate limit lives here).
 *  - Rules enforce the USER'S OWN plan (UserRules), not a generic ruleset.
 *
 * Each rule is a small pure-ish function returning `Signal | null`. `runHeuristics`
 * evaluates them all, applies the 4h cooldown, marks fired signals, and returns
 * the ones that should actually be sent.
 */
import type { Signal, SignalType, TradeEvent, UserState } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 4 * HOUR_MS;

// --- Tunables (kept here so they're easy to tweak during validation) ---
const FREQUENCY_WINDOW_MS = 1 * HOUR_MS;
const FREQUENCY_THRESHOLD = 6; // trades in the window before we flag a spike
const FREQUENCY_HIGH = 10;
const SIZE_ESCALATION_FACTOR = 1.5; // latest position vs previous
const CHURN_WINDOW_MS = 2 * HOUR_MS;
const CHURN_DISTINCT_TOKENS = 4;
const DRAWDOWN_WINDOW_MS = 6 * HOUR_MS;
const DRAWDOWN_PCT = 0.2; // 20% drop in portfolio value within the window
const LEVERAGE_ESCALATION_FACTOR = 1.5; // leverage ratio jump between consecutive opens
const REENTRY_WINDOW_MS = 30 * 60 * 1000; // "minutes after a liquidation" window

/** Whether a signal type is allowed to fire again given the 4h cooldown. */
export function canFire(state: UserState, type: SignalType, now: number): boolean {
  const last = state.lastSignalAt[type] ?? 0;
  return now - last >= SIGNAL_COOLDOWN_MS;
}

function markFired(state: UserState, type: SignalType, now: number): void {
  state.lastSignalAt[type] = now;
}

// --- small helpers ---

function tradesInWindow(state: UserState, windowMs: number, now: number): TradeEvent[] {
  const cutoff = now - windowMs;
  return state.trades.filter((t) => t.timestamp >= cutoff);
}

function tradesToday(state: UserState, now: number): TradeEvent[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0); // server-local midnight (TZ caveat: see roadmap)
  const startMs = start.getTime();
  return state.trades.filter((t) => t.timestamp >= startMs);
}

/** True if the given local hour falls inside the user's no-trade window. */
function inNoTradeWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // window wraps past midnight, e.g. 22 -> 5
  return hour >= startHour || hour < endHour;
}

// --- the 7 base rules ---

/** 1. Unusually high trade frequency in a short window — classic tilt tell. */
function frequencySpike(state: UserState, now: number): Signal | null {
  const recent = tradesInWindow(state, FREQUENCY_WINDOW_MS, now);
  if (recent.length < FREQUENCY_THRESHOLD) return null;
  const severity = recent.length >= FREQUENCY_HIGH ? "high" : "medium";
  return {
    type: "frequency_spike",
    severity,
    wallet: state.wallet,
    detectedAt: now,
    summary: `${recent.length} trades in the last hour.`,
    data: { count: recent.length, windowMinutes: FREQUENCY_WINDOW_MS / 60000 },
  };
}

/**
 * 2. Position size escalating after a loss (loss-chasing).
 * DORMANT until trades carry real usdValue (see CLAUDE.md stubs). Guarded so it
 * never fires on stub zeros.
 */
function sizeEscalation(state: UserState, now: number): Signal | null {
  const sized = state.trades.filter((t) => t.usdValue > 0);
  if (sized.length < 2) return null;
  const latest = sized[sized.length - 1];
  const prev = sized[sized.length - 2];
  if (!latest || !prev) return null;
  if (latest.usdValue < prev.usdValue * SIZE_ESCALATION_FACTOR) return null;
  return {
    type: "size_escalation",
    severity: "high",
    wallet: state.wallet,
    detectedAt: now,
    summary: `Position size jumped from ~$${Math.round(prev.usdValue)} to ~$${Math.round(
      latest.usdValue,
    )}.`,
    data: { previousUsd: prev.usdValue, latestUsd: latest.usdValue },
  };
}

/** 3. Trading inside the user's own declared no-trade hours. */
function lateNight(state: UserState, now: number): Signal | null {
  const latest = state.trades[state.trades.length - 1];
  if (!latest) return null;
  const hour = new Date(latest.timestamp).getHours();
  if (!inNoTradeWindow(hour, state.rules.noTradeStartHour, state.rules.noTradeEndHour)) {
    return null;
  }
  return {
    type: "late_night",
    severity: "medium",
    wallet: state.wallet,
    detectedAt: now,
    summary: `Trading at ${String(hour).padStart(2, "0")}:00, inside your no-trade window.`,
    data: { hour },
  };
}

/**
 * 4. Churning through many different fresh tokens quickly (FOMO rotation).
 * Approximation: distinct tokenOut addresses within a short window. Precise
 * "new token" detection needs token-age data from an indexer (roadmap).
 */
function newTokenChurn(state: UserState, now: number): Signal | null {
  const recent = tradesInWindow(state, CHURN_WINDOW_MS, now);
  const distinct = new Set(
    recent.map((t) => t.tokenOut?.toLowerCase()).filter((x): x is string => Boolean(x)),
  );
  if (distinct.size < CHURN_DISTINCT_TOKENS) return null;
  return {
    type: "new_token_churn",
    severity: "medium",
    wallet: state.wallet,
    detectedAt: now,
    summary: `${distinct.size} different tokens traded in the last ${
      CHURN_WINDOW_MS / HOUR_MS
    } hours.`,
    data: { distinctTokens: distinct.size },
  };
}

/** 5. Portfolio value dropping fast — a fast bleed often precedes panic trades. */
function drawdownVelocity(state: UserState, now: number): Signal | null {
  const cutoff = now - DRAWDOWN_WINDOW_MS;
  const window = state.snapshots.filter((s) => s.timestamp >= cutoff);
  if (window.length < 2) return null;
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last || first.usdValue <= 0) return null;
  const drop = (first.usdValue - last.usdValue) / first.usdValue;
  if (drop < DRAWDOWN_PCT) return null;
  return {
    type: "drawdown_velocity",
    severity: drop >= DRAWDOWN_PCT * 2 ? "high" : "medium",
    wallet: state.wallet,
    detectedAt: now,
    summary: `Portfolio down ${Math.round(drop * 100)}% in the last ${
      DRAWDOWN_WINDOW_MS / HOUR_MS
    } hours.`,
    data: { dropPct: drop },
  };
}

/** 6. Explicit own-rule break: more trades today than the user allowed. */
function ruleBreakMaxTrades(state: UserState, now: number): Signal | null {
  const limit = state.rules.maxTradesPerDay;
  if (!limit || limit <= 0) return null;
  const count = tradesToday(state, now).length;
  if (count < limit) return null;
  return {
    type: "rule_break_max_trades",
    severity: "high",
    wallet: state.wallet,
    detectedAt: now,
    summary: `${count} trades today — your own limit is ${limit}.`,
    data: { count, limit },
  };
}

/**
 * 7. Explicit own-rule break: a single position over the user's max size.
 * DORMANT until usdValue is real AND the user has set a size limit.
 */
function ruleBreakPositionSize(state: UserState, now: number): Signal | null {
  const limit = state.rules.maxPositionSizeUsd;
  if (!limit || limit <= 0) return null;
  const offending = state.trades.find((t) => t.usdValue > limit);
  if (!offending) return null;
  return {
    type: "rule_break_position_size",
    severity: "high",
    wallet: state.wallet,
    detectedAt: now,
    summary: `A position of ~$${Math.round(
      offending.usdValue,
    )} exceeds your own max size of $${limit}.`,
    data: { usdValue: offending.usdValue, limit },
  };
}

// --- perps rules (CURRENT TASK: Avantis) ---

function perpOpens(state: UserState): TradeEvent[] {
  return state.trades.filter(
    (t) => t.isPerp && t.perpAction === "open" && typeof t.leverage === "number",
  );
}

/**
 * Leverage climbing across consecutive opens — loss-chasing with size. Compares
 * normalized leverage (verified 1e10-scaled, e.g. 20x) between consecutive opens.
 * Severity escalates to high when a losing close sits between the two opens (the
 * classic tilt sequence), now that closes carry real realizedPnlUsd.
 */
function leverageEscalation(state: UserState, now: number): Signal | null {
  const opens = perpOpens(state);
  if (opens.length < 2) return null;
  const latest = opens[opens.length - 1];
  const prev = opens[opens.length - 2];
  if (!latest || !prev || !prev.leverage || !latest.leverage) return null;
  if (latest.leverage < prev.leverage * LEVERAGE_ESCALATION_FACTOR) return null;

  const losingCloseBetween = state.trades.some(
    (t) =>
      t.isPerp &&
      t.perpAction === "close" &&
      typeof t.realizedPnlUsd === "number" &&
      t.realizedPnlUsd < 0 &&
      t.timestamp > prev.timestamp &&
      t.timestamp < latest.timestamp,
  );

  return {
    type: "leverage_escalation",
    severity: losingCloseBetween ? "high" : "medium",
    wallet: state.wallet,
    detectedAt: now,
    summary: `Leverage went from ${prev.leverage}x to ${latest.leverage}x${
      losingCloseBetween ? " right after a losing close" : ""
    }.`,
    data: {
      previousLeverage: prev.leverage,
      latestLeverage: latest.leverage,
      afterLoss: losingCloseBetween,
    },
  };
}

/**
 * THE revenge-trading signal (highest severity): opening a new position within
 * minutes of a liquidation. Live — liquidations are decoded from Avantis
 * TradingCallbacks LimitExecuted (orderType == 2) in src/perps/avantis.ts.
 */
function postLiquidationReentry(state: UserState, now: number): Signal | null {
  const liquidations = state.trades.filter((t) => t.isPerp && t.isLiquidation);
  if (liquidations.length === 0) return null;
  const lastLiq = liquidations[liquidations.length - 1];
  if (!lastLiq) return null;

  const reentry = state.trades.find(
    (t) =>
      t.isPerp &&
      t.perpAction === "open" &&
      t.timestamp > lastLiq.timestamp &&
      t.timestamp - lastLiq.timestamp <= REENTRY_WINDOW_MS,
  );
  if (!reentry) return null;

  const minutes = Math.round((reentry.timestamp - lastLiq.timestamp) / 60000);
  return {
    type: "post_liquidation_reentry",
    severity: "high",
    wallet: state.wallet,
    detectedAt: now,
    summary: `New position opened ${minutes} minute(s) after a liquidation.`,
    data: { minutesAfterLiquidation: minutes, liquidationTx: lastLiq.txHash },
  };
}

const RULES: ((state: UserState, now: number) => Signal | null)[] = [
  frequencySpike,
  sizeEscalation,
  lateNight,
  newTokenChurn,
  drawdownVelocity,
  ruleBreakMaxTrades,
  ruleBreakPositionSize,
  leverageEscalation,
  postLiquidationReentry,
];

/**
 * Evaluate every rule, apply the 4h-per-signal cooldown, mark fired signals, and
 * return the ones that should be sent now. Mutates state.lastSignalAt.
 */
export function runHeuristics(state: UserState, now: number = Date.now()): Signal[] {
  const fired: Signal[] = [];
  for (const rule of RULES) {
    const signal = rule(state, now);
    if (!signal) continue;
    if (!canFire(state, signal.type, now)) continue;
    markFired(state, signal.type, now);
    fired.push(signal);
  }
  return fired;
}
