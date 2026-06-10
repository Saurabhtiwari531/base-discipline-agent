/**
 * Avantis (perps DEX on Base) — read-only event decoding.
 *
 * Leverage is the core story for this product, so we read a watched wallet's
 * Avantis position lifecycle directly from chain — no partnership required.
 *
 * ── Architecture (all verified on-chain 2026-06-10) ─────────────────────────
 *   OPENS come from the Trading contract's `MarketOrderInitiated` — it indexes
 *   the trader, so we filter server-side (cheap getLogs). It carries leverage,
 *   direction and collateral. (topic0 0x9d20fe25…; 136 hits vs 0 for the stale
 *   5-arg form the integration repo ships.)
 *
 *   CLOSES + LIQUIDATIONS come from the TradingCallbacks contract
 *   (0x0C16ff40…, impl 0x6a22930D, found by walking an execution tx's receipt):
 *     · MarketExecuted  — market closes; topic0 0x5c00d8b4… CONFIRMED by hash
 *       (computed topic0 == observed on-chain topic0).
 *     · LimitExecuted   — keeper closes (TP/SL/LIQUIDATION); topic0 0xbf3d2344…
 *   Both carry the trade struct, `percentProfit` (1e10-scaled) and
 *   `usdcSentToTrader` (USDC). The trader is INSIDE the struct (not indexed), so
 *   we scan the callbacks contract over the block window and filter by trader
 *   after decoding. (Fine at current scale; move to an indexer later.)
 *
 *   Liquidation = LimitExecuted with orderType == 2. Proven empirically: those
 *   rows show pnl ≈ -87%..-90% and usdcSentToTrader == $0 (collateral wiped),
 *   vs orderType 0=TP (profit), 1=SL (small loss, residual returned), 3=OPEN.
 *
 *   Field scaling (all verified against live logs): leverage 1e10 (raw 2e11 ==
 *   20x), percentProfit 1e10, collateral/USDC 1e6.
 *
 * Re-verify anytime (e.g. after an Avantis upgrade): npx tsx scripts/verify-decode.ts
 */
import { type AbiEvent, parseAbiItem } from "viem";
import type { TradeEvent, UserState } from "../types.js";
import type { BaseClient } from "../watcher.js";

/** Verified Base-mainnet addresses. Callbacks is overridable in case of redeploy. */
export const AVANTIS_ADDRESSES = {
  trading: "0x44914408af82bC9983bbb330e3578E1105e11d4e",
  tradingStorage: "0x8a311D7048c35985aa31C131B9A13e03a5f7422d",
  priceAggregator: "0x64e2625621970F8cfA17B294670d61CB883dA511",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  callbacks: process.env.AVANTIS_CALLBACKS_ADDRESS ?? "0x0C16ff40065Cc3Ab4bc55B60E447504AFB9C7970",
} as const;

const USDC_DECIMALS = 6;
const LEVERAGE_SCALE = 1e10; // verified: raw 2e11 == 20x
const PERCENT_PROFIT_SCALE = 1e10; // verified: raw -8.7e11 == -87%
/** orderType enum value for a liquidation. Verified: pnl≈-90%, usdcSent==0. */
const LIQUIDATION_ORDER_TYPE = 2;
const LIMIT_ORDER_TYPE_OPEN = 3; // a limit OPEN execution, not a close

/** Cap on blocks scanned per poll, mirroring the spot watcher. ~20 min on Base. */
const MAX_BLOCKS_PER_POLL = 600n;

// Verified event ABIs (topic0s checked against live logs — see header).
const MARKET_ORDER_INITIATED: AbiEvent = parseAbiItem(
  "event MarketOrderInitiated(address indexed trader, uint256 pairIndex, bool open, uint256 orderId, uint256 timestamp, bool isBuy, bool isPnl, uint256 initialPosToken, uint256 leverage)",
) as AbiEvent;

const TRADE_TUPLE =
  "(address trader, uint256 pairIndex, uint256 index, uint256 initialPosToken, uint256 positionSizeUSDC, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp)";

const MARKET_EXECUTED: AbiEvent = parseAbiItem(
  `event MarketExecuted(uint256 orderId, ${TRADE_TUPLE} t, bool open, uint256 price, uint256 positionSizeUSDC, int256 percentProfit, uint256 usdcSentToTrader, bool isPnl)`,
) as AbiEvent;

const LIMIT_EXECUTED: AbiEvent = parseAbiItem(
  `event LimitExecuted(uint256 orderId, uint256 limitIndex, ${TRADE_TUPLE} t, uint8 orderType, uint256 price, uint256 positionSizeUSDC, int256 percentProfit, uint256 usdcSentToTrader, bool isPnl)`,
) as AbiEvent;

type TradeStruct = {
  trader: `0x${string}`;
  pairIndex: bigint;
  buy: boolean;
  leverage: bigint;
  initialPosToken: bigint;
};

// --- OPENS (Trading.MarketOrderInitiated, trader-indexed) ---

type MarketOrderArgs = {
  trader: `0x${string}`;
  pairIndex: bigint;
  open: boolean;
  timestamp: bigint;
  isBuy: boolean;
  initialPosToken: bigint;
  leverage: bigint;
};

