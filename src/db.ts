/**
 * SQLite persistence layer — uses Node's built-in `node:sqlite` (Node 22.5+).
 * No extra dependencies; synchronous API keeps the code straightforward.
 *
 * Public surface:
 *   openDb()           — open/create DB, run migrations
 *   saveUser()         — upsert user row + rules (onboarding, rule changes, pause)
 *   saveBlockCursors() — update only the block-scan cursors (called every poll)
 *   savePerpCursor()   — persist the shared perp scan cursor
 *   loadPerpCursor()   — restore perp cursor on boot
 *   persistTrades()    — insert new trades, prune to 200/user
 *   persistSnapshot()  — insert portfolio snapshot, prune to 200/user
 *   updateSignalLog()  — upsert last-fired timestamp for a signal type
 *   loadAllUsers()     — reconstruct full UserState[] from DB on boot
 *   loadLiquidationKeys() — restore liquidation dedup set on boot
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_RULES,
  type PortfolioSnapshot,
  type SignalType,
  type TradeEvent,
  type UserRules,
  type UserState,
} from "./types.js";

const MAX_TRADES_KEPT = 200;
const MAX_SNAPSHOTS_KEPT = 200;

const SCHEMA = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    conversation_id       TEXT PRIMARY KEY,
    inbox_id              TEXT NOT NULL,
    wallet                TEXT NOT NULL,
    paused                INTEGER NOT NULL DEFAULT 0,
    onboarded_at          INTEGER NOT NULL,
    last_daily_check_in_at INTEGER,
    last_block_scanned    TEXT,
    last_perp_block_scanned TEXT
  );

  CREATE TABLE IF NOT EXISTS user_rules (
    conversation_id       TEXT PRIMARY KEY,
    max_trades_per_day    INTEGER NOT NULL DEFAULT 5,
    max_position_size_usd REAL    NOT NULL DEFAULT 0,
    no_trade_start_hour   INTEGER NOT NULL DEFAULT 0,
    no_trade_end_hour     INTEGER NOT NULL DEFAULT 5,
    notes                 TEXT
  );

  CREATE TABLE IF NOT EXISTS trades (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT    NOT NULL,
    tx_hash          TEXT    NOT NULL,
    timestamp        INTEGER NOT NULL,
    wallet           TEXT    NOT NULL,
    router           TEXT    NOT NULL,
    router_name      TEXT    NOT NULL,
    token_in         TEXT,
    token_out        TEXT,
    token_in_symbol  TEXT,
    token_out_symbol TEXT,
    direction        TEXT,
    usd_value        REAL    NOT NULL DEFAULT 0,
    leverage         REAL,
    is_perp          INTEGER NOT NULL DEFAULT 0,
    perp_action      TEXT,
    pair_index       INTEGER,
    collateral_usd   REAL,
    realized_pnl_usd REAL,
    is_liquidation   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(conversation_id, tx_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_trades_conv_ts
    ON trades(conversation_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT    NOT NULL,
    timestamp       INTEGER NOT NULL,
    eth_balance     REAL    NOT NULL,
    usd_value       REAL    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_conv_ts
    ON snapshots(conversation_id, timestamp DESC);

  CREATE TABLE IF NOT EXISTS signal_log (
    conversation_id TEXT    NOT NULL,
    signal_type     TEXT    NOT NULL,
    last_fired_at   INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, signal_type)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// --- user ---

/** Full upsert of the user row + rules. Call on onboarding, rule edits, pause/resume, check-in. */
export function saveUser(db: DatabaseSync, state: UserState): void {
  db.prepare(`
    INSERT INTO users
      (conversation_id, inbox_id, wallet, paused, onboarded_at,
       last_daily_check_in_at, last_block_scanned, last_perp_block_scanned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      inbox_id                = excluded.inbox_id,
      wallet                  = excluded.wallet,
      paused                  = excluded.paused,
      onboarded_at            = excluded.onboarded_at,
      last_daily_check_in_at  = excluded.last_daily_check_in_at,
      last_block_scanned      = excluded.last_block_scanned,
      last_perp_block_scanned = excluded.last_perp_block_scanned
  `).run(
    state.conversationId,
    state.inboxId,
    state.wallet,
    state.paused ? 1 : 0,
    state.onboardedAt,
    state.lastDailyCheckInAt ?? null,
    state.lastBlockScanned?.toString() ?? null,
    state.lastPerpBlockScanned?.toString() ?? null,
  );

  db.prepare(`
    INSERT INTO user_rules
      (conversation_id, max_trades_per_day, max_position_size_usd,
       no_trade_start_hour, no_trade_end_hour, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      max_trades_per_day    = excluded.max_trades_per_day,
      max_position_size_usd = excluded.max_position_size_usd,
      no_trade_start_hour   = excluded.no_trade_start_hour,
      no_trade_end_hour     = excluded.no_trade_end_hour,
      notes                 = excluded.notes
  `).run(
    state.conversationId,
    state.rules.maxTradesPerDay,
    state.rules.maxPositionSizeUsd,
    state.rules.noTradeStartHour,
    state.rules.noTradeEndHour,
    state.rules.notes ?? null,
  );
}

