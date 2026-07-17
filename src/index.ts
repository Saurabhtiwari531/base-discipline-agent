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
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import { computeDisciplineScore, formatScoreCard, scoreLabel } from "./score.js";
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
} from "./db.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const DAILY_CHECKIN_HOUR = Number(process.env.DAILY_CHECKIN_HOUR ?? 20);
const CHECKIN_INTERVAL_MS = 15 * 60_000;
const MAX_TRADES_KEPT = 200;
const MAX_SNAPSHOTS_KEPT = 200;

/** SQLite handle — set once in main() before any loops start. */
let db: DatabaseSync;

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
  "Step 1 of 3 — paste the address of the wallet you trade with. Just the address is fine, like:",
  "0x1234...abcd",
].join("\n");

/** Short nudge when someone keeps chatting without giving an address. */
const ONBOARDING_NUDGE =
  "I just need your wallet address to start — paste it here (it starts with 0x).";

/** Matches an EVM address anywhere inside a message. */
const ADDRESS_ANYWHERE = /0x[a-fA-F0-9]{40}/;

/** "hi", "hello", "gm", "hey" style openers. */
const GREETING = /^(hi|hii+|hello|hey|yo|gm|gn|namaste|sup|hola)\b[\s!.]*$/i;

const HELP = [
  "Commands:",
  "· watch 0x… — set the wallet I monitor",
  "· set trades N — your max trades per day",
  "· set size P — your max single-position size in USD",
  "· rules — show your current plan",
  "· status — today's activity",
  "· score — your 14-day discipline score",
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
  const s = computeDisciplineScore(state);
  return [
    `Watching: ${state.wallet}`,
    `Trades today: ${todays.length} / ${state.rules.maxTradesPerDay}`,
    `Discipline score: ${s.score}/100 (${scoreLabel(s.score)}, ${s.windowDays}d)`,
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

/**
 * XMTP re-syncs on every stream reconnect and re-emits recent messages, so the
 * same message can reach the handler many times (observed: 1 user "hello" ->
 * ~15 duplicate replies during a flaky-network stretch). Dedup by message id,
 * and never answer stale backlog after downtime.
 */
const processedMessages = new Set<string>();
const MAX_PROCESSED_KEPT = 2000;
const MAX_MESSAGE_AGE_MS = 10 * 60_000;

function messageSentAtMs(m: { sentAt?: unknown; sentAtNs?: unknown }): number {
  if (m.sentAt instanceof Date) return m.sentAt.getTime();
  if (typeof m.sentAtNs === "bigint") return Number(m.sentAtNs / 1_000_000n);
  return Date.now(); // unknown shape — treat as fresh rather than drop
}

async function handleText(ctx: {
  message: { id?: string; content: string; senderInboxId: string; sentAt?: unknown; sentAtNs?: unknown };
  conversation: Conversation;
  client: Parameters<typeof filter.fromSelf>[1];
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  // Ignore our own messages.
  if (filter.fromSelf(ctx.message as never, ctx.client)) return;

  // Exactly-once: skip anything we've already handled this process lifetime.
  const msgId = ctx.message.id;
  if (msgId) {
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    if (processedMessages.size > MAX_PROCESSED_KEPT) {
      let dropped = 0;
      for (const id of processedMessages) {
        processedMessages.delete(id);
        if (++dropped >= MAX_PROCESSED_KEPT / 2) break;
      }
    }
  }

  // Don't answer stale backlog (e.g. messages that arrived while we were down).
  if (Date.now() - messageSentAtMs(ctx.message) > MAX_MESSAGE_AGE_MS) return;

  // DMs only for now. Base App etiquette: in group chats an agent must reply
  // only when @mentioned — that lands with Squad mode (roadmap #6). Until
  // then, silently ignore group messages so we never spam a group.
  if (!filter.isDM(ctx.conversation as never)) return;

  await handleCommand(
    (ctx.message.content ?? "").trim(),
    ctx.message.senderInboxId,
    ctx.conversation,
    ctx.sendTextReply,
  );
}

/**
 * The command brain, shared by both delivery paths: the live stream (replies
 * via quoted sendTextReply) and the catch-up sync loop (plain sendText).
 */
async function handleCommand(
  text: string,
  senderInboxId: string,
  conversation: Conversation,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  if (!text) return;
  const lower = text.toLowerCase();
  const conversationId = conversation.id;
  conversations.set(conversationId, conversation);

  const existing = users.get(conversationId);

  // Brand rule: refuse signal requests before anything else.
  if (isSignalRequest(lower)) {
    await reply(await generateRefusal(text));
    return;
  }

  // Onboarding: "watch 0x…" — but real users often just paste the address, or
  // write around it ("this is my wallet 0x…"). Accept an address ANYWHERE in
  // the message during onboarding, and a bare address later as a wallet switch.
  const addressInText = text.match(ADDRESS_ANYWHERE)?.[0];
  const bareAddressOnly =
    addressInText !== undefined && text.replace(ADDRESS_ANYWHERE, "").trim() === "";
  if (lower.startsWith("watch") || (addressInText && (!existing || bareAddressOnly))) {
    const addr = addressInText;
    if (!addr || !isAddress(addr)) {
      await reply(
        "That doesn't look like a valid wallet address — it should be 42 characters starting with 0x. Paste it again?",
      );
      return;
    }
    const state: UserState = {
      wallet: addr.toLowerCase(),
      inboxId: senderInboxId,
      conversationId,
      rules: { ...DEFAULT_RULES },
      trades: [],
      snapshots: [],
      lastSignalAt: {},
      paused: false,
      onboardedAt: Date.now(),
    };
    users.set(conversationId, state);
    saveUser(db, state);
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    await reply(
      existing
        ? `Switched — now watching ${short}.\n\n${rulesText(state)}`
        : `Step 1 done ✓ Watching ${short}.\n\nStep 2 of 3 — how many trades per day is YOUR limit? Reply like:\nset trades 5`,
    );
    return;
  }

  const state = existing;
  if (!state) {
    // No wallet yet: first contact gets the full intro, everything after gets
    // a short nudge — repeating the same wall of text reads like a broken bot.
    await reply(GREETING.test(text) ? ONBOARDING : ONBOARDING_NUDGE);
    return;
  }

  // Greeting from an onboarded user — reassure, don't dump the help menu.
  if (GREETING.test(text)) {
    const short = `${state.wallet.slice(0, 6)}…${state.wallet.slice(-4)}`;
    await reply(
      `All good — I'm watching ${short}. Send status, score or rules anytime. I'll only message you when your plan breaks.`,
    );
    return;
  }

  if (lower === "rules") {
    await reply(rulesText(state));
    return;
  }

  if (lower.startsWith("set trades")) {
    const n = parseInt(lower.replace("set trades", "").trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      await reply("Give me a positive number, e.g. set trades 5");
      return;
    }
    state.rules.maxTradesPerDay = n;
    saveUser(db, state);
    // Still onboarding (no size set yet) -> guide to the final step.
    await reply(
      state.rules.maxPositionSizeUsd <= 0
        ? `Step 2 done ✓ Max ${n} trades/day.\n\nLast step — your max size per position, in USD. Reply like:\nset size 500`
        : `Done — max ${n} trades/day. That's your line now.`,
    );
    return;
  }

  if (lower.startsWith("set size")) {
    const p = parseFloat(lower.replace("set size", "").replace(/[$,]/g, "").trim());
    if (!Number.isFinite(p) || p <= 0) {
      await reply("Give me a positive USD amount, e.g. set size 500");
      return;
    }
    const firstTime = state.rules.maxPositionSizeUsd <= 0;
    state.rules.maxPositionSizeUsd = p;
    saveUser(db, state);
    await reply(
      firstTime
        ? `Step 3 done ✓ Max $${p} per position.\n\nThat's your plan — I'm watching now. You'll only hear from me when you break it (plus one evening check-in). Try: score`
        : `Done — max $${p} per position. I'll flag anything bigger.`,
    );
    return;
  }

  if (lower === "status") {
    await reply(statusText(state));
    return;
  }

  if (lower === "score") {
    const s = computeDisciplineScore(state);
    await reply(formatScoreCard(state.wallet, s));
    return;
  }

  if (lower === "stop" || lower === "mute") {
    state.paused = true;
    saveUser(db, state);
    await reply("Muted. I won't message you until you send resume.");
    return;
  }

  if (lower === "resume" || lower === "start") {
    state.paused = false;
    saveUser(db, state);
    await reply("Back on. I'll keep you honest.");
    return;
  }

  await reply(`Didn't catch that — here's what I understand:\n\n${HELP}`);
}

// --- background loops ---

/**
 * Catch-up sync: the live stream drops on flaky networks and messages that
 * arrive in the gap are never re-emitted. Every cycle we sync from the network
 * and answer anything recent that the stream missed (dedup via processedMessages
 * keeps this exactly-once alongside the stream path).
 */
async function catchUpMissedMessages(agent: Agent): Promise<void> {
  await agent.client.conversations.syncAll();
  const myInboxId = agent.client.inboxId;
  const convos = await agent.client.conversations.list();

  for (const convo of convos) {
    if (!filter.isDM(convo as never)) continue;
    try {
      const recent = await (convo as Conversation).messages({ limit: 10n } as never);
      const pending = recent
        .filter((m) => {
          if (!m.id || processedMessages.has(m.id)) return false;
          if (m.senderInboxId === myInboxId) return false;
          if (typeof m.content !== "string") return false;
          return Date.now() - messageSentAtMs(m) <= MAX_MESSAGE_AGE_MS;
        })
        .sort((a, b) => messageSentAtMs(a) - messageSentAtMs(b));

      for (const m of pending) {
        processedMessages.add(m.id);
        await handleCommand(
          (m.content as string).trim(),
          m.senderInboxId,
          convo as Conversation,
          (t) => (convo as Conversation).sendText(t).then(() => undefined),
        );
      }
    } catch (err) {
      console.error("[catchup] conversation failed:", err instanceof Error ? err.message : err);
    }
  }
}

/** The XMTP SDK re-emits "start" after every stream reconnect — loops must start once. */
let loopsStarted = false;

function startLoops(agent: Agent): void {
  if (loopsStarted) return;
  loopsStarted = true;
  const client = createBaseClient();

  // Missed-message catch-up: guarantees no DM goes unanswered even when the
  // live stream is down. Overlap-guarded like the wallet poll.
  let catchingUp = false;
  setInterval(() => {
    if (catchingUp) return;
    catchingUp = true;
    catchUpMissedMessages(agent)
      .catch((err) =>
        console.error("[catchup] cycle failed:", err instanceof Error ? err.message : err),
      )
      .finally(() => {
        catchingUp = false;
      });
  }, 60_000);

  // Behavior-triggered: poll wallets and run heuristics.
  // Overlap guard: a slow RPC can make one cycle outlast the interval; running
  // two cycles concurrently would double-ingest trades and fire false signals.
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void pollAllWallets(client).finally(() => {
      polling = false;
    });
  }, POLL_INTERVAL_MS);

  // The single allowed scheduled message: evening check-in.
  setInterval(() => {
    void runDailyCheckIns();
  }, CHECKIN_INTERVAL_MS);
}

/** Liquidations we've already debriefed, keyed `${wallet}:${txHash}` (dedup). */
let liquidationsHandled = new Set<string>();

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
      persistTrades(db, state.conversationId, events);
      await handleLiquidations(state, events);
    } catch (err) {
      console.error("[watcher] perp fan-out failed:", err instanceof Error ? err.message : err);
    }
  }

  perpCursor = range.to;
  savePerpCursor(db, range.to);
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
      const newTrades = await pollWallet(client, state);
      appendTrades(state, newTrades);
      persistTrades(db, state.conversationId, newTrades);
    } catch (err) {
      console.error("[watcher] spot poll failed:", err instanceof Error ? err.message : err);
    }

    // Portfolio snapshot for drawdown velocity.
    try {
      const snap = await getPortfolioSnapshot(client, state.wallet);
      state.snapshots.push(snap);
      if (state.snapshots.length > MAX_SNAPSHOTS_KEPT) {
        state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS_KEPT);
      }
      persistSnapshot(db, state.conversationId, snap);
    } catch (err) {
      console.error("[watcher] snapshot failed:", err instanceof Error ? err.message : err);
    }

    // Heuristics decide WHEN; the LLM only words it.
    try {
      for (const signal of runHeuristics(state, now)) {
        updateSignalLog(db, state.conversationId, signal.type, signal.detectedAt);
        const message = await generateIntervention(signal, state.rules);
        await sendTo(state.conversationId, message);
      }
    } catch (err) {
      console.error("[watcher] heuristics failed:", err instanceof Error ? err.message : err);
    }

    // Persist updated block cursor after all per-user work for this cycle.
    try {
      saveBlockCursors(db, state);
    } catch (err) {
      console.error("[watcher] cursor save failed:", err instanceof Error ? err.message : err);
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
      const score = computeDisciplineScore(state, now.getTime());
      const message = await generateDailyCheckIn(state, score);
      await sendTo(state.conversationId, message);
      state.lastDailyCheckInAt = now.getTime();
      saveUser(db, state);
    } catch (err) {
      console.error("[checkin] failed:", err instanceof Error ? err.message : err);
    }
  }
}