function decodeOpen(log: { args?: unknown; transactionHash: string | null }): TradeEvent | null {
  const a = log.args as MarketOrderArgs | undefined;
  if (!a || !log.transactionHash || !a.open) return null; // opens only; closes come from callbacks
  const collateralUsd = Number(a.initialPosToken) / 10 ** USDC_DECIMALS;
  const leverage = Number(a.leverage) / LEVERAGE_SCALE;
  return {
    txHash: log.transactionHash,
    timestamp: Number(a.timestamp) * 1000,
    wallet: a.trader.toLowerCase(),
    router: AVANTIS_ADDRESSES.trading.toLowerCase(),
    routerName: "Avantis",
    direction: a.isBuy ? "buy" : "sell",
    usdValue: collateralUsd * leverage, // notional = collateral * leverage
    leverage,
    isPerp: true,
    perpAction: "open",
    pairIndex: Number(a.pairIndex),
    collateralUsd,
  };
}

// --- CLOSES + LIQUIDATIONS (TradingCallbacks, trader inside the struct) ---

function buildClose(
  t: TradeStruct,
  percentProfit: bigint,
  txHash: string,
  timestampMs: number,
  isLiquidation: boolean,
): TradeEvent {
  const collateralUsd = Number(t.initialPosToken) / 10 ** USDC_DECIMALS;
  const leverage = Number(t.leverage) / LEVERAGE_SCALE;
  const pnlFraction = Number(percentProfit) / PERCENT_PROFIT_SCALE / 100;
  return {
    txHash,
    timestamp: timestampMs,
    wallet: t.trader.toLowerCase(),
    router: AVANTIS_ADDRESSES.callbacks.toLowerCase(),
    routerName: "Avantis",
    direction: t.buy ? "buy" : "sell",
    usdValue: collateralUsd * leverage,
    leverage,
    isPerp: true,
    perpAction: "close",
    pairIndex: Number(t.pairIndex),
    collateralUsd,
    realizedPnlUsd: collateralUsd * pnlFraction,
    isLiquidation,
  };
}

/** Resolve the scan window, mirroring the spot watcher's bounded scan. */
async function nextRange(
  client: BaseClient,
  state: UserState,
): Promise<{ from: bigint; to: bigint } | null> {
  const latest = await client.getBlockNumber();
  let from =
    state.lastPerpBlockScanned !== undefined ? state.lastPerpBlockScanned + 1n : latest;
  if (latest < from) {
    state.lastPerpBlockScanned = latest;
    return null;
  }
  if (latest - from > MAX_BLOCKS_PER_POLL) from = latest - MAX_BLOCKS_PER_POLL;
  return { from, to: latest };
}

/** getBlock timestamps for a set of blocks, cached. Closes carry the position's
 *  OPEN time in the struct, so we use block time for correct close ordering. */
async function blockTimesMs(
  client: BaseClient,
  blocks: Set<bigint>,
): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  for (const bn of blocks) {
    const block = await client.getBlock({ blockNumber: bn });
    out.set(bn, Number(block.timestamp) * 1000);
  }
  return out;
}

/**
 * Poll Avantis open/close/liquidation events for the watched wallet since the
 * last scan. Returns perp TradeEvents (oldest first) and advances
 * state.lastPerpBlockScanned. Throws on RPC error (caller wraps in try/catch).
 */
export async function pollAvantis(
  client: BaseClient,
  state: UserState,
): Promise<TradeEvent[]> {
  const range = await nextRange(client, state);
  if (!range) return [];
  const wallet = state.wallet.toLowerCase();
  const events: TradeEvent[] = [];

  // OPENS — server-side filtered by indexed trader.
  const openLogs = await client.getLogs({
    address: AVANTIS_ADDRESSES.trading as `0x${string}`,
    event: MARKET_ORDER_INITIATED,
    args: { trader: state.wallet as `0x${string}` },
    fromBlock: range.from,
    toBlock: range.to,
  });
  for (const log of openLogs) {
    const ev = decodeOpen(log);
    if (ev) events.push(ev);
  }

  // CLOSES + LIQUIDATIONS — scan callbacks, filter by trader after decode.
  const [marketLogs, limitLogs] = await Promise.all([
    client.getLogs({
      address: AVANTIS_ADDRESSES.callbacks as `0x${string}`,
      event: MARKET_EXECUTED,
      fromBlock: range.from,
      toBlock: range.to,
    }),
    client.getLogs({
      address: AVANTIS_ADDRESSES.callbacks as `0x${string}`,
      event: LIMIT_EXECUTED,
      fromBlock: range.from,
      toBlock: range.to,
    }),
  ]);

  type Pending = { t: TradeStruct; pnl: bigint; block: bigint; tx: string; liq: boolean };
  const pending: Pending[] = [];

  for (const log of marketLogs) {
    const a = log.args as { t?: TradeStruct; open?: boolean; percentProfit?: bigint };
    if (!a.t || a.t.trader.toLowerCase() !== wallet) continue;
    if (a.open) continue; // opens handled above
    pending.push({
      t: a.t,
      pnl: a.percentProfit ?? 0n,
      block: log.blockNumber,
      tx: log.transactionHash,
      liq: false,
    });
  }
  for (const log of limitLogs) {
    const a = log.args as { t?: TradeStruct; orderType?: number; percentProfit?: bigint };
    if (!a.t || a.t.trader.toLowerCase() !== wallet) continue;
    const orderType = Number(a.orderType);
    if (orderType === LIMIT_ORDER_TYPE_OPEN) continue; // limit OPEN execution, not a close
    pending.push({
      t: a.t,
      pnl: a.percentProfit ?? 0n,
      block: log.blockNumber,
      tx: log.transactionHash,
      liq: orderType === LIQUIDATION_ORDER_TYPE,
    });
  }

  if (pending.length > 0) {
    const times = await blockTimesMs(client, new Set(pending.map((p) => p.block)));
    for (const p of pending) {
      events.push(buildClose(p.t, p.pnl, p.tx, times.get(p.block) ?? Date.now(), p.liq));
    }
  }

  state.lastPerpBlockScanned = range.to;
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}