/** Lightweight update — just the two block cursors. Called after every poll cycle. */
export function saveBlockCursors(db: DatabaseSync, state: UserState): void {
  db.prepare(`
    UPDATE users
    SET last_block_scanned = ?, last_perp_block_scanned = ?
    WHERE conversation_id = ?
  `).run(
    state.lastBlockScanned?.toString() ?? null,
    state.lastPerpBlockScanned?.toString() ?? null,
    state.conversationId,
  );
}

// --- perp cursor ---

export function savePerpCursor(db: DatabaseSync, cursor: bigint): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('perp_cursor', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(cursor.toString());
}

export function loadPerpCursor(db: DatabaseSync): bigint | undefined {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = 'perp_cursor'`)
    .get() as { value: string } | undefined;
  return row ? BigInt(row.value) : undefined;
}

// --- trades ---

/** Insert new trades (ignore duplicates by tx_hash) then prune oldest beyond MAX. */
export function persistTrades(
  db: DatabaseSync,
  conversationId: string,
  trades: TradeEvent[],
): void {
  if (trades.length === 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO trades
      (conversation_id, tx_hash, timestamp, wallet, router, router_name,
       token_in, token_out, token_in_symbol, token_out_symbol, direction,
       usd_value, leverage, is_perp, perp_action, pair_index,
       collateral_usd, realized_pnl_usd, is_liquidation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of trades) {
    insert.run(
      conversationId,
      t.txHash,
      t.timestamp,
      t.wallet,
      t.router,
      t.routerName,
      t.tokenIn ?? null,
      t.tokenOut ?? null,
      t.tokenInSymbol ?? null,
      t.tokenOutSymbol ?? null,
      t.direction ?? null,
      t.usdValue,
      t.leverage ?? null,
      t.isPerp ? 1 : 0,
      t.perpAction ?? null,
      t.pairIndex ?? null,
      t.collateralUsd ?? null,
      t.realizedPnlUsd ?? null,
      t.isLiquidation ? 1 : 0,
    );
  }

  // Keep only the latest MAX_TRADES_KEPT rows per user
  db.prepare(`
    DELETE FROM trades
    WHERE conversation_id = ?
      AND id NOT IN (
        SELECT id FROM trades
        WHERE conversation_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
  `).run(conversationId, conversationId, MAX_TRADES_KEPT);
}

// --- snapshots ---

/** Insert one snapshot then prune oldest beyond MAX. */
export function persistSnapshot(
  db: DatabaseSync,
  conversationId: string,
  snap: PortfolioSnapshot,
): void {
  db.prepare(`
    INSERT INTO snapshots (conversation_id, timestamp, eth_balance, usd_value)
    VALUES (?, ?, ?, ?)
  `).run(conversationId, snap.timestamp, snap.ethBalance, snap.usdValue);

  db.prepare(`
    DELETE FROM snapshots
    WHERE conversation_id = ?
      AND id NOT IN (
        SELECT id FROM snapshots
        WHERE conversation_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
  `).run(conversationId, conversationId, MAX_SNAPSHOTS_KEPT);
}

// --- signal log ---

/** Upsert the last-fired timestamp for a signal type. */
export function updateSignalLog(
  db: DatabaseSync,
  conversationId: string,
  type: SignalType,
  ts: number,
): void {
  db.prepare(`
    INSERT INTO signal_log (conversation_id, signal_type, last_fired_at)
    VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, signal_type) DO UPDATE SET last_fired_at = excluded.last_fired_at
  `).run(conversationId, type, ts);
}

// --- boot helpers ---

/** Restore the liquidation dedup set so post-mortems aren't re-sent after restart. */
export function loadLiquidationKeys(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT wallet, tx_hash FROM trades WHERE is_liquidation = 1`)
    .all() as Array<{ wallet: string; tx_hash: string }>;
  return new Set(rows.map((r) => `${r.wallet}:${r.tx_hash}`));
}

