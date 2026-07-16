/**
 * Validation gate report — the 2-week readout, straight from SQLite.
 *
 *   npm run report            (or: npx tsx scripts/validation-report.ts)
 *
 * The gate (see CLAUDE.md): 20 test users for 2 weeks. If 10+ don't mute the
 * agent, invest further. "Muted" == the user ran `stop` (users.paused = 1).
 * Read-only: this script never writes to the DB.
 */
import "dotenv/config";
import { loadAllUsers, openDb } from "../src/db.js";
import { computeDisciplineScore, scoreLabel } from "../src/score.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function shortWallet(w: string): string {
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

function daysAgo(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const d = Math.floor((now - ts) / DAY_MS);
  return d === 0 ? "today" : `${d}d ago`;
}

function main(): void {
  const db = openDb(process.env.DB_PATH ?? "./data/agent.db");
  const users = loadAllUsers(db);
  const now = Date.now();

  if (users.length === 0) {
    console.log("No users onboarded yet. Share the agent address and get the first tester in.");
    return;
  }

  const muted = users.filter((u) => u.paused);
  const active = users.filter((u) => !u.paused);

  console.log("=== Validation gate ===");
  console.log(`Onboarded: ${users.length} (target 20)`);
  console.log(`Active:    ${active.length}`);
  console.log(`Muted:     ${muted.length} (gate: pass if 10+ of 20 stay unmuted)`);
  console.log("");

  console.log("=== Users ===");
  for (const u of users) {
    const s = computeDisciplineScore(u, now);
    const lastTrade = u.trades[u.trades.length - 1]?.timestamp;
    const liqs = u.trades.filter((t) => t.isLiquidation).length;
    const signalsFired = Object.keys(u.lastSignalAt).length;
    console.log(
      [
        shortWallet(u.wallet).padEnd(14),
        (u.paused ? "MUTED" : "active").padEnd(7),
        `score ${String(s.score).padStart(3)}/100 (${scoreLabel(s.score)})`.padEnd(32),
        `trades ${String(u.trades.length).padStart(3)}`,
        `liqs ${liqs}`,
        `signal types fired ${signalsFired}`,
        `last trade ${daysAgo(lastTrade, now)}`,
        `onboarded ${daysAgo(u.onboardedAt, now)}`,
      ].join("  "),
    );
  }

  console.log("");
  console.log("=== Signals seen (per user, last fired) ===");
  for (const u of users) {
    const entries = Object.entries(u.lastSignalAt);
    if (entries.length === 0) continue;
    const parts = entries
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([type, ts]) => `${type} (${daysAgo(ts, now)})`);
    console.log(`${shortWallet(u.wallet)}: ${parts.join(", ")}`);
  }
}

main();
