/**
 * Base Discipline Agent — XMTP entrypoint.
 *
 * Wires the layers together:
 *   chat commands  -> onboarding + rule editing + signal-request refusal
 *   watcher loop   -> poll wallets, run heuristics, send behavior-triggered interventions
 *   daily check-in -> the ONE allowed scheduled message per day
 *
 * Design rules enforced here:
 *  - Heuristics decide WHEN to message; the LLM only words it (see interventions.ts).
 *  - Any "should I buy/sell/long X?" is refused and redirected to the user's plan.
 *  - Never log message contents in plaintext (XMTP guideline).
 *  - One user's failed poll must never crash the loop (per-user try/catch).
 */
import "dotenv/config";
import { Agent, createSigner, createUser, filter } from "@xmtp/agent-sdk";
import type { Conversation } from "@xmtp/node-sdk";
import { isAddress } from "viem";
import { DEFAULT_RULES, type TradeEvent, type UserState } from "./types.js";
import { runHeuristics } from "./heuristics.js";
import {
  generateDailyCheckIn,
  generateIntervention,
  generateLiquidationPostMortem,
  generateRefusal,
} from "./interventions.js";
import { createBaseClient, getPortfolioSnapshot, pollWallet } from "./watcher.js";
import { fetchCallbackCloses, fetchTraderOpens, perpScanRange } from "./perps/avantis.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const DAILY_CHECKIN_HOUR = Number(process.env.DAILY_CHECKIN_HOUR ?? 20);
const CHECKIN_INTERVAL_MS = 15 * 60_000;
const MAX_TRADES_KEPT = 200;
const MAX_SNAPSHOTS_KEPT = 200;

/** Watched users, keyed by XMTP conversation id (one DM == one user). */
const users = new Map<string, UserState>();
/** Live conversation handles for proactive (unprompted) sends. */
const conversations = new Map<string, Conversation>();

// --- text helpers ---

/** Detect "should I buy/sell/long X?" style messages — we refuse these. */
const SIGNAL_REQUEST =
  /\b(buy|sell|long|short|ape|aping|entry|exit|moon|pump|dump|bullish|bearish|wen|lambo)\b|\b(price target|good time to|will it go (up|down)|should i (get|hold|sell|buy))\b/i;

function isSignalRequest(text: string): boolean {
  return SIGNAL_REQUEST.test(text);
}

const ONBOARDING = [
  "I'm your trading discipline coach — I watch your wallet and call out when you break your own plan. I do not give buy/sell calls. Ever.",
  "",
  "To start, send: watch 0xYourWalletAddress",
  "Then set your rules: set trades 5  ·  set size 500",
].join("\n");

const HELP = [
  "Commands:",
  "· watch 0x… — set the wallet I monitor",
  "· set trades N — your max trades per day",
  "· set size P — your max single-position size in USD",
  "· rules — show your current plan",
  "· status — today's activity",
  "· stop / resume — mute or unmute me",
].join("\n");

function rulesText(state: UserState): string {
  const r = state.rules;
  const size = r.maxPositionSizeUsd > 0 ? `$${r.maxPositionSizeUsd}` : "not set";
  return [
    "Your plan:",
    `· max ${r.maxTradesPerDay} trades/day`,
    `· max position size: ${size}`,
    `· no-trade hours: ${r.noTradeStartHour}:00–${r.noTradeEndHour}:00`,
  ].join("\n");
}

function statusText(state: UserState): string {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todays = state.trades.filter((t) => t.timestamp >= startOfDay.getTime());
  return [
    `Watching: ${state.wallet}`,
    `Trades today: ${todays.length} / ${state.rules.maxTradesPerDay}`,
    state.paused ? "Status: muted (send resume to re-enable)" : "Status: active",
  ].join("\n");
}