type UserRow = {
  conversation_id: string;
  inbox_id: string;
  wallet: string;
  paused: number;
  onboarded_at: number;
  last_daily_check_in_at: number | null;
  last_block_scanned: string | null;
  last_perp_block_scanned: string | null;
};

type RulesRow = {
  max_trades_per_day: number;
  max_position_size_usd: number;
  no_trade_start_hour: number;
  no_trade_end_hour: number;
  notes: string | null;
};

type TradeRow = Record<string, unknown>;

type SnapRow = { timestamp: number; eth_balance: number; usd_value: number };

type SignalRow = { signal_type: string; last_fired_at: number };

/** Reconstruct all UserState objects from DB. Call once at startup. */
export function loadAllUsers(db: DatabaseSync): UserState[] {
  const userRows = db.prepare(`SELECT * FROM users`).all() as UserRow[];

  return userRows.map((row) => {
    const rulesRow = (db
      .prepare(`SELECT * FROM user_rules WHERE conversation_id = ?`)
      .get(row.conversation_id) ?? {}) as Partial<RulesRow>;

    const tradeRows = db
      .prepare(
        `SELECT * FROM trades WHERE conversation_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(row.conversation_id, MAX_TRADES_KEPT) as TradeRow[];

    const snapRows = db
      .prepare(
        `SELECT * FROM snapshots WHERE conversation_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(row.conversation_id, MAX_SNAPSHOTS_KEPT) as SnapRow[];

    const signalRows = db
      .prepare(
        `SELECT signal_type, last_fired_at FROM signal_log WHERE conversation_id = ?`,
      )
      .all(row.conversation_id) as SignalRow[];

    const lastSignalAt: Partial<Record<SignalType, number>> = {};
    for (const s of signalRows) {
      lastSignalAt[s.signal_type as SignalType] = s.last_fired_at;
    }

    const rules: UserRules = {
      maxTradesPerDay:    rulesRow.max_trades_per_day    ?? DEFAULT_RULES.maxTradesPerDay,
      maxPositionSizeUsd: rulesRow.max_position_size_usd ?? DEFAULT_RULES.maxPositionSizeUsd,
      noTradeStartHour:   rulesRow.no_trade_start_hour   ?? DEFAULT_RULES.noTradeStartHour,
      noTradeEndHour:     rulesRow.no_trade_end_hour     ?? DEFAULT_RULES.noTradeEndHour,
      notes:              rulesRow.notes ?? undefined,
    };

    // Rows were fetched DESC — reverse to get chronological order in memory
    const trades: TradeEvent[] = (tradeRows as TradeRow[]).reverse().map((t) => ({
      txHash:          t["tx_hash"] as string,
      timestamp:       t["timestamp"] as number,
      wallet:          t["wallet"] as string,
      router:          t["router"] as string,
      routerName:      t["router_name"] as string,
      tokenIn:         (t["token_in"] as string | null) ?? undefined,
      tokenOut:        (t["token_out"] as string | null) ?? undefined,
      tokenInSymbol:   (t["token_in_symbol"] as string | null) ?? undefined,
      tokenOutSymbol:  (t["token_out_symbol"] as string | null) ?? undefined,
      direction:       (t["direction"] as "buy" | "sell" | null) ?? undefined,
      usdValue:        t["usd_value"] as number,
      leverage:        (t["leverage"] as number | null) ?? undefined,
      isPerp:          !!(t["is_perp"] as number),
      perpAction:      (t["perp_action"] as "open" | "close" | null) ?? undefined,
      pairIndex:       (t["pair_index"] as number | null) ?? undefined,
      collateralUsd:   (t["collateral_usd"] as number | null) ?? undefined,
      realizedPnlUsd:  (t["realized_pnl_usd"] as number | null) ?? undefined,
      isLiquidation:   !!(t["is_liquidation"] as number),
    }));

    const snapshots: PortfolioSnapshot[] = snapRows.reverse().map((s) => ({
      timestamp:  s.timestamp,
      ethBalance: s.eth_balance,
      usdValue:   s.usd_value,
    }));

    return {
      conversationId:       row.conversation_id,
      inboxId:              row.inbox_id,
      wallet:               row.wallet,
      paused:               row.paused === 1,
      onboardedAt:          row.onboarded_at,
      lastDailyCheckInAt:   row.last_daily_check_in_at ?? undefined,
      lastBlockScanned:     row.last_block_scanned     ? BigInt(row.last_block_scanned)     : undefined,
      lastPerpBlockScanned: row.last_perp_block_scanned ? BigInt(row.last_perp_block_scanned) : undefined,
      rules,
      trades,
      snapshots,
      lastSignalAt,
    } satisfies UserState;
  });
}
