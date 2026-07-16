/**
 * Watcher layer — reads Base on-chain activity for a wallet.
 *
 * Approach: raw block scanning, matching transactions whose `to` is a known DEX
 * router. This is intentionally simple and WILL NOT scale past a handful of users
 * (see CLAUDE.md roadmap: move to an indexer).
 *
 * USD estimation strategy (without an indexer):
 *   1. Native ETH sent in the tx → tx.value * ethUsd
 *   2. ERC20 Transfer from wallet → stablecoin amount (direct USD) or WETH * ethUsd
 *   3. Falls back to 0 if neither is detected (unknown token swap).
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

// --- Known Base token addresses (all lowercase) ---
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
const DAI  = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";

const TOKEN_SYMBOLS: Record<string, string> = {
  [WETH]: "WETH",
  [USDC]: "USDC",
  [USDT]: "USDT",
  [DAI]:  "DAI",
};

/** Stablecoin addresses → their decimal places. */
const STABLECOIN_DECIMALS: Record<string, number> = {
  [USDC]: 6,
  [USDT]: 6,
  [DAI]:  18,
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Cap on how many blocks we scan per poll, so a long gap can't lock the loop. */
const MAX_BLOCKS_PER_POLL = 600n; // ~20 min of Base blocks (2s/block)

// --- ETH price cache ---
const ethPriceCache = { usd: 3000, fetchedAt: 0 };
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createBaseClient() {
  const rpcUrl = process.env.BASE_RPC_URL;
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl), // undefined -> viem uses the chain's default public RPC
  });
}

export type BaseClient = ReturnType<typeof createBaseClient>;

/**
 * Fetch ETH/USD from Coingecko free API with a 5-minute in-process cache.
 * On failure, returns the last known price (never 0) so portfolio math stays sane.
 */
export async function fetchEthUsd(): Promise<number> {
  const now = Date.now();
  if (now - ethPriceCache.fetchedAt < PRICE_CACHE_TTL_MS) return ethPriceCache.usd;

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { ethereum?: { usd?: number } };
    const price = data?.ethereum?.usd;
    if (typeof price === "number" && price > 0) {
      ethPriceCache.usd = price;
      ethPriceCache.fetchedAt = now;
    }
  } catch {
    // Keep using last cached price — don't update fetchedAt so we retry next poll
  }

  return ethPriceCache.usd;
}

/** Read the wallet's native ETH balance and snapshot its USD value. */
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
 * Estimate the USD notional of a DEX trade without an indexer.
 *
 * Strategy (in priority order):
 *   1. Native ETH sent in the tx (tx.value) → value * ethUsd
 *   2. ERC20 Transfer FROM the wallet in the receipt:
 *      - stablecoin → direct USD amount
 *      - WETH → amount * ethUsd
 *   3. Returns 0 if we can't determine (unknown token, receiving side only, etc.)
 *
 * Also populates tokenInSymbol from what we detect.
 */
async function estimateTradeUsdValue(
  client: BaseClient,
  txHash: string,
  wallet: string,
  nativeValue: bigint,
  ethUsd: number,
): Promise<{ usdValue: number; tokenInSymbol?: string; tokenOutSymbol?: string }> {
  // 1. Native ETH sent
  if (nativeValue > 0n) {
    const ethAmount = Number(formatEther(nativeValue));
    if (ethAmount > 0.0001) {
      return { usdValue: ethAmount * ethUsd, tokenInSymbol: "ETH" };
    }
  }

  // 2. Decode ERC20 Transfer logs from the receipt
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    let tokenInSymbol: string | undefined;
    let tokenOutSymbol: string | undefined;

    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue;

      const token = log.address.toLowerCase();
      const from = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
      const to   = `0x${log.topics[2]!.slice(26)}`.toLowerCase();

      // Track token symbols for what the wallet sent / received
      if (from === wallet && TOKEN_SYMBOLS[token]) tokenInSymbol = TOKEN_SYMBOLS[token];
      if (to   === wallet && TOKEN_SYMBOLS[token]) tokenOutSymbol = TOKEN_SYMBOLS[token];

      // Only price the outgoing leg (what the wallet spent)
      if (from !== wallet) continue;

      const rawValue = BigInt(log.data);

      if (token in STABLECOIN_DECIMALS) {
        const decimals = STABLECOIN_DECIMALS[token]!;
        const usdValue = Number(rawValue) / 10 ** decimals;
        return { usdValue, tokenInSymbol: TOKEN_SYMBOLS[token], tokenOutSymbol };
      }

      if (token === WETH) {
        const ethAmount = Number(rawValue) / 1e18;
        return { usdValue: ethAmount * ethUsd, tokenInSymbol: "WETH", tokenOutSymbol };
      }
    }

    // Could not price it, but still return any symbols we found
    return { usdValue: 0, tokenInSymbol, tokenOutSymbol };
  } catch {
    return { usdValue: 0 };
  }
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
  let from = state.lastBlockScanned !== undefined ? state.lastBlockScanned + 1n : latest;
  if (latest < from) {
    state.lastBlockScanned = latest;
    return [];
  }
  if (latest - from > MAX_BLOCKS_PER_POLL) {
    from = latest - MAX_BLOCKS_PER_POLL;
  }

  const ethUsd = await fetchEthUsd();
  const events: TradeEvent[] = [];

  for (let bn = from; bn <= latest; bn++) {
    const block = await client.getBlock({ blockNumber: bn, includeTransactions: true });
    const tsMs = Number(block.timestamp) * 1000;

    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;
      if (tx.from.toLowerCase() !== wallet) continue;
      const to = tx.to?.toLowerCase();
      if (!to) continue;
      const routerName = DEX_ROUTERS[to];
      if (!routerName) continue;

      const { usdValue, tokenInSymbol, tokenOutSymbol } = await estimateTradeUsdValue(
        client,
        tx.hash,
        wallet,
        tx.value ?? 0n,
        ethUsd,
      );

      events.push({
        txHash: tx.hash,
        timestamp: tsMs,
        wallet,
        router: to,
        routerName,
        tokenInSymbol,
        tokenOutSymbol,
        usdValue,
      });
    }
  }

  state.lastBlockScanned = latest;
  return events;
}