function isSameLocalDay(aMs: number | undefined, bMs: number): boolean {
  if (aMs === undefined) return false;
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Send an unprompted message to a stored conversation; never throws. */
async function sendTo(conversationId: string, text: string): Promise<void> {
  const convo = conversations.get(conversationId);
  if (!convo) return;
  try {
    await convo.sendText(text);
  } catch (err) {
    console.error("[send] failed:", err instanceof Error ? err.message : err);
  }
}

// --- message handling ---

async function handleText(ctx: {
  message: { content: string; senderInboxId: string };
  conversation: Conversation;
  client: Parameters<typeof filter.fromSelf>[1];
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  // Ignore our own messages.
  if (filter.fromSelf(ctx.message as never, ctx.client)) return;

  const text = (ctx.message.content ?? "").trim();
  if (!text) return;
  const lower = text.toLowerCase();
  const conversationId = ctx.conversation.id;
  conversations.set(conversationId, ctx.conversation);

  // Brand rule: refuse signal requests before anything else.
  if (isSignalRequest(lower)) {
    await ctx.sendTextReply(await generateRefusal(text));
    return;
  }

  // Onboarding: "watch 0x…"
  if (lower.startsWith("watch")) {
    const addr = text.split(/\s+/)[1];
    if (!addr || !isAddress(addr)) {
      await ctx.sendTextReply("That doesn't look like a valid 0x address. Try: watch 0x…");
      return;
    }
    const state: UserState = {
      wallet: addr.toLowerCase(),
      inboxId: ctx.message.senderInboxId,
      conversationId,
      rules: { ...DEFAULT_RULES },
      trades: [],
      snapshots: [],
      lastSignalAt: {},
      paused: false,
      onboardedAt: Date.now(),
    };
    users.set(conversationId, state);
    await ctx.sendTextReply(
      `Watching ${state.wallet}. I'll flag when you break your own plan.\n\n${rulesText(state)}\n\nAdjust anytime: set trades N · set size P`,
    );
    return;
  }

  const state = users.get(conversationId);
  if (!state) {
    await ctx.sendTextReply(ONBOARDING);
    return;
  }

  if (lower === "rules") {
    await ctx.sendTextReply(rulesText(state));
    return;
  }

  if (lower.startsWith("set trades")) {
    const n = parseInt(lower.replace("set trades", "").trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      await ctx.sendTextReply("Give me a positive number, e.g. set trades 5");
      return;
    }
    state.rules.maxTradesPerDay = n;
    await ctx.sendTextReply(`Done — max ${n} trades/day. That's your line now.`);
    return;
  }

  if (lower.startsWith("set size")) {
    const p = parseFloat(lower.replace("set size", "").replace(/[$,]/g, "").trim());
    if (!Number.isFinite(p) || p <= 0) {
      await ctx.sendTextReply("Give me a positive USD amount, e.g. set size 500");
      return;
    }
    state.rules.maxPositionSizeUsd = p;
    await ctx.sendTextReply(`Done — max $${p} per position. I'll flag anything bigger.`);
    return;
  }

  if (lower === "status") {
    await ctx.sendTextReply(statusText(state));
    return;
  }

  if (lower === "stop" || lower === "mute") {
    state.paused = true;
    await ctx.sendTextReply("Muted. I won't message you until you send resume.");
    return;
  }

  if (lower === "resume" || lower === "start") {
    state.paused = false;
    await ctx.sendTextReply("Back on. I'll keep you honest.");
    return;
  }

  await ctx.sendTextReply(HELP);
}

// --- background loops ---

function startLoops(): void {
  const client = createBaseClient();

  // Behavior-triggered: poll wallets and run heuristics.
  setInterval(() => {
    void pollAllWallets(client);
  }, POLL_INTERVAL_MS);

  // The single allowed scheduled message: evening check-in.
  setInterval(() => {
    void runDailyCheckIns();
  }, CHECKIN_INTERVAL_MS);
}

/** Liquidations we've already debriefed, keyed `${wallet}:${txHash}` (dedup). */
const liquidationsHandled = new Set<string>();

/** Shared Avantis scan cursor — perps are fetched once per cycle, not per user. */
let perpCursor: bigint | undefined;

/** Merge new trades in chronological order and cap memory. */
function appendTrades(state: UserState, incoming: TradeEvent[]): void {
  if (incoming.length === 0) return;
  state.trades.push(...incoming);
  state.trades.sort((a, b) => a.timestamp - b.timestamp);
  if (state.trades.length > MAX_TRADES_KEPT) {
    state.trades.splice(0, state.trades.length - MAX_TRADES_KEPT);
  }
}

/** Send a one-time structured post-mortem for each newly-seen liquidation. */
async function handleLiquidations(state: UserState, events: TradeEvent[]): Promise<void> {
  for (const event of events) {
    if (!event.isLiquidation) continue;
    const key = `${state.wallet}:${event.txHash}`;
    if (liquidationsHandled.has(key)) continue;
    liquidationsHandled.add(key);
    const message = await generateLiquidationPostMortem(state, event);
    await sendTo(state.conversationId, message);
  }
}

/**
 * Perp poll for the whole cohort: ONE callbacks fetch per cycle, fanned out by
 * trader. Opens stay per-wallet (indexed, cheap). Advances the shared cursor
 * only after the global fetch succeeds, so a failure simply retries next cycle.
 */
async function pollPerps(client: ReturnType<typeof createBaseClient>): Promise<void> {
  const active = [...users.values()].filter((s) => !s.paused);
  if (active.length === 0) return;
  const latest = await client.getBlockNumber();
  const range = perpScanRange(latest, perpCursor);
  if (!range) return;

  // Single global fetch of closes/liquidations for the range, shared by all users.
  const allCloses = await fetchCallbackCloses(client, range.from, range.to);

  for (const state of active) {
    try {
      const wallet = state.wallet.toLowerCase();
      const opens = await fetchTraderOpens(client, state.wallet, range.from, range.to);
      const mine = allCloses.filter((e) => e.wallet === wallet);
      const events = [...opens, ...mine].sort((a, b) => a.timestamp - b.timestamp);
      appendTrades(state, events);
      await handleLiquidations(state, events);
    } catch (err) {
      console.error("[watcher] perp fan-out failed:", err instanceof Error ? err.message : err);
    }
  }
  perpCursor = range.to;
}

async function pollAllWallets(client: ReturnType<typeof createBaseClient>): Promise<void> {
  const now = Date.now();

  // Perps once per cycle (single shared callbacks fetch). Isolated so a perp
  // failure never blocks spot polls, snapshots, or heuristics.
  try {
    await pollPerps(client);
  } catch (err) {
    console.error("[watcher] perp cycle failed:", err instanceof Error ? err.message : err);
  }

  for (const state of users.values()) {
    if (state.paused) continue;

    // Spot trades (DEX routers).
    try {
      appendTrades(state, await pollWallet(client, state));
    } catch (err) {
      console.error("[watcher] spot poll failed:", err instanceof Error ? err.message : err);
    }

    // Portfolio snapshot for drawdown velocity.
    try {
      state.snapshots.push(await getPortfolioSnapshot(client, state.wallet));
      if (state.snapshots.length > MAX_SNAPSHOTS_KEPT) {
        state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS_KEPT);
      }
    } catch (err) {
      console.error("[watcher] snapshot failed:", err instanceof Error ? err.message : err);
    }

    // Heuristics decide WHEN; the LLM only words it.
    try {
      for (const signal of runHeuristics(state, now)) {
        const message = await generateIntervention(signal, state.rules);
        await sendTo(state.conversationId, message);
      }
    } catch (err) {
      console.error("[watcher] heuristics failed:", err instanceof Error ? err.message : err);
    }
  }
}

async function runDailyCheckIns(): Promise<void> {
  const now = new Date();
  if (now.getHours() !== DAILY_CHECKIN_HOUR) return;
  for (const state of users.values()) {
    if (state.paused) continue;
    if (isSameLocalDay(state.lastDailyCheckInAt, now.getTime())) continue;
    try {
      const message = await generateDailyCheckIn(state);
      await sendTo(state.conversationId, message);
      state.lastDailyCheckInAt = now.getTime();
    } catch (err) {
      console.error("[checkin] failed:", err instanceof Error ? err.message : err);
    }
  }
}

// --- boot ---

async function main(): Promise<void> {
  const walletKey = process.env.WALLET_KEY;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!walletKey || !encryptionKey) {
    console.error("Missing WALLET_KEY / ENCRYPTION_KEY in .env. Run: npm run gen:keys");
    process.exit(1);
  }

  const user = createUser(walletKey as `0x${string}`);
  const signer = createSigner(user);
  const agent = await Agent.create(signer, {
    dbEncryptionKey: encryptionKey as `0x${string}`,
    env: (process.env.XMTP_ENV ?? "dev") as "local" | "dev" | "production",
  });

  agent.on("text", (ctx) => {
    void handleText(ctx as never).catch((err) =>
      console.error("[handler] error:", err instanceof Error ? err.message : err),
    );
  });

  agent.on("unhandledError", (err) => {
    console.error("[agent] unhandled:", err instanceof Error ? err.message : err);
  });

  agent.on("start", () => {
    console.log(`Discipline agent live on XMTP (${process.env.XMTP_ENV ?? "dev"}).`);
    console.log(`Agent address: ${agent.address ?? "unknown"}`);
    startLoops();
  });

  await agent.start();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
