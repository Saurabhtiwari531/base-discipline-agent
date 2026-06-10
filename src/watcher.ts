/**
 * Watcher layer — reads Base on-chain activity for a wallet.
 *
 * Approach: raw block scanning, matching transactions whose `to` is a known DEX
 * router. This is intentionally simple and WILL NOT scale past a handful of users
 * (see CLAUDE.md roadmap: move to an indexer). usdValue is a stub (0) until swap
 * logs are decoded / an indexer lands, so size-based heuristics stay dormant.
 *
 * Every RPC call is wrapped by the caller in try/catch — one wallet's failed poll
 * must never crash the loop.
 */
import { createPublicClient, formatEther, http, isAddress } from "viem";
import { base } from "viem/chains";
import type { PortfolioSnapshot, TradeEvent, UserState } from "./types.js";

/**
 * Known Base DEX routers, keyed by LOWERCASED address.
 * NOTE: verify each on Basescan before production — addresses change between
 * router versions. These are the v-current deployments at time of writing.
 */
export const DEX_ROUTERS: Record<string, string> = {
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter02",
  "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router",
  "0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc": "Uniswap Universal Router v1.2",
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "Aerodrome Router",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch Aggregation Router v6",
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": "KyberSwap MetaAggregationRouterV2",
};

/** Cap on how many blocks we scan per poll, so a long gap can't lock the loop. */
const MAX_BLOCKS_PER_POLL = 600n; // ~20 min of Base blocks (2s/block)

export function createBaseClient() {
  const rpcUrl = process.env.BASE_RPC_URL;
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl), // undefined -> viem uses the chain's default public RPC
  });
}

/**
 * The concrete viem client type for Base. Inferred rather than annotated as the
 * generic `PublicClient` because the Base (OP-stack) chain widens block/tx types.
 */
export type BaseClient = ReturnType<typeof createBaseClient>;

/**
 * Price feed STUB. Returns a hardcoded ETH/USD until a real feed is wired
 * (Coingecko / CDP). See CLAUDE.md "Known stubs / gaps".
 */
export async function fetchEthUsd(): Promise<number> {
  return 3000;
}

/** Read the wallet's native ETH balance and snapshot its (stub) USD value. */
export async function getPortfolioSnapshot(
  client: BaseClient,
  wallet: string,
): Promise<PortfolioSnapshot> {
  const balanceWei = await client.getBalance({ address: wallet as `0x${string}` });
  const ethBalance = Number(formatEther(balanceWei));
  const ethUsd = await fetchEthUsd();
  return {
    timestamp: Date.now(),
    ethBalance,
    usdValue: ethBalance * ethUsd,
  };
}

/**
 * Scan new blocks since state.lastBlockScanned for trades made by the watched
 * wallet against a known router. Returns new TradeEvents (oldest first) and
 * advances state.lastBlockScanned. Caller persists the events onto state.
 */
export async function pollWallet(
  client: BaseClient,
  state: UserState,
): Promise<TradeEvent[]> {
  if (!isAddress(state.wallet)) return [];
  const wallet = state.wallet.toLowerCase();

  const latest = await client.getBlockNumber();
  // First poll: start near the tip so we don't backfill the whole chain.
  let from = state.lastBlockScanned !== undefined ? state.lastBlockScanned + 1n : latest;
  if (latest < from) {
    state.lastBlockScanned = latest;
    return [];
  }
  if (latest - from > MAX_BLOCKS_PER_POLL) {
    from = latest - MAX_BLOCKS_PER_POLL;
  }

  const events: TradeEvent[] = [];
  for (let bn = from; bn <= latest; bn++) {
    const block = await client.getBlock({ blockNumber: bn, includeTransactions: true });
    const tsMs = Number(block.timestamp) * 1000;
    for (const tx of block.transactions) {
      if (typeof tx === "string") continue; // safety: should be full txs here
      if (tx.from.toLowerCase() !== wallet) continue;
      const to = tx.to?.toLowerCase();
      if (!to) continue;
      const routerName = DEX_ROUTERS[to];
      if (!routerName) continue;
      events.push({
        txHash: tx.hash,
        timestamp: tsMs,
        wallet,
        router: to,
        routerName,
        usdValue: 0, // STUB until swap-log decoding / indexer
      });
    }
  }

  state.lastBlockScanned = latest;
  return events;
}
