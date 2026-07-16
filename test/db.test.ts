/**
 * SQLite persistence tests — the DB is now load-bearing (restart = restore),
 * so the save/load round-trip is locked in here: what goes in must come back
 * out identically, duplicates must be ignored, pruning must keep the newest.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllUsers,
  loadLiquidationKeys,
  loadPerpCursor,
  openDb,
  persistSnapshot,
  persistTrades,
  saveBlockCursors,
  savePerpCursor,
  saveUser,
  updateSignalLog,
} from "../src/db.js";
import type { TradeEvent, UserState } from "../src/types.js";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-db-test-"));
  const db = openDb(join(dir, "test.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeState(over: Partial<UserState> = {}): UserState {
  return {
    wallet: "0xabc0000000000000000000000000000000000001",
    inboxId: "inbox-1",
    conversationId: "conv-1",
    rules: { maxTradesPerDay: 7, maxPositionSizeUsd: 500, noTradeStartHour: 23, noTradeEndHour: 6, notes: "no memecoins" },
    trades: [],
    snapshots: [],
    lastSignalAt: {},
    paused: false,
    onboardedAt: 1_700_000_000_000,
    ...over,
  };
}

let nonce = 0;
function trade(timestamp: number, over: Partial<TradeEvent> = {}): TradeEvent {
  return {
    txHash: `0x${(nonce++).toString(16).padStart(64, "0")}`,
    timestamp,
    wallet: "0xabc0000000000000000000000000000000000001",
    router: "0xrouter",
    routerName: "Test",
    usdValue: 0,
    ...over,
  };
}

test("user round-trip: rules, paused, cursors (BigInt), check-in timestamp", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState({
      paused: true,
      lastDailyCheckInAt: 1_700_000_123_456,
      lastBlockScanned: 123456789012345678901234n,
      lastPerpBlockScanned: 98765n,
    });
    saveUser(db, state);

    const [loaded] = loadAllUsers(db);
    assert.ok(loaded);
    assert.equal(loaded.wallet, state.wallet);
    assert.equal(loaded.inboxId, state.inboxId);
    assert.equal(loaded.conversationId, state.conversationId);
    assert.equal(loaded.paused, true);
    assert.equal(loaded.onboardedAt, state.onboardedAt);
    assert.equal(loaded.lastDailyCheckInAt, state.lastDailyCheckInAt);
    assert.equal(loaded.lastBlockScanned, state.lastBlockScanned);
    assert.equal(loaded.lastPerpBlockScanned, state.lastPerpBlockScanned);
    assert.deepEqual(loaded.rules, state.rules);
  } finally {
    cleanup();
  }
});

test("saveUser is an upsert: second save overwrites, no duplicate row", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    state.rules.maxTradesPerDay = 3;
    state.paused = true;
    saveUser(db, state);

    const all = loadAllUsers(db);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.rules.maxTradesPerDay, 3);
    assert.equal(all[0]!.paused, true);
  } finally {
    cleanup();
  }
});

test("trade round-trip preserves perp fields and chronological order", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    const t1 = trade(1000, { usdValue: 250.5, tokenInSymbol: "USDC", direction: "buy" });
    const t2 = trade(2000, {
      isPerp: true,
      perpAction: "close",
      isLiquidation: true,
      leverage: 12.5,
      pairIndex: 3,
      collateralUsd: 100,
      realizedPnlUsd: -99.5,
    });
    // Insert newest-first to prove ordering is restored from timestamps.
    persistTrades(db, state.conversationId, [t2, t1]);

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.trades.length, 2);
    assert.equal(loaded!.trades[0]!.txHash, t1.txHash); // chronological
    assert.equal(loaded!.trades[0]!.usdValue, 250.5);
    assert.equal(loaded!.trades[0]!.tokenInSymbol, "USDC");
    assert.equal(loaded!.trades[0]!.direction, "buy");
    const perp = loaded!.trades[1]!;
    assert.equal(perp.isPerp, true);
    assert.equal(perp.perpAction, "close");
    assert.equal(perp.isLiquidation, true);
    assert.equal(perp.leverage, 12.5);
    assert.equal(perp.pairIndex, 3);
    assert.equal(perp.collateralUsd, 100);
    assert.equal(perp.realizedPnlUsd, -99.5);
  } finally {
    cleanup();
  }
});

test("duplicate txHash is ignored (INSERT OR IGNORE)", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    const t = trade(1000);
    persistTrades(db, state.conversationId, [t]);
    persistTrades(db, state.conversationId, [t, trade(2000)]);

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.trades.length, 2);
  } finally {
    cleanup();
  }
});

test("trades prune to the newest 200 per user", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    const many = Array.from({ length: 205 }, (_, i) => trade(1000 + i));
    persistTrades(db, state.conversationId, many);

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.trades.length, 200);
    // Oldest 5 dropped: first kept trade is #5 (timestamp 1005).
    assert.equal(loaded!.trades[0]!.timestamp, 1005);
    assert.equal(loaded!.trades[199]!.timestamp, 1204);
  } finally {
    cleanup();
  }
});

test("snapshots round-trip in chronological order", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    persistSnapshot(db, state.conversationId, { timestamp: 2000, ethBalance: 1.5, usdValue: 4500 });
    persistSnapshot(db, state.conversationId, { timestamp: 1000, ethBalance: 2, usdValue: 6000 });

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.snapshots.length, 2);
    assert.equal(loaded!.snapshots[0]!.timestamp, 1000);
    assert.equal(loaded!.snapshots[1]!.usdValue, 4500);
  } finally {
    cleanup();
  }
});

test("signal_log upserts and restores into lastSignalAt", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    updateSignalLog(db, state.conversationId, "frequency_spike", 111);
    updateSignalLog(db, state.conversationId, "frequency_spike", 222); // upsert
    updateSignalLog(db, state.conversationId, "post_liquidation_reentry", 333);

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.lastSignalAt.frequency_spike, 222);
    assert.equal(loaded!.lastSignalAt.post_liquidation_reentry, 333);
  } finally {
    cleanup();
  }
});

test("perp cursor BigInt round-trip via settings", () => {
  const { db, cleanup } = makeDb();
  try {
    assert.equal(loadPerpCursor(db), undefined);
    savePerpCursor(db, 34028236692093846346337460743n);
    assert.equal(loadPerpCursor(db), 34028236692093846346337460743n);
    savePerpCursor(db, 42n); // overwrite
    assert.equal(loadPerpCursor(db), 42n);
  } finally {
    cleanup();
  }
});

test("saveBlockCursors updates only cursors", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    state.lastBlockScanned = 777n;
    state.lastPerpBlockScanned = 888n;
    saveBlockCursors(db, state);

    const [loaded] = loadAllUsers(db);
    assert.equal(loaded!.lastBlockScanned, 777n);
    assert.equal(loaded!.lastPerpBlockScanned, 888n);
  } finally {
    cleanup();
  }
});

test("loadLiquidationKeys restores the post-mortem dedup set", () => {
  const { db, cleanup } = makeDb();
  try {
    const state = makeState();
    saveUser(db, state);
    const liq = trade(1000, { isPerp: true, perpAction: "close", isLiquidation: true });
    persistTrades(db, state.conversationId, [liq, trade(2000)]);

    const keys = loadLiquidationKeys(db);
    assert.equal(keys.size, 1);
    assert.ok(keys.has(`${state.wallet}:${liq.txHash}`));
  } finally {
    cleanup();
  }
});
