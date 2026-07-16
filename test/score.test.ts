/**
 * Discipline Score tests — lock in the scoring model before it becomes the
 * shareable card / API product. The score must be explainable and stable:
 * these tests ARE the spec. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDisciplineScore, formatScoreCard, scoreLabel } from "../src/score.js";
import type { TradeEvent, UserState } from "../src/types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Noon local time, so no-trade-hour tests are deterministic vs day boundaries. */
function noonAt(base: number): number {
  const d = new Date(base);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

const NOW = noonAt(1_700_000_000_000);

/** Baseline: generous rules so nothing counts as a violation by default. */
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

test("clean history scores 100 with an empty breakdown", () => {
  const trades = [trade(NOW - 2 * DAY, { usdValue: 100 }), trade(NOW - DAY, { usdValue: 100 })];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 100);
  assert.equal(s.breakdown.length, 0);
  assert.equal(s.tradesObserved, 2);
});

test("no trades at all scores 100 (not trading breaks no rule)", () => {
  const s = computeDisciplineScore(baseState(), NOW);
  assert.equal(s.score, 100);
  assert.equal(s.tradesObserved, 0);
});

test("one liquidation deducts 25", () => {
  const trades = [
    trade(NOW - DAY, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
  ];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 75);
  assert.equal(s.breakdown.length, 1);
  assert.equal(s.breakdown[0]!.points, -25);
});

test("liquidation + revenge reentry within 30m deducts 25 + 20", () => {
  const liqAt = NOW - DAY;
  const trades = [
    trade(liqAt, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
    trade(liqAt + 10 * MIN, { isPerp: true, perpAction: "open", leverage: 10 }),
  ];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 55);
});

test("reentry 31+ minutes after liquidation is NOT counted as revenge", () => {
  const liqAt = NOW - DAY;
  const trades = [
    trade(liqAt, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
    trade(liqAt + 45 * MIN, { isPerp: true, perpAction: "open", leverage: 10 }),
  ];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 75); // liquidation only
});

test("violations older than the 14-day window do not count", () => {
  const trades = [
    trade(NOW - 20 * DAY, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
  ];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 100);
  assert.equal(s.tradesObserved, 0);
});

test("oversized trades count only when the user set a size limit", () => {
  const trades = [trade(NOW - DAY, { usdValue: 900 })];

  const noLimit = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(noLimit.score, 100);

  const withLimit = computeDisciplineScore(
    baseState({
      trades,
      rules: { maxTradesPerDay: 100, maxPositionSizeUsd: 500, noTradeStartHour: 0, noTradeEndHour: 0 },
    }),
    NOW,
  );
  assert.equal(withLimit.score, 90); // one oversized trade = -10
});

test("a day over the user's trade limit deducts 8 per day, capped at 3 days", () => {
  // 4 separate days, each with 3 trades against a limit of 2.
  const trades: TradeEvent[] = [];
  for (let d = 1; d <= 4; d++) {
    for (let i = 0; i < 3; i++) trades.push(trade(NOW - d * DAY + i * MIN));
  }
  const s = computeDisciplineScore(
    baseState({
      trades,
      rules: { maxTradesPerDay: 2, maxPositionSizeUsd: 0, noTradeStartHour: 0, noTradeEndHour: 0 },
    }),
    NOW,
  );
  assert.equal(s.score, 100 - 3 * 8); // cap at 3 counted days
});

test("leverage jump >=1.5x between consecutive opens deducts 8", () => {
  const trades = [
    trade(NOW - 2 * HOUR, { isPerp: true, perpAction: "open", leverage: 3 }),
    trade(NOW - HOUR, { isPerp: true, perpAction: "open", leverage: 10 }),
  ];
  const s = computeDisciplineScore(baseState({ trades }), NOW);
  assert.equal(s.score, 92);
});

test("trades inside the user's no-trade hours deduct 4 each", () => {
  const twoAm = new Date(NOW - DAY);
  twoAm.setHours(2, 0, 0, 0);
  const trades = [trade(twoAm.getTime())];
  const s = computeDisciplineScore(
    baseState({
      trades,
      rules: { maxTradesPerDay: 100, maxPositionSizeUsd: 0, noTradeStartHour: 0, noTradeEndHour: 5 },
    }),
    NOW,
  );
  assert.equal(s.score, 96);
});

test("score floors at 0 under stacked violations", () => {
  const trades: TradeEvent[] = [];
  // 2 liquidations, each followed by a revenge reentry with escalating leverage.
  for (let i = 0; i < 2; i++) {
    const liqAt = NOW - (i + 1) * DAY;
    trades.push(
      trade(liqAt, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
      trade(liqAt + 5 * MIN, { isPerp: true, perpAction: "open", leverage: 10 * (i + 2), usdValue: 2000 }),
    );
  }
  // Plus oversized spot churn over the limit.
  for (let i = 0; i < 6; i++) trades.push(trade(NOW - 3 * HOUR + i * MIN, { usdValue: 2000 }));
  trades.sort((a, b) => a.timestamp - b.timestamp);

  const s = computeDisciplineScore(
    baseState({
      trades,
      rules: { maxTradesPerDay: 1, maxPositionSizeUsd: 100, noTradeStartHour: 0, noTradeEndHour: 0 },
    }),
    NOW,
  );
  assert.equal(s.score, 0);
});

test("scoreLabel bands are calm and monotonic", () => {
  assert.equal(scoreLabel(100), "holding the line");
  assert.equal(scoreLabel(90), "holding the line");
  assert.equal(scoreLabel(75), "mostly on plan");
  assert.equal(scoreLabel(50), "slipping");
  assert.equal(scoreLabel(10), "off the plan");
});

test("formatScoreCard renders score, window, wallet and line items", () => {
  const trades = [
    trade(NOW - DAY, { isPerp: true, perpAction: "close", isLiquidation: true, leverage: 10 }),
  ];
  const state = baseState({ trades, wallet: "0x1234567890abcdef1234567890abcdef12345678" });
  const card = formatScoreCard(state.wallet, computeDisciplineScore(state, NOW));
  assert.match(card, /Discipline Score: 75\/100/);
  assert.match(card, /14-day plan adherence/);
  assert.match(card, /0x1234…5678/);
  assert.match(card, /liquidation: 1 \(-25\)/);
});

test("clean card says so explicitly", () => {
  const card = formatScoreCard("0xtester", computeDisciplineScore(baseState(), NOW));
  assert.match(card, /No plan violations in the window\./);
});
