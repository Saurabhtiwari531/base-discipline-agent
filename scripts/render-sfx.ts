/**
 * Renders the demo's sound-effects track from the timeline JSON that
 * scripts/demo-chat.ts writes during a recorded run.
 *
 *   npx tsx scripts/render-sfx.ts <timeline.json> <banner-video-ts-seconds> <out.wav>
 *
 * Sounds (all synthesized — nothing to license):
 *  - keyboard clicks while the user text types (thocky: noise transient + low body)
 *  - "sent" swoosh-pop when a user message completes
 *  - warm lower-pitched pop-ding when an Agent reply lands
 *  - riser + deep thump + shimmer at the end card
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , timelinePath, bannerVideoTsArg, outPath] = process.argv;
if (!timelinePath || !bannerVideoTsArg || !outPath) {
  console.error("usage: render-sfx.ts <timeline.json> <bannerVideoTs> <out.wav>");
  process.exit(1);
}

type TimelineMsg = { typeStart: number; chars: number; sentAt: number; replyAt: number; replyLines: number };
type Timeline = { bannerAt: number; msgs: TimelineMsg[]; outroAt: number };
const tl: Timeline = JSON.parse(readFileSync(timelinePath, "utf8"));

const SR = 44100;
const TYPE_MS = 28; // must match typeOut() in demo-chat.ts
/** script-ms -> video-seconds. Calibrated on the banner frame. */
const offsetS = parseFloat(bannerVideoTsArg) - tl.bannerAt / 1000;
const toVideoS = (scriptMs: number) => scriptMs / 1000 + offsetS;

const DURATION = toVideoS(tl.outroAt) + 9; // room for end card tail
const buf = new Float64Array(Math.ceil(DURATION * SR));

function add(atS: number, gen: (t: number) => number, durS: number, gain = 1): void {
  const start = Math.floor(atS * SR);
  const n = Math.floor(durS * SR);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;
    buf[idx] += gen(i / SR) * gain;
  }
}

// --- instruments ---
const click = (t: number) =>
  (Math.random() * 2 - 1) * Math.exp(-t * 900) * 0.55 +
  Math.sin(2 * Math.PI * 175 * t) * Math.exp(-t * 260) * 0.5;

const sendPop = (t: number) => {
  const f = 880 - 2600 * t; // quick downward sweep
  return Math.sin(2 * Math.PI * (f > 320 ? f : 320) * t) * Math.exp(-t * 34);
};

const replyDing = (t: number) =>
  (Math.sin(2 * Math.PI * 523 * t) * 0.6 + Math.sin(2 * Math.PI * 784 * t) * 0.4) *
  Math.exp(-t * 11);

const riser = (t: number, dur: number) => {
  const p = t / dur;
  return (Math.random() * 2 - 1) * p * p * 0.5 + Math.sin(2 * Math.PI * (250 + 900 * p) * t) * p * 0.25;
};

const thump = (t: number) => Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 8);
const shimmer = (t: number) =>
  (Math.sin(2 * Math.PI * 1568 * t) + Math.sin(2 * Math.PI * 2093 * t) * 0.6) *
  Math.exp(-t * 3) * 0.12;

// --- place events ---
for (const m of tl.msgs) {
  // typing clicks: one per char at the real typing cadence, humanized
  for (let c = 0; c < m.chars; c++) {
    if (Math.random() < 0.22) continue; // drop some — human fingers overlap
    const jitter = (Math.random() - 0.5) * 0.012;
    const at = toVideoS(m.typeStart + c * TYPE_MS) + jitter;
    add(at, click, 0.06, 0.5 + Math.random() * 0.5);
  }
  add(toVideoS(m.sentAt) + 0.05, sendPop, 0.14, 0.85);
  add(toVideoS(m.replyAt), replyDing, 0.45, 0.8);
}

// end card: screen clears ~2s after the outro prints (see demo.tape: sleep 2)
const clearAt = toVideoS(tl.outroAt) + 2.0;
const RISE = 1.4;
add(clearAt - RISE, (t) => riser(t, RISE), RISE, 0.5);
add(clearAt, thump, 1.0, 0.95);
add(clearAt + 0.03, shimmer, 2.5, 1);

// --- master: soft clip + normalize to -3 dBFS ---
let peak = 0;
for (const v of buf) peak = Math.max(peak, Math.abs(v));
const norm = peak > 0 ? 0.7 / peak : 1;
const pcm = new Int16Array(buf.length);
for (let i = 0; i < buf.length; i++) {
  const soft = Math.tanh(buf[i]! * norm * 1.2);
  pcm[i] = Math.max(-32768, Math.min(32767, Math.round(soft * 32767 * 0.9)));
}

// --- minimal WAV writer (PCM16 mono) ---
const dataBytes = pcm.length * 2;
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(dataBytes, 40);
writeFileSync(outPath, Buffer.concat([header, Buffer.from(pcm.buffer)]));
console.log(
  `wrote ${outPath}: ${DURATION.toFixed(1)}s, ${tl.msgs.length} messages, offset ${offsetS.toFixed(2)}s`,
);
