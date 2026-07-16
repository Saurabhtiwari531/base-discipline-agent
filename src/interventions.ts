/**
 * Interventions layer — decides the WORDING only.
 *
 * The heuristics layer already decided a message is warranted; this module turns
 * a Signal into human words via Claude (Haiku 4.5), with a static fallback if the
 * API is unavailable. It must NEVER produce a trade recommendation.
 *
 * Every Anthropic call is wrapped in try/catch: a wording failure must never
 * crash the watcher loop — we fall back to a static line instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DisciplineScore } from "./score.js";
import type { Signal, SignalType, TradeEvent, UserRules, UserState } from "./types.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

/**
 * The persona. A mentor who blew up a leveraged account and survived. Calm,
 * direct, supportive but firm. Never a signal provider — refusing is the brand.
 */
const PERSONA = `You are a trading discipline coach inside a chat app. You are NOT a signal
provider and you NEVER tell anyone what to buy, sell, long, or short — refusing to do that is
the entire point of who you are. You are a mentor who once blew up a leveraged account through
revenge trading and survived; you speak from that, without retelling the story each time.

You deeply understand the psychology of large portfolios: having $50k, $100k, or $200k creates
a false sense of safety. Each loss feels survivable. "I still have backup" becomes the thought
that justifies every oversized trade — until the backup is gone. You have watched people go from
$200k to zero this way, one comfortable-feeling trade at a time. When money is flowing in, risk
feels easy; when it stops, reality arrives. You name this pattern directly, without drama.

Voice: professional, calm, direct, supportive but firm. No hype. No preachiness. No emojis.
No exclamation marks. Do not moralize or lecture.

Hard constraints on every message you write:
- 1 to 3 sentences. Short.
- Reference the user's OWN stated plan/rule, not generic trading wisdom.
- End with exactly ONE concrete action the user can take right now.
- Never predict price. Never imply an asset will go up or down.`;

/** Static fallbacks used if the Anthropic API is unavailable. */
const FALLBACKS: Record<SignalType, string> = {
  frequency_spike:
    "You're trading faster than usual right now — that pace is usually emotion, not edge. Step away from the screen for 15 minutes before the next entry.",
  size_escalation:
    "Your position size jumped right after a loss. That's the loss-chasing pattern your plan exists to stop. Size the next trade back to your normal unit, or skip it.",
  late_night:
    "It's inside the no-trade hours you set for yourself. Decisions made now tend to cost you tomorrow. Close the app and revisit this in the morning.",
  new_token_churn:
    "You're rotating through a lot of different tokens quickly, which is usually FOMO rather than a plan. Pick one thesis and write it down before the next buy.",
  drawdown_velocity:
    "Your portfolio is dropping fast and that's exactly when panic trades happen. Don't add a new position right now — take a 30-minute break first.",
  rule_break_max_trades:
    "You've hit the daily trade limit you set for yourself. The limit is the plan working, not the plan failing. Stop trading for today.",
  rule_break_position_size:
    "This position is bigger than the max size you committed to. Oversizing is how accounts get liquidated. Trim it back to your own limit now.",
  leverage_escalation:
    "Your leverage just climbed after a losing close — that's revenge trading dressed up as conviction. Drop back to your baseline leverage or stay flat.",
  post_liquidation_reentry:
    "You opened a new position minutes after a liquidation. This is the exact pattern that turns one bad day into a blown account. Stop now and take a 24-hour cooldown.",
  large_position_pct:
    "That position is a large slice of your total portfolio — not a large slice of your 'extra' money. The account that feels like a buffer today is the account that's gone tomorrow if this keeps up. Cut your position size to under 10% of total portfolio before the next entry.",
};

let client: Anthropic | null | undefined;

/** Lazily construct the Anthropic client; returns null if no API key is set. */
function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  client = apiKey ? new Anthropic({ apiKey }) : null;
  return client;
}

function extractText(message: Anthropic.Message): string | null {
  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : null;
}

/** Run a prompt through the persona, returning trimmed text or null on any failure. */
async function complete(userPrompt: string): Promise<string | null> {
  const anthropic = getClient();
  if (!anthropic) return null;
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: PERSONA,
      messages: [{ role: "user", content: userPrompt }],
    });
    return extractText(message);
  } catch {
    // Wording failures must be silent and non-fatal; caller uses the fallback.
    return null;
  }
}