// --- boot ---

/**
 * Rebuild the conversation handles for restored users so proactive sends work
 * immediately after a restart. Without this, every restored user is silently
 * unreachable until they happen to message us first.
 */
async function rehydrateConversations(agent: Agent): Promise<void> {
  if (users.size === 0) return;
  try {
    await agent.client.conversations.sync();
  } catch (err) {
    console.error("[boot] conversations sync failed:", err instanceof Error ? err.message : err);
  }
  let restored = 0;
  for (const state of users.values()) {
    try {
      const convo = await agent.client.conversations.getConversationById(state.conversationId);
      if (convo) {
        conversations.set(state.conversationId, convo as unknown as Conversation);
        restored++;
      }
    } catch (err) {
      console.error("[boot] conversation restore failed:", err instanceof Error ? err.message : err);
    }
  }
  console.log(`Rehydrated ${restored}/${users.size} conversation handle(s).`);
}

async function main(): Promise<void> {
  const walletKey = process.env.WALLET_KEY;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!walletKey || !encryptionKey) {
    console.error("Missing WALLET_KEY / ENCRYPTION_KEY in .env. Run: npm run gen:keys");
    process.exit(1);
  }

  // Open SQLite and restore state from previous run.
  const dbPath = process.env.DB_PATH ?? "./data/agent.db";
  db = openDb(dbPath);
  for (const state of loadAllUsers(db)) {
    users.set(state.conversationId, state);
  }
  liquidationsHandled = loadLiquidationKeys(db);
  perpCursor = loadPerpCursor(db);
  console.log(`Restored ${users.size} user(s) from DB.`);

  const xmtpEnv = (process.env.XMTP_ENV ?? "dev") as "local" | "dev" | "production";
  const user = createUser(walletKey as `0x${string}`);
  const signer = createSigner(user);
  const agent = await Agent.create(signer, {
    dbEncryptionKey: encryptionKey as `0x${string}`,
    env: xmtpEnv,
    // Keep the XMTP identity DB next to the agent DB (one persistent volume).
    // Losing it creates a new XMTP "installation" every restart, and an inbox
    // is hard-capped at ~10 installations — after that the agent is bricked.
    dbPath: (inboxId) => join(dirname(dbPath), `xmtp-${xmtpEnv}-${inboxId}.db3`),
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
    console.log(`Discipline agent live on XMTP (${xmtpEnv}).`);
    console.log(`Agent address: ${agent.address ?? "unknown"}`);
    void rehydrateConversations(agent).finally(() => startLoops(agent));
  });

  // Graceful shutdown: stop XMTP streams, close SQLite cleanly. The 5s timer
  // hard-exits if either hangs (e.g. network stall during agent.stop()).
  const shutdown = (signal: string) => {
    console.log(`[${signal}] shutting down…`);
    setTimeout(() => process.exit(1), 5000).unref();
    void (async () => {
      try {
        await agent.stop();
      } catch {}
      try {
        db.close();
      } catch {}
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await agent.start();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
