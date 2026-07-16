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

type TimelineMsg = { typeStart: number; text?: string; chars: number; sentAt: number; replyAt: number; replyLines: number };
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

// --- instruments (v2: per-key pitch variance, spacebar thud, two-note ding) ---

/** One keypress: noise transient + pitched body + tiny 4kHz tick. */
function makeClick(isSpace: boolean): (t: number) => number {
  const body = isSpace ? 85 + Math.random() * 20 : 150 + Math.random() * 65;
  const tick = 3400 + Math.random() * 900;
  const bodyGain = isSpace ? 0.62 : 0.42;
  return (t) =>
    (Math.random() * 2 - 1) * Math.exp(-t * (isSpace ? 700 : 1150)) * 0.42 +
    Math.sin(2 * Math.PI * body * t) * Math.exp(-t * (isSpace ? 170 : 300)) * bodyGain +
    Math.sin(2 * Math.PI * tick * t) * Math.exp(-t * 2200) * 0.1;
}

/** iMessage-style send: tiny air whoosh rising into a soft down-sweep pop. */
const sendWhoosh = (t: number) =>
  (Math.random() * 2 - 1) * Math.min(t / 0.07, 1) * Math.exp(-t * 26) * 0.3;
const sendPop = (t: number) => {
  const f = Math.max(340, 820 - 2200 * t);
  return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 30);
};

/** Reply lands: warm two-note "du-ding" (D5 then A5), soft attack. */
const replyDing = (t: number) => {
  const attack = 1 - Math.exp(-t * 350);
  const n1 = Math.sin(2 * Math.PI * 587.3 * t) * Math.exp(-t * 14) * 0.55;
  const t2 = t - 0.085;
  const n2 = t2 > 0 ? Math.sin(2 * Math.PI * 880 * t2) * Math.exp(-t2 * 8) * 0.6 : 0;
  return (n1 + n2) * attack;
};

/** Banner: one soft low welcome tone. */
const bannerTone = (t: number) =>
  Math.sin(2 * Math.PI * 220 * t) * (1 - Math.exp(-t * 90)) * Math.exp(-t * 5) * 0.5 +
  Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 7) * 0.15;

const riser = (t: number, dur: number) => {
  const p = t / dur;
  return (
    (Math.random() * 2 - 1) * p * p * 0.42 +
    Math.sin(2 * Math.PI * (220 + 1100 * p) * t) * p * p * 0.22
  );
};

/** End hit: soft-attack deep thump + long airy shimmer tail. */
const thump = (t: number) =>
  Math.sin(2 * Math.PI * 52 * t) * (1 - Math.exp(-t * 240)) * Math.exp(-t * 7);
const shimmer = (t: number) =>
  (Math.sin(2 * Math.PI * 1174.7 * t) * 0.5 +
    Math.sin(2 * Math.PI * 1568 * t) * 0.35 +
    Math.sin(2 * Math.PI * 2349.3 * t) * 0.25) *
  (1 - Math.exp(-t * 60)) * Math.exp(-t * 1.6) * 0.14;

// --- place events ---
add(toVideoS(tl.bannerAt), bannerTone, 0.9, 0.7);

for (const m of tl.msgs) {
  // typing clicks: one per char at the real typing cadence, humanized
  for (let c = 0; c < m.chars; c++) {
    if (Math.random() < 0.18) continue; // drop some — human fingers overlap
    const isSpace = (m.text?.[c] ?? "") === " ";
    const jitter = (Math.random() - 0.5) * 0.012;
    const at = toVideoS(m.typeStart + c * TYPE_MS) + jitter;
    add(at, makeClick(isSpace), 0.07, (isSpace ? 0.7 : 0.45) + Math.random() * 0.45);
  }
  add(toVideoS(m.sentAt) + 0.02, sendWhoosh, 0.12, 1);
  add(toVideoS(m.sentAt) + 0.06, sendPop, 0.16, 0.8);
  add(toVideoS(m.replyAt), replyDing, 0.7, 0.85);
}

// end card: screen clears ~2s after the outro prints (see demo.tape: sleep 2)
const clearAt = toVideoS(tl.outroAt) + 2.0;
const RISE = 1.5;
add(clearAt - RISE, (t) => riser(t, RISE), RISE, 0.5);
add(clearAt, thump, 1.2, 0.95);
add(clearAt + 0.05, shimmer, 3.5, 1);

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
