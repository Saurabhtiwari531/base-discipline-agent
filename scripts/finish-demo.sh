#!/usr/bin/env bash
# Post-processes a fresh VHS demo recording into the final MP4 + GIF:
#   1. finds the banner frame (first visible change) in the raw recording
#   2. trims the startup blank so the banner lands at ~0.6s
#   3. renders frame-synced SFX from the run's timeline JSON
#   4. muxes SFX (+ optional music file as $1) and regenerates the GIF
#
# Full pipeline:
#   XMTP_ENV=dev DB_PATH=/tmp/demo-agent.db npx tsx src/index.ts   # terminal 1
#   vhs demo/demo.tape                                             # terminal 2
#   bash scripts/finish-demo.sh [music.mp3]
set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO=demo/discipline-agent-demo.mp4
TIMELINE=/tmp/demo-timeline.json
MUSIC="${1:-}"

[ -f "$TIMELINE" ] || { echo "missing $TIMELINE — record with vhs demo/demo.tape first"; exit 1; }

echo "→ locating banner frame…"
ffmpeg -v error -i "$VIDEO" -vf "select='gte(scene,0)',metadata=print:file=/tmp/scene-fd.txt" -f null -
BANNER=$(node -e '
const txt=require("fs").readFileSync("/tmp/scene-fd.txt","utf8");
const re=/pts_time:([\d.]+)\nlavfi\.scene_score=([\d.]+)/g;let m;
while((m=re.exec(txt))){const t=parseFloat(m[1]),s=parseFloat(m[2]);
if(t<60&&s>0.004){console.log(t);process.exit(0)}}
process.exit(1)')
TRIM=$(node -e "console.log(Math.max(0, $BANNER - 0.6).toFixed(2))")
echo "  banner @ ${BANNER}s → trimming ${TRIM}s"

ffmpeg -v error -y -ss "$TRIM" -i "$VIDEO" -c:v libx264 -crf 18 -preset fast -an /tmp/demo-trimmed.mp4

echo "→ rendering SFX…"
npx tsx scripts/render-sfx.ts "$TIMELINE" 0.6 /tmp/sfx.wav

echo "→ muxing…"
if [ -n "$MUSIC" ] && [ -f "$MUSIC" ]; then
  # music bed: looped to length, low under the SFX, faded out at the end
  ffmpeg -v error -y -i /tmp/demo-trimmed.mp4 -stream_loop -1 -i "$MUSIC" -i /tmp/sfx.wav \
    -filter_complex "[1:a]volume=0.22,afade=t=in:d=2[m];[2:a][m]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=29:d=3.5[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k -shortest "$VIDEO"
else
  ffmpeg -v error -y -i /tmp/demo-trimmed.mp4 -i /tmp/sfx.wav \
    -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest "$VIDEO"
fi

echo "→ regenerating GIF…"
ffmpeg -v error -y -i "$VIDEO" \
  -vf "fps=12,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  demo/discipline-agent-demo.gif

ls -la demo/ | grep -E "mp4|gif"
echo "✓ done"
