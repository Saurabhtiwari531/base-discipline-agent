/**
 * Avantis (perps DEX on Base) — read-only event decoding.
 *
 * Leverage is the core story for this product, so we read a watched wallet's
 * Avantis position lifecycle directly from chain — no partnership required.
 *
 * ── What is decoded reliably here ──────────────────────────────────────────
 *   Position OPEN / CLOSE, direction (long/short), and leverage, via the
 *   trader-indexed `MarketOrderInitiated` event on the Trading contract. These
 *   are filtered server-side by the indexed `trader` topic (cheap getLogs).
 *
 * ── What is an intentional, documented gap (verify on Basescan) ────────────
 *   Realized PnL on close and explicit LIQUIDATION events are emitted by
 *   Avantis's execution-callbacks contract, whose ABI is NOT published in the
 *   official SDK or integration repos. So `pollLiquidations` is env-gated and
 *   dormant by default. See the block comment above it for the exact path to
 *   turn it on once the callbacks contract is verified on Basescan.
 *
 * ── ABI caveat ─────────────────────────────────────────────────────────────
 *   The avantis_trader_sdk (Python, official) defines a 9-arg
 *   MarketOrderInitiated (with leverage/isBuy/size); the avantisfi-integration
 *   (TS) repo defines a 5-arg one. Both point at the SAME Trading address, so
 *   one ABI is stale relative to the deployed contract and the two imply
 *   different event topic0 hashes. We use the richer SDK signature because it
 *   carries the data we need. VERIFY topic0 against emitted logs on Basescan:
 *   https://basescan.org/address/0x44914408af82bc9983bbb330e3578e1105e11d4e#events
 *   If decoding yields zero logs for active traders, switch to the 5-arg form.
 */
import { type AbiEvent, type Log, parseAbiItem } from "viem";
import type { TradeEvent, UserState } from "../types.js";
import type { BaseClient } from "../watcher.js";

/** Verified Base-mainnet addresses (avantis_trader_sdk config + integration repo agree). */
export const AVANTIS_ADDRESSES = {
  trading: "0x44914408af82bC9983bbb330e3578E1105e11d4e",
  tradingStorage: "0x8a311D7048c35985aa31C131B9A13e03a5f7422d",
  priceAggregator: "0x64e2625621970F8cfA17B294670d61CB883dA511",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

const USDC_DECIMALS = 6;

/**
 * Leverage scaling on Avantis is unverified (gTrade forks variously use integer
 * or 1e10-scaled leverage). We keep the raw value; the leverage_escalation
 * heuristic compares RATIOS between consecutive opens, which is scale-invariant
 * and therefore robust to this uncertainty.
 */
const MARKET_ORDER_INITIATED: AbiEvent = parseAbiItem(
  "event MarketOrderInitiated(address indexed trader, uint256 pairIndex, bool open, uint256 orderId, uint256 timestamp, bool isBuy, bool isPnl, uint256 initialPosToken, uint256 leverage)",
) as AbiEvent;

/** Cap on blocks scanned per poll, mirroring the spot watcher. ~20 min on Base. */
const MAX_BLOCKS_PER_POLL = 600n;

type MarketOrderArgs = {
  trader: `0x${string}`;
  pairIndex: bigint;
  open: boolean;
  orderId: bigint;
  timestamp: bigint;
  isBuy: boolean;
  isPnl: boolean;
  initialPosToken: bigint;
  leverage: bigint;
};

function decodeMarketOrder(log: Log & { args?: unknown }): TradeEvent | null {
  const args = log.args as MarketOrderArgs | undefined;
  if (!args || !log.transactionHash) return null;
  const collateralUsd = Number(args.initialPosToken) / 10 ** USDC_DECIMALS;
  return {
    txHash: log.transactionHash,
    timestamp: Number(args.timestamp) * 1000,
    wallet: args.trader.toLowerCase(),
    router: AVANTIS_ADDRESSES.trading.toLowerCase(),
    routerName: "Avantis",
    direction: args.isBuy ? "buy" : "sell", // buy == long, sell == short
    usdValue: collateralUsd, // notional needs verified leverage scale; collateral is a safe proxy
    leverage: Number(args.leverage),
    isPerp: true,
    perpAction: args.open ? "open" : "close",
    pairIndex: Number(args.pairIndex),
    collateralUsd,
  };
}

/** Resolve the scan window [from, to], mirroring the spot watcher's bounded scan. */
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

/**
 * Poll Avantis position open/close events for the watched wallet since the last
 * scan. Returns perp TradeEvents (oldest first) and advances
 * state.lastPerpBlockScanned. Throws on RPC error (caller wraps in try/catch).
 */
export async function pollAvantis(
  client: BaseClient,
  state: UserState,
): Promise<TradeEvent[]> {
  const range = await nextRange(client, state);
  if (!range) return [];

  const logs = await client.getLogs({
    address: AVANTIS_ADDRESSES.trading as `0x${string}`,
    event: MARKET_ORDER_INITIATED,
    args: { trader: state.wallet as `0x${string}` },
    fromBlock: range.from,
    toBlock: range.to,
  });

  const events: TradeEvent[] = [];
  for (const log of logs) {
    const event = decodeMarketOrder(log);
    if (event) events.push(event);
  }

  const liquidations = await pollLiquidations(client, state, range.from, range.to);
  events.push(...liquidations);

  state.lastPerpBlockScanned = range.to;
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

/**
 * LIQUIDATION + realized-PnL detection — DORMANT until the Avantis execution-
 * callbacks contract is verified on Basescan.
 *
 * Why dormant: liquidations are keeper-initiated and emitted by a callbacks
 * contract that is NOT in any public Avantis ABI, so we cannot decode them
 * correctly yet. Rather than guess a signature (and risk silently-wrong
 * post-mortems on real users), this returns [] until wired.
 *
 * To enable (recommended next step on this module):
 *   1. On Basescan, open the Trading contract's internal txs / the keeper that
 *      executes liquidations and identify the callbacks contract + its
 *      "limit/market executed" event (gTrade-style: orderType == LIQ).
 *   2. Set AVANTIS_CALLBACKS_ADDRESS in .env and add the verified event ABI
 *      below, mapping a LIQ-type close into a TradeEvent with
 *      `isLiquidation: true` and `realizedPnlUsd` (negative).
 * The post_liquidation_reentry heuristic and the liquidation post-mortem flow
 * are already fully implemented and will activate automatically once these
 * events start flowing.
 */
async function pollLiquidations(
  _client: BaseClient,
  _state: UserState,
  _fromBlock: bigint,
  _toBlock: bigint,
): Promise<TradeEvent[]> {
  if (!process.env.AVANTIS_CALLBACKS_ADDRESS) return [];
  // Verified callbacks ABI goes here once confirmed on Basescan. Until then,
  // stay dormant even if the env var is set, to avoid decoding against a guess.
  return [];
}
