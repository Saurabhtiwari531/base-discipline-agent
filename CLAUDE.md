# Base Discipline Agent — Project Context (CLAUDE.md)

> Drop this file in the project root. It is the handoff from the planning conversation.
> Continue from "CURRENT TASK" below. Do not re-plan what is already decided.

## What this is

An AI trading discipline agent for Base App. It watches a trader's on-chain wallet
activity on Base and intervenes when their behavior breaks **their own** trading plan.
It is a trading psychology coach / mentor — **never a signal provider**. Refusing to
give signals is the brand.

Origin: the founder (Saurabh) blew up a leveraged account in 2021 — $100 -> $470 ->
liquidated via revenge trading on 6x UNI longs. The product encodes those failure
patterns (tilt, loss-chasing, FOMO, oversized positions) as detection rules.

## Stack (decided — do not change)

- **XMTP Agent SDK** (`@xmtp/agent-sdk`) — official way to build chat agents for
  Base App. Base App requires `XMTP_ENV=production`; test on dev via xmtp.chat first.
- **viem** for Base chain reads. RPC via Alchemy/CDP free tier.
- **Anthropic API** for intervention message wording. Use **Haiku 4.5**
  (`claude-haiku-4-5`) — cost at scale ~$16/mo for 100 users. Model name in env var.
- **TypeScript, Node, tsx.** State: in-memory maps + SQLite persistence
  (built-in `node:sqlite`, Node 22.5+ — no extra dependency).

## Core design rules (non-negotiable)

1. **Heuristics decide WHEN to intervene. The LLM only decides the WORDING.**
   Never let the LLM decide whether to send a message.
2. **Max 1 scheduled message per day** (evening check-in). Everything else must be
   behavior-triggered. Anti-notification-fatigue is a product rule.
3. Same signal fires max once per 4 hours (rate limit in heuristics.ts).
4. The user writes their own rules during onboarding; the agent enforces THEIR plan.
5. Any "should I buy/sell/long X?" message -> refuse + redirect to their plan.
6. Persona: professional, calm, direct, supportive but firm. A mentor who has been
   liquidated and survived. No hype, no preachiness, 1-3 sentences per intervention,
   always end with one concrete action.

## Current state of the codebase (feature-complete for validation)

```
src/index.ts          XMTP agent: onboarding (watch 0x...), commands (rules,
                      set trades N, set size P, status, score, stop), signal-request
                      refusal, watcher loop, daily check-in scheduler, SQLite wiring
src/heuristics.ts     10 rules: frequency_spike, size_escalation (after loss),
                      late_night, new_token_churn, drawdown_velocity,
                      rule_break_max_trades, rule_break_position_size,
                      leverage_escalation, post_liquidation_reentry,
                      large_position_pct (%-of-portfolio false-safety pattern)
src/interventions.ts  Claude persona prompt (incl. large-bankroll false-safety
                      psychology) + per-signal generation + static fallbacks +
                      daily check-in (with score) + liquidation post-mortem
src/watcher.ts        Base RPC polling vs known DEX routers. Real USD values via
                      receipt Transfer-log decoding (ETH/WETH/USDC/USDT/DAI) +
                      Coingecko ETH price feed (5-min cache, safe fallback)
src/perps/avantis.ts  Avantis perps read-only decoding: opens (size/leverage),
                      closes (realized PnL), liquidations -> post-mortem flow
src/score.ts          Discipline Score 0-100: pure 14-day recompute from trades,
                      weighted violations w/ per-category caps, shareable text card
src/db.ts             SQLite (node:sqlite): users/rules/trades/snapshots/signal_log,
                      full state restore on boot, prune to 200 rows/user
src/types.ts          UserRules, TradeEvent (incl. perp fields), UserState, Signal
src/genKeys.ts        WALLET_KEY / ENCRYPTION_KEY generator
test/                 21 tests: heuristics (signals + 4h rate limit) + score model
scripts/verify-decode.ts  On-chain verification of Avantis decoding
```

### Known gaps (accepted, revisit when they hurt)
- USD estimation covers ETH/WETH/stables legs only; exotic-token-in swaps read 0.
  Full fix = indexer (Alchemy Transfers / CDP Data), which also unlocks token age
  for new_token_churn precision.
