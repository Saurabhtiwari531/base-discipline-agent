# Base Discipline Agent

An AI trading-discipline agent for Base App. It watches a trader's on-chain wallet
(spot DEXes + Avantis perps) and messages them on XMTP when they break **their own**
trading plan. It never gives buy/sell calls — refusing to is the brand.

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
npm run typecheck && npm test   # 21 tests: heuristics + score model
```
