# Base Discipline Agent

An AI trading-discipline agent for Base App. It watches a trader's on-chain wallet
(spot DEXes + Avantis perps) and messages them on XMTP when they break **their own**
trading plan. It never gives buy/sell calls — refusing to is the brand.

**Live on Base App now** — DM the agent: `0xba49cf88c69b05c6f89dabeb787f505e192c0180`

![Demo — a real conversation with the live agent](demo/discipline-agent-demo.gif)

## Why this exists

In 2021 I turned $100 into $470, then revenge-traded 6x UNI longs until
liquidation. The pattern that killed the account — loss, bigger position,
loss, even bigger position — is detectable on-chain. This agent encodes those
failure patterns (tilt, loss-chasing, FOMO, post-liquidation revenge, the
"I have backup" false-safety of large accounts) as detection rules and holds
traders to the plan **they** wrote. No signals, no alpha. An agent that gives
you signals is just another thing to blame.

## How it works

```
Base chain → watcher (60s poll) → TradeEvent → heuristics (10 rules, 4h rate limit)
           → Signal → Claude Haiku (wording only) → XMTP DM
```

Heuristics decide WHEN to message. The LLM only decides the WORDING. Max one
scheduled message per day (evening check-in); everything else is behavior-triggered.

## Run locally (XMTP dev network)

Requires Node >= 22.5 (built-in `node:sqlite`).

```bash
npm install
npm run gen:keys        # paste output into .env (never commit)
cp .env.example .env    # fill in ANTHROPIC_API_KEY etc., keep XMTP_ENV=dev
npm start
```

The boot log prints the agent's address. Open https://xmtp.chat (dev network),
DM that address, and send:

```
watch 0xYourWalletAddress
set trades 5
set size 500
```

Then trade normally on Base — the agent flags plan violations. Useful commands:
`rules`, `status`, `score`, `stop`, `resume`.

## Deploy (Docker)

```bash
docker build -t discipline-agent .
docker run -d --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  --name agent discipline-agent
```

The `/app/data` volume holds everything stateful: the agent's SQLite DB (users,
rules, trades, scores) AND the XMTP identity DB (`xmtp-*.db3`). Keep it: losing
the agent DB means users re-onboard; losing the XMTP DB burns one of the inbox's
~10 lifetime "installations" per restart — run out and the agent is bricked.

Any always-on box works the same way without Docker: `npm ci && npm start`
under systemd/pm2, with `./data` on persistent disk.

## Going live on Base App

1. Set `XMTP_ENV=production` (Base App only sees the production network).
2. Set a real `BASE_RPC_URL` (Alchemy/CDP free tier) — the public RPC rate-limits.
3. `DAILY_CHECKIN_HOUR` is server-local; set the server TZ to your users' TZ
   (per-user TZ is a known gap).
4. Share the agent address. Onboarding is just DMing it.

## Validation gate (the current task)

20 test users, 2 weeks. If 10+ don't mute the agent (`stop` command), keep
investing. Check progress anytime:

```bash
npm run report
```

Prints onboarded/active/muted counts, per-user discipline scores, liquidations,
and which signals actually fired.

## Tests

```bash
npm run typecheck && npm test   # 31 tests: heuristics, score model, SQLite round-trip
```

## Status & roadmap

- ✅ Live on XMTP production (Base App), validating with first test users
- ✅ 10 behavior heuristics · Discipline Score (0-100) · liquidation post-mortems
- 🔜 Hard Mode: an onchain commitment contract — lock your own rules, breaking
  them requires a 24h timelock
- 🔜 Squad mode: shared adherence in group chats

## License

MIT — see [LICENSE](LICENSE). Built by [Saurabh Tiwari](https://github.com/Saurabhtiwari531).