function describeRules(rules: UserRules): string {
  const parts = [`max ${rules.maxTradesPerDay} trades/day`];
  if (rules.maxPositionSizeUsd > 0) parts.push(`max $${rules.maxPositionSizeUsd}/position`);
  parts.push(`no trading ${rules.noTradeStartHour}:00-${rules.noTradeEndHour}:00`);
  if (rules.notes) parts.push(`notes: ${rules.notes}`);
  return parts.join("; ");
}

/** Turn a fired Signal into a 1-3 sentence intervention message. */
export async function generateIntervention(
  signal: Signal,
  rules: UserRules,
): Promise<string> {
  const prompt = `The trader just triggered a discipline signal: "${signal.type}" (severity ${signal.severity}).
Observed fact: ${signal.summary}
Their own plan: ${describeRules(rules)}

Write the intervention message now, following all your hard constraints.`;
  const text = await complete(prompt);
  return text ?? FALLBACKS[signal.type];
}

/**
 * The single allowed scheduled message: an evening check-in. Factual recap of the
 * day plus one reflective prompt — never a market take.
 */
export async function generateDailyCheckIn(
  state: UserState,
  score?: DisciplineScore,
): Promise<string> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todays = state.trades.filter((t) => t.timestamp >= start.getTime());
  const scoreFact = score ? ` Their ${score.windowDays}-day discipline score is ${score.score}/100.` : "";
  const prompt = `Write today's evening check-in for the trader.
Facts: ${todays.length} trades today; their limit is ${state.rules.maxTradesPerDay}/day.${scoreFact}
Keep it to 1-3 sentences, acknowledge how the day went against their own plan, and end with one
reflective question or concrete action for tomorrow. No market commentary.`;
  const text = await complete(prompt);
  if (text) return text;
  const within = todays.length <= state.rules.maxTradesPerDay;
  return within
    ? `You stayed within your plan today — ${todays.length} of ${state.rules.maxTradesPerDay} trades used. Note one thing that helped you hold the line, so you can repeat it tomorrow.`
    : `You went over your trade limit today (${todays.length} vs ${state.rules.maxTradesPerDay}). No judgment — just notice what set it off. Write down the trigger before you trade tomorrow.`;
}

/** Response to any "should I buy/sell/long X?" message: refuse + redirect. */
export async function generateRefusal(userMessage: string): Promise<string> {
  const prompt = `The trader asked you for a trade signal or prediction: "${userMessage}"
You must refuse to give any buy/sell/long/short call or price prediction, briefly explain that
giving signals is not what you do, and redirect them to their own plan. 1-3 sentences. End with
one concrete action that points back to their plan.`;
  const text = await complete(prompt);
  return (
    text ??
    "I don't give buy, sell, or price calls — that's the one thing I'll never do, because it's what got both of us in trouble before. What does your own plan say about a setup like this? Re-read your rules and let those decide, not me."
  );
}

/**
 * Liquidation post-mortem — a structured debrief sent once when a liquidation is
 * detected. This is the one place we deliberately go past the 1-3 sentence limit:
 * what happened, where it broke from the plan, and a concrete cooldown.
 */
export async function generateLiquidationPostMortem(
  state: UserState,
  liquidation: TradeEvent,
): Promise<string> {
  const lev = liquidation.leverage ? `${liquidation.leverage}x` : "leveraged";
  const facts = [
    `A ${lev} position was just liquidated (pair ${liquidation.pairIndex ?? "?"}).`,
    typeof liquidation.realizedPnlUsd === "number"
      ? `Realized loss: ~$${Math.abs(Math.round(liquidation.realizedPnlUsd))}.`
      : "Collateral was lost.",
    `Their plan: max ${state.rules.maxTradesPerDay} trades/day, no trading ${state.rules.noTradeStartHour}:00-${state.rules.noTradeEndHour}:00.`,
  ].join(" ");

  const prompt = `Write a brief liquidation post-mortem (a debrief, not a lecture). Facts: ${facts}
Structure it as 3 short parts:
1) What happened — one factual sentence.
2) Where it deviated from their plan — one sentence (be specific to their rules).
3) A concrete cooldown — tell them to stop trading for a set period (suggest 24 hours).
Calm and direct. No blame, no market commentary, no predictions. Do NOT tell them what to trade next.`;
  const text = await complete(prompt);
  if (text) return text;
  return [
    `That position was liquidated — ${lev}, and the collateral is gone.`,
    "This is the moment your plan was built for. The instinct now is to make it back fast; that instinct is exactly what turns one liquidation into an empty account.",
    "Stop trading for 24 hours. No new positions today. Re-read your rules tomorrow before you do anything.",
  ].join("\n\n");
}
