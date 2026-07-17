/**
 * End-to-end chat test against a RUNNING agent on XMTP dev.
 *
 *   1) start the agent:  npm start   (XMTP_ENV=dev)
 *   2) run this:         AGENT_ADDRESS=0x… npx tsx scripts/e2e-chat-test.ts
 *
 * Creates a throwaway XMTP identity, DMs the agent, and walks the whole
 * user journey: onboarding → watch → rules → status → score → signal-request
 * refusal → stop. Asserts on the reply contents (with the Anthropic key unset
 * or invalid, replies are the deterministic static fallbacks).
 *
 * Dev-network only. The throwaway identity's XMTP db lives in a temp dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";

const AGENT_ADDRESS = process.env.AGENT_ADDRESS;
const REPLY_TIMEOUT_MS = 20_000;
const POLL_MS = 500;

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!AGENT_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(AGENT_ADDRESS)) {
    fail("Set AGENT_ADDRESS=0x… (the address the agent prints at boot).");
  }

  const tmp = mkdtempSync(join(tmpdir(), "e2e-xmtp-"));
  const user = createUser(); // fresh random identity per run
  const signer = createSigner(user);
  const client = await Agent.create(signer, {
    env: "dev",
    dbEncryptionKey: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    dbPath: (inboxId) => join(tmp, `test-${inboxId}.db3`),
  });

  console.log(`Test user: ${client.address}`);
  const dm = await client.createDmWithAddress(AGENT_ADDRESS as `0x${string}`);
  const myInboxId = client.client.inboxId;
  const seen = new Set<string>();

  // Pre-mark anything already in the conversation (fresh DM: usually empty).
  for (const m of await dm.messages()) seen.add(m.id);

  /**
   * The agent answers commands via sendTextReply → the XMTP Reply content type
   * (a quoted reply), and proactive sends via plain text. Accept both shapes.
   */
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

  async function ask(text: string): Promise<string> {
    await dm.sendText(text);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      await dm.sync();
      const msgs = await dm.messages();
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.senderInboxId === myInboxId) continue; // our own message
        const reply = textOf(m.content);
        if (reply === undefined) continue; // non-text (e.g. group meta)
        return reply;
      }
    }
    fail(`No reply to "${text}" within ${REPLY_TIMEOUT_MS / 1000}s. Is the agent running?`);
  }

  const steps: Array<{ send: string; expect: RegExp; label: string }> = [
    { label: "onboarding", send: "hello", expect: /trading discipline coach/i },
    {
      label: "watch",
      send: "watch 0x4200000000000000000000000000000000000006",
      expect: /Watching 0x4200/i,
    },
    { label: "rules", send: "rules", expect: /Your plan/i },
    { label: "status", send: "status", expect: /Trades today/i },
    { label: "score", send: "score", expect: /Discipline Score: 100\/100/i },
    {
      label: "refusal",
      send: "should i buy eth?",
      // Static fallback (Anthropic key invalid) or live Haiku wording — either
      // way it must refuse; it must never comply with a signal request.
      expect: /don't give buy|not what I do|your (own )?plan|rules/i,
    },
    { label: "stop", send: "stop", expect: /Muted/i },
  ];

  let passed = 0;
  for (const step of steps) {
    const reply = await ask(step.send);
    const ok = step.expect.test(reply);
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${step.label}`);
    console.log(`  > ${step.send}`);
    console.log(`  < ${reply.split("\n").join("\n    ")}`);
    if (!ok) fail(`step "${step.label}" — reply did not match ${step.expect}`);
    passed++;
  }

  console.log(`\n${passed}/${steps.length} steps passed.`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
