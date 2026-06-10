/**
 * Heuristics tests — these lock in the signals that ARE the product pitch,
 * especially post_liquidation_reentry (the revenge-trade tell) and the 4h
 * rate limit (anti-notification-fatigue). Run: npm test
 *
 * Tests go through the real entrypoint `runHeuristics`, so they also exercise
 * the cooldown gate, not just the individual rule functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeuristics } from "../src/heuristics.js";
import type { TradeEvent, UserState } from "../src/types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A baseline state that fires NOTHING, so each test can turn on exactly one
 * signal. maxTradesPerDay is high (no rule_break), size limit is 0 (dormant),
 * and the no-trade window is empty (start==end ⇒ late_night never fires).
 */
function baseState(over: Partial<UserState> = {}): UserState {
  return {
    wallet: "0xtester",
    inboxId: "i",
    conversationId: "c",
    rules: { maxTradesPerDay: 100, maxPositionSizeUsd: 0, noTradeStartHour: 0, noTradeEndHour: 0 },
    trades: [],
    snapshots: [],
    lastSignalAt: {},
    paused: false,
    onboardedAt: 0,
    ...over,
  };
}

let nonce = 0;
function trade(timestamp: number, over: Partial<TradeEvent> = {}): TradeEvent {
  return {
    txHash: `0x${(nonce++).toString(16).padStart(64, "0")}`,
    timestamp,
    wallet: "0xtester",
    router: "0xrouter",
    routerName: "Test",
    usdValue: 0,
    ...over,
  };
}

function types(signals: { type: string }[]): string[] {
  return signals.map((s) => s.type);
}

test("frequency_spike fires on >=6 trades within the last hour", () => {
  const now = 1_700_000_000_000;
  const trades = Array.from({ length: 6 }, (_, i) => trade(now - i * 5 * MIN));
  const fired = runHeuristics(baseState({ trades }), now);
  assert.ok(types(fired).includes("frequency_spike"));
});

test("frequency_spike does NOT fire below the threshold", () => {
  const now = 1_700_000_000_000;
  const trades = Array.from({ length: 5 }, (_, i) => trade(now - i * 5 * MIN));
  const fired = runHeuristics(baseState({ trades }), now);
  assert.ok(!types(fired).includes("frequency_spike"));
});

test("size_escalation fires when a position grows >=1.5x", () => {
  const now = 1_700_000_000_000;
  const trades = [
    trade(now - 20 * MIN, { usdValue: 100 }),
    trade(now - 10 * MIN, { usdValue: 200 }),
  ];
  const fired = runHeuristics(baseState({ trades }), now);
  assert.ok(types(fired).includes("size_escalation"));
});

test("size_escalation does NOT fire when size stays flat", () => {
  const now = 1_700_000_000_000;
  const trades = [
    trade(now - 20 * MIN, { usdValue: 100 }),
    trade(now - 10 * MIN, { usdValue: 110 }),
  ];
  const fired = runHeuristics(baseState({ trades }), now);
  assert.ok(!types(fired).includes("size_escalation"));
});

test("post_liquidation_reentry fires (high) on a reopen within 30m of a liquidation", () => {
  const now = 1_700_000_000_000;
  const liq = trade(now - 20 * MIN, {
    isPerp: true,
    perpAction: "close",
    isLiquidation: true,
    leverage: 50,
    realizedPnlUsd: -100,
  });
  const reopen = trade(now - 5 * MIN, { isPerp: true, perpAction: "open", leverage: 50, collateralUsd: 100 });
  const fired = runHeuristics(baseState({ trades: [liq, reopen] }), now);
  const sig = fired.find((s) => s.type === "post_liquidation_reentry");
  assert.ok(sig, "post_liquidation_reentry should fire");
  assert.equal(sig.severity, "high");
});

test("post_liquidation_reentry does NOT fire when the reopen is >30m after the liquidation", () => {
  const now = 1_700_000_000_000;
  const liq = trade(now - 45 * MIN, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 50 });
  const reopen = trade(now - 2 * MIN, { isPerp: true, perpAction: "open", leverage: 50 });
  const fired = runHeuristics(baseState({ trades: [liq, reopen] }), now);
  assert.ok(!types(fired).includes("post_liquidation_reentry"));
});

test("4-hour rate limit suppresses a duplicate signal, then lets it fire again", () => {
  const T = 1_700_000_000_000;
  const burst = (center: number) => Array.from({ length: 6 }, (_, i) => trade(center - i * 5 * MIN));
  const state = baseState({ trades: burst(T) });

  const first = runHeuristics(state, T);
  assert.ok(types(first).includes("frequency_spike"), "fires the first time");

  // Same condition, same instant: must be suppressed by the 4h cooldown.
  const second = runHeuristics(state, T);
  assert.ok(!types(second).includes("frequency_spike"), "suppressed within 4h");

  // Fresh trades 4h+ later: cooldown elapsed, fires again.
  const T2 = T + 4 * HOUR + 1000;
  state.trades = burst(T2);
  const third = runHeuristics(state, T2);
  assert.ok(types(third).includes("frequency_spike"), "fires again after 4h");
});
