/**
 * Core domain types for the Base Discipline Agent.
 *
 * Design rule: heuristics decide WHEN to intervene (they emit Signals); the LLM
 * only decides the WORDING of the message. Keep these types free of any
 * presentation/LLM concerns.
 */

/**
 * The trader's own plan, written during onboarding and edited via chat commands.
 * The agent enforces THIS, not a generic ruleset.
 */
export interface UserRules {
  /** "set trades N" — max number of trades the user allows themselves per day. */
  maxTradesPerDay: number;
  /** "set size P" — max single-position size in USD the user allows themselves. */
  maxPositionSizeUsd: number;
  /** No-trade window start hour (0-23, local). Used by the late_night rule. */
  noTradeStartHour: number;
  /** No-trade window end hour (0-23, local). Window may wrap past midnight. */
  noTradeEndHour: number;
  /** Free-form notes the user wrote about their own plan during onboarding. */
  notes?: string;
}

export const DEFAULT_RULES: UserRules = {
  maxTradesPerDay: 5,
  maxPositionSizeUsd: 0, // 0 = unset; size rules stay dormant until the user sets it
  noTradeStartHour: 0, // midnight
  noTradeEndHour: 5, // 5am — classic tilt/revenge window
};

/** A single observed swap/trade. Perp fields are populated by src/perps/avantis.ts. */
export interface TradeEvent {
  txHash: string;
  /** Unix milliseconds. */
  timestamp: number;
  wallet: string;
  /** DEX router (or perp contract) the tx interacted with. */
  router: string;
  routerName: string;
  /** Token addresses where decodable; symbols are best-effort. */
  tokenIn?: string;
  tokenOut?: string;
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  direction?: "buy" | "sell";
  /**
   * USD notional of the trade. STUB: currently 0 for spot trades until an
   * indexer / swap-log decoding lands. Size-based heuristics stay dormant
   * while this is 0. See CLAUDE.md "Known stubs / gaps".
   */
  usdValue: number;
  // --- perps extension (CURRENT TASK: Avantis) ---
  /** Leverage multiple for perp positions (e.g. 3, 10). Undefined for spot. */
  leverage?: number;
  /** True when this event came from a perps DEX (Avantis), not a spot DEX. */
  isPerp?: boolean;
  /** Whether this perp event opened or closed a position. */
  perpAction?: "open" | "close";
  /** Avantis pair index (market id), for grouping a position's open/close. */
  pairIndex?: number;
  /** Collateral posted, in USD (USDC, 6dp). Best-effort; see avantis.ts notes. */
  collateralUsd?: number;
  /** Realized PnL in USD on a close. Only set when a callbacks event is decoded. */
  realizedPnlUsd?: number;
  /** True if this close was a forced liquidation (not a user-initiated close). */
  isLiquidation?: boolean;
}

/** A point-in-time portfolio reading. ETH-only for now (see roadmap). */
export interface PortfolioSnapshot {
  timestamp: number;
  /** Native ETH balance, in ether (not wei). */
  ethBalance: number;
  /** USD value of the snapshot using fetchEthUsd() (currently a stub). */
  usdValue: number;
}

/** All per-user state. In-memory for now; SQLite is on the roadmap. */
export interface UserState {
  /** The watched on-chain wallet (lowercased 0x address). */
  wallet: string;
  /** XMTP conversation/inbox id we reply to. */
  inboxId: string;
  /** XMTP conversation id, for sending unprompted interventions. */
  conversationId: string;
  rules: UserRules;
  /** Rolling list of recent trades (most recent last). */
  trades: TradeEvent[];
  /** Rolling list of recent portfolio snapshots. */
  snapshots: PortfolioSnapshot[];
  /** signalType -> last fired timestamp (ms). Powers the 4h rate limit. */
  lastSignalAt: Partial<Record<SignalType, number>>;
  /** Timestamp (ms) of the last daily check-in, to enforce max 1/day. */
  lastDailyCheckInAt?: number;
  /** Highest Base block we've already scanned for spot trades. */
  lastBlockScanned?: bigint;
  /** Highest Base block we've already scanned for Avantis perp events. */
  lastPerpBlockScanned?: bigint;
  /** When true, the user ran "stop" — suppress all proactive messages. */
  paused: boolean;
  onboardedAt: number;
}

export type SignalType =
  | "frequency_spike"
  | "size_escalation"
  | "late_night"
  | "new_token_churn"
  | "drawdown_velocity"
  | "rule_break_max_trades"
  | "rule_break_position_size"
  // --- perps (CURRENT TASK) ---
  | "leverage_escalation"
  | "post_liquidation_reentry";

export type Severity = "low" | "medium" | "high";

/**
 * A behavior-triggered reason to (maybe) intervene. The heuristics layer emits
 * these; index.ts turns them into messages via the interventions layer.
 *
 * `summary` is plain factual context handed to the LLM for wording. It must
 * never contain a trade recommendation.
 */
export interface Signal {
  type: SignalType;
  severity: Severity;
  wallet: string;
  detectedAt: number;
  /** Factual, non-advisory description of what was observed. */
  summary: string;
  /** Structured detail for templating / post-mortems. */
  data?: Record<string, unknown>;
}