- Raw block scanning won't scale past a handful of users — same indexer move.
- Timezone is server-local — store per-user TZ for no-trade hours before users
  outside the server TZ join.
- Discipline Score card is text-only; Farcaster image card later.

## CURRENT TASK (priority 1): deploy + validate with 20 test users

The engineering is validation-ready. The next unit of work is NOT more features:

1. ~~Local boot verified~~ — DONE 2026-07-16: agent connects to XMTP dev, SQLite
   restores state. Real WALLET_KEY/ENCRYPTION_KEY are in .env (never commit).
   NOTE: ANTHROPIC_API_KEY in .env is still a placeholder — static fallback
   messages work, but paste a real key before user testing.
   NOTE: macOS needs scripts/fix-xmtp-darwin.sh (runs via postinstall) — the
   @xmtp/node-bindings 1.10.0 darwin binary ships nix-linked libiconv. Linux
   (Docker) is unaffected.
2. ~~End-to-end conversation test~~ — DONE 2026-07-16 via scripts/e2e-chat-test.ts
   (throwaway XMTP identity DMs the live agent on dev): onboarding, watch, rules,
   status, score, signal-request refusal, stop — 7/7 pass. Note: command replies
   use the XMTP Reply content type (quoted replies), proactive sends plain text.
   Optional: repeat manually on https://xmtp.chat for eyeballs.
3. ~~Production flip~~ — DONE 2026-07-16: XMTP_ENV=production, agent verified
   live on the production network and left running on the founder's Mac via
   nohup (logs/agent.log). Decision: validation runs on static fallback
   messages ($0, no Anthropic key) — personalized Haiku wording comes later if
   the gate passes. data/agent.db was reset after e2e so the cohort starts
   clean; the XMTP db3 files in data/ MUST be kept (installation limit).
   Restart command: `nohup npx tsx src/index.ts >> logs/agent.log 2>&1 & disown`
   Move to Docker/VPS (README) when the Mac-as-server gets flaky.
4. Recruit ~20 test traders (founder's network + Farcaster thread). First user
   = the founder himself: DM the agent address from Base App, send `watch 0x…`.
5. Run the 2-week validation gate (see Business context). `npm run report` prints
   the gate metrics — "did they mute" is the only metric that matters.

Engineering side-quests only if validation stalls: per-user timezone, indexer.

## Roadmap after current task (in order — do not reorder)

2. **Indexer integration** — exotic-token USD values + token age.
   (Partially done: receipt decoding + price feed shipped 2026-07.)
3. ~~Discipline Score (0-100)~~ — DONE 2026-07 (src/score.ts). Farcaster image
   card + Score API remain future work.
4. ~~SQLite persistence~~ — DONE 2026-07 (src/db.ts).
5. **Hard Mode — onchain commitment contract (Solidity).** User locks their own
   rules (max size, daily limit, cooldown) in a contract; breaking requires a 24h
   timelock. Crypto-native self-exclusion. This is the hero/differentiator feature
   — build it AFTER the agent is validated with ~20 users, not before.
6. **Squad mode** — agent in a group chat, shared adherence visibility.

## Business context (so messaging/features stay aligned)

- B2C subscriptions are weak — people won't pay to be told to stop trading.
  Treat B2C as distribution, not revenue.
- Real money paths: (a) Base ecosystem grants/builder rewards/hackathons,
  (b) B2B pitch to perps platforms framed as **retention/LTV tool**
  ("liquidated users churn forever; disciplined users generate fees for years") —
  never frame it as reducing their volume, (c) later: Discipline Score API.
- Validation gate: 20 test users for 2 weeks. If 10+ don't mute the agent,
  invest further. If they all mute it, it stays a portfolio piece — stop there.
- Launch marketing = founder's real story ($100 -> $470 -> liquidation) as a
  Farcaster/X thread. Factual, minimal tone — no hype copy.

## Conventions

- Keep modules small and single-purpose like the existing files.
- Every external call (RPC, Anthropic) wrapped in try/catch; agent must never
  crash the watcher loop because one user's poll failed.
- Never log message contents in plaintext (XMTP guideline). Never commit keys.
- Owner's style: concise, practical, honest tradeoffs. When giving choices,
  give 2-3 options with a clear recommendation.
