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
- **TypeScript, Node, tsx.** In-memory state for now; SQLite is on the roadmap.

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

## Current state of the codebase (skeleton complete)

```
src/index.ts          XMTP agent: onboarding (watch 0x...), commands (rules,
                      set trades N, set size P, status, stop), signal-request
                      refusal, watcher loop, daily check-in scheduler
src/heuristics.ts     7 rules: frequency_spike, size_escalation (after loss),
                      late_night, new_token_churn, drawdown_velocity,
                      rule_break_max_trades, rule_break_position_size
src/interventions.ts  Claude persona prompt + per-signal generation + static
                      fallbacks if API fails + daily check-in generator
src/watcher.ts        Base RPC polling vs known DEX routers (Uniswap V3/Universal,
                      Aerodrome, 1inch v6, Kyber). Portfolio snapshots (ETH only)
src/types.ts          UserRules, TradeEvent, UserState, Signal types
src/genKeys.ts        WALLET_KEY / ENCRYPTION_KEY generator
```

### Known stubs / gaps (intentional, fix in roadmap order)
- `usdValue: 0` on trades — needs swap-log decoding or an indexer
  (Alchemy Transfers API / CDP Data). Size-based heuristics are dead until this.
- `fetchEthUsd()` returns hardcoded 3000 — wire a price feed (Coingecko/CDP).
- Raw block scanning won't scale past a handful of users — move to indexer.
- State is in-memory — add SQLite before real users.
- Timezone is server-local — store per-user TZ for no-trade hours.

## CURRENT TASK (priority 1): Avantis perps read-only decoding

Leverage is the core story; spot-only detection is not enough. Build a module
`src/perps/avantis.ts` that, **without any partnership**, reads Avantis (perps DEX
on Base) onchain events for a watched wallet:

- Position opened: detect size, leverage, direction
- Position closed: detect realized PnL
- Liquidation events: detect and trigger a **liquidation post-mortem** flow

Steps:
1. Find Avantis contract addresses + ABIs (their docs/GitHub; verify on Basescan).
2. Decode position events into the existing `TradeEvent` shape (extend the type
   with `leverage?: number` and `isPerp?: boolean`).
3. New heuristics on top:
   - `leverage_escalation`: leverage jumps after a losing close (e.g. 3x -> 10x)
   - `post_liquidation_reentry`: new position opened < N minutes after liquidation
     (this is THE revenge-trading signal — highest severity)
4. Liquidation post-mortem: when liquidation detected, agent sends a structured
   debrief (what happened, where it deviated from the plan, cooldown suggestion).

## Roadmap after current task (in order — do not reorder)

2. **Indexer integration** — real USD values + token age -> unlocks size heuristics.
3. **Discipline Score (0-100)** — rolling plan-adherence score per wallet.
   Shareable card for Farcaster. This later becomes the API product.
4. **SQLite persistence.**
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
