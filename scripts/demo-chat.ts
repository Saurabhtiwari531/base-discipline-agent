/**
 * User-facing demo — a real conversation with the agent, formatted like chat.
 * Recorded with VHS (demo/demo.tape) to produce the MP4/GIF used in the
 * launch thread. This is NOT a test: no asserts, pacing tuned for viewers.
 *
 *   1) start a demo agent on dev:
 *      XMTP_ENV=dev DB_PATH=/tmp/demo-agent.db npx tsx src/index.ts
 *   2) AGENT_ADDRESS=0x… npx tsx scripts/demo-chat.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";

const AGENT_ADDRESS = process.env.AGENT_ADDRESS;
const REPLY_TIMEOUT_MS = 30_000;

/**
 * When DEMO_TIMELINE is set, every visual event is logged (ms since script
 * start) so scripts/render-sfx.ts can place sounds frame-perfectly on the
 * recording made from this same run.
 */
const TIMELINE_PATH = process.env.DEMO_TIMELINE;
const t0 = Date.now();
type TimelineMsg = { typeStart: number; chars: number; sentAt: number; replyAt: number; replyLines: number };
const timeline: { bannerAt: number; msgs: TimelineMsg[]; outroAt: number } = {
  bannerAt: 0,
  msgs: [],
  outroAt: 0,
};
const now = () => Date.now() - t0;

// ANSI
const CYAN = "\x1b[1;36m";
const GREEN = "\x1b[1;32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Demo must survive stray background rejections from the XMTP client —
// a crash mid-recording ruins the take.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", (err) => {
  console.error(`\n  (demo error: ${err.message})`);
});

async function typeOut(text: string, msPerChar = 28): Promise<void> {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(msPerChar);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const inner = (content as { content?: unknown }).content;
    if (typeof inner === "string") return inner;
    if (inner && typeof inner === "object") {
      const inner2 = (inner as { content?: unknown }).content;
      if (typeof inner2 === "string") return inner2;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!AGENT_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(AGENT_ADDRESS)) {
    console.error("Set AGENT_ADDRESS=0x…");
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "demo-xmtp-"));
  const user = createUser();
  const signer = createSigner(user);
  const client = await Agent.create(signer, {
    env: "dev",
    dbEncryptionKey: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    dbPath: (inboxId) => join(tmp, `demo-${inboxId}.db3`),
  });
  const dm = await client.createDmWithAddress(AGENT_ADDRESS as `0x${string}`);
  const myInboxId = client.client.inboxId;
  const seen = new Set<string>();
  for (const m of await dm.messages()) seen.add(m.id);

  async function say(text: string): Promise<void> {
    process.stdout.write(`\n  ${CYAN}You${RESET}    `);
    const typeStart = now();
    await typeOut(text);
    process.stdout.write("\n");
    const sentAt = now();
    await dm.sendText(text);

    process.stdout.write(`  ${GREEN}Agent${RESET}  ${DIM}typing…${RESET}`);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      await dm.sync();
      for (const m of await dm.messages()) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.senderInboxId === myInboxId) continue;
        const reply = textOf(m.content);
        if (reply === undefined) continue;
        const lines = reply.split("\n");
        timeline.msgs.push({ typeStart, chars: text.length, sentAt, replyAt: now(), replyLines: lines.length });
        process.stdout.write(CLEAR_LINE);
        process.stdout.write(`  ${GREEN}Agent${RESET}  ${lines[0] ?? ""}\n`);
        for (const line of lines.slice(1)) {
          process.stdout.write(`         ${line}\n`);
          await sleep(60);
        }
        await sleep(1400);
        return;
      }
    }
    process.stdout.write(`${CLEAR_LINE}  ${DIM}(no reply — is the agent running?)${RESET}\n`);
    process.exit(1);
  }

  timeline.bannerAt = now();
  console.log(`\n  ${BOLD}● Base Discipline Agent${RESET}`);
  console.log(`  ${DIM}An AI coach that watches your wallet on Base and calls you`);
  console.log(`  out when you break your own trading plan. Live on XMTP ↓${RESET}`);
  await sleep(1800);

  await say("hello");
  await say("watch 0x4200000000000000000000000000000000000006");
  await say("set trades 3");
  await say("set size 500");
  await say("score");
  await say("should i buy eth?");

  await sleep(600);
  timeline.outroAt = now();
  console.log(`\n  ${BOLD}✓ It enforces YOUR plan. It never gives signals.${RESET}`);
  console.log(`  ${DIM}DM the agent on Base App → ${AGENT_ADDRESS}${RESET}\n`);

  if (TIMELINE_PATH) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(TIMELINE_PATH, JSON.stringify(timeline, null, 2));
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
