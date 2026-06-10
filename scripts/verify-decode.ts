/**
 * scripts/verify-decode.ts — evidence-first Avantis ABI sanity check.
 *
 *   npx tsx scripts/verify-decode.ts                 # last 10 trades on Avantis
 *   npx tsx scripts/verify-decode.ts 0xWalletAddr…   # last 10 trades for a wallet
 *   BASE_RPC_URL=https://… npx tsx scripts/verify-decode.ts 0x…  # deep history
 *
 * Why this exists: the Avantis Trading contract's event ABI is ground truth on
 * chain, and could change with a redeploy. This script RE-VERIFIES on every run
 * that the event topic0 we decode against still appears in real logs, then
 * prints decoded trades so a human can eyeball that leverage/size/direction are
 * sane. Keep it; run it whenever Avantis upgrades or decoding looks off.
 *
 * No Basescan key needed — reads logs straight from a Base RPC.
 */
import "dotenv/config";
import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  http,
  isAddress,
  parseAbiItem,
} from "viem";
import { base } from "viem/chains";

const TRADING = "0x44914408af82bC9983bbb330e3578E1105e11d4e" as const;

// Verified on chain (47,148,361–47,149,160: 136 hits vs 0 for the 5-arg form).
const MARKET_ORDER_INITIATED = parseAbiItem(
  "event MarketOrderInitiated(address indexed trader, uint256 pairIndex, bool open, uint256 orderId, uint256 timestamp, bool isBuy, bool isPnl, uint256 initialPosToken, uint256 leverage)",
);
// The stale 5-arg signature from the integration repo, kept only to warn if a
// future redeploy switches back to it.
const STALE_5ARG = parseAbiItem(
  "event MarketOrderInitiated(address indexed trader, uint256 pairIndex, bool open, uint256 orderId, uint256 timestamp)",
);

const TOPIC0 = encodeEventTopics({ abi: [MARKET_ORDER_INITIATED] })[0];
const STALE_TOPIC0 = encodeEventTopics({ abi: [STALE_5ARG] })[0];

const LEVERAGE_SCALE = 1e10; // verified: 2e11 raw == 20x
const USDC_SCALE = 1e6;

const CHUNK = 800n; // public-RPC-friendly getLogs window
const MAX_WINDOWS = 300n; // ~240k blocks (~5.5 days) backstop

async function main(): Promise<void> {
  const walletArg = process.argv[2];
  if (walletArg && !isAddress(walletArg)) {
    console.error(`Not a valid address: ${walletArg}`);
    process.exit(1);
  }
  const trader = walletArg as `0x${string}` | undefined;

  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
  const latest = await client.getBlockNumber();
  console.log(`Base latest block: ${latest}`);
  console.log(`Decoding against topic0 ${TOPIC0} (9-arg MarketOrderInitiated)`);
  if (trader) console.log(`Filtering by trader: ${trader}`);

  type Row = {
    block: bigint;
    args: {
      open: boolean;
      isBuy: boolean;
      leverage: bigint;
      initialPosToken: bigint;
      pairIndex: bigint;
      timestamp: bigint;
      trader: string;
    };
    txHash: string;
  };
  const rows: Row[] = [];
  let staleSeen = 0;
  let scanned = 0n;

  for (let i = 0n; i < MAX_WINDOWS && rows.length < 10; i++) {
    const to = latest - i * CHUNK;
    const from = to - CHUNK + 1n;
    scanned += CHUNK;
    try {
      const logs = await client.getLogs({
        address: TRADING,
        event: MARKET_ORDER_INITIATED,
        ...(trader ? { args: { trader } } : {}),
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        rows.push({
          block: log.blockNumber,
          args: log.args as Row["args"],
          txHash: log.transactionHash,
        });
      }
      // self-check: do any logs in this window carry the stale topic0?
      const raw = await client.getLogs({ address: TRADING, fromBlock: from, toBlock: to });
      staleSeen += raw.filter((l) => l.topics[0] === STALE_TOPIC0).length;
    } catch {
      // range/ratelimit on a window — skip it and keep scanning
    }
  }

  console.log(`Scanned ~${scanned} blocks; found ${rows.length} matching events.`);
  if (staleSeen > 0) {
    console.warn(
      `⚠️  Saw ${staleSeen} logs with the STALE 5-arg topic0 (${STALE_TOPIC0}). The contract may have changed — re-verify the ABI.`,
    );
  }
  if (rows.length === 0) {
    console.log("No trades found in the scanned window. Try a wider BASE_RPC_URL (Alchemy) or a more active wallet.");
    return;
  }

  rows.sort((a, b) => Number(a.block - b.block));
  const last10 = rows.slice(-10);
  console.log("\nLast decoded trades (oldest → newest):");
  for (const r of last10) {
    const a = r.args;
    const when = new Date(Number(a.timestamp) * 1000).toISOString().replace(".000Z", "Z");
    const action = a.open ? "OPEN " : "CLOSE";
    const dir = a.isBuy ? "LONG " : "SHORT";
    const lev = (Number(a.leverage) / LEVERAGE_SCALE).toFixed(1).padStart(5);
    const collateral = (Number(a.initialPosToken) / USDC_SCALE).toFixed(2).padStart(9);
    console.log(
      `  ${when}  ${action} ${dir}  lev=${lev}x  collateral=$${collateral}  pair=${String(
        a.pairIndex,
      ).padStart(3)}  ${r.txHash}`,
    );
  }
}

main().catch((err) => {
  console.error("verify-decode failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
