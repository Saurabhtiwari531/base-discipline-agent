# VHS tape — records scripts/demo-chat.ts against a live dev agent.
# Prereq: demo agent running (XMTP_ENV=dev DB_PATH=/tmp/demo-agent.db npx tsx src/index.ts)
# Render: vhs demo/demo.tape   (from the project root)

Output demo/discipline-agent-demo.mp4
Output demo/discipline-agent-demo.gif

Set FontSize 15
Set Width 920
Set Height 720
Set Padding 20
Set Framerate 24
Set Shell zsh

Hide
Type `export NODE_OPTIONS=--no-warnings DEMO_TIMELINE=/tmp/demo-timeline.json AGENT_ADDRESS=0xba49cf88c69b05c6f89dabeb787f505e192c0180; clear; npx tsx scripts/demo-chat.ts; sleep 2; clear; printf '\n\n   \033[1m● Base Discipline Agent\033[0m\n\n   Your plan. Your rules. Enforced on-chain.\n\n   DM the agent on Base App:\n   \033[1m0xba49cf88c69b05c6f89dabeb787f505e192c0180\033[0m\n\n\n   \033[2mBuilt by Saurabh\033[0m\n\n'`
Enter
Show

Wait+Screen@150s /Enforced on-chain/
Sleep 5s
