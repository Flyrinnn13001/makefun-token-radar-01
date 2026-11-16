// The radar's model: what a protocol's token would be worth if it launched
// today and the market priced it the way it already prices its tokenised
// peers, adjusted for the protocol's own momentum and track record.
//
//   implied = TVL x category multiple x momentum x maturity
//
// - category multiple: the median market-cap / TVL ratio of the protocols in
//   the same DefiLlama category whose token already trades, computed from
//   this snapshot alone. Categories with too few traded peers fall back to
//   the all-market median. The multiple is clamped so one wild category
//   cannot dominate the board.
// - momentum: the protocol's 7-day TVL change, clamped to +/-30%, weighted
//   at 0.6 - a protocol growing into its launch is worth more than one
//   bleeding TVL, but one week never doubles a valuation.
// - maturity: how long DefiLlama has tracked the protocol with no token.
//   A longer record earns a premium of up to +8%; a brand-new listing is
//   discounted to 0.92. Unknown listing dates sit in the middle.
//
// The board ranks every watchlist protocol plus the strongest pre-token
// protocols below the watchlist floor that are genuine candidates (not a
// versioned pool, not a wrapped or staked product of a token that trades).

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Scored {
  protocol: Protocol;
  implied: number;
  multiple: number;
  multipleSource: string;
  momentum: number;
  maturity: number;
  ageDays: number | null;
  watchlist: boolean;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

const DAY_MS = 86_400_000;
export const BOARD_SIZE = 220;
const MULTIPLE_MIN = 0.1;
const MULTIPLE_MAX = 8;
const MIN_CATEGORY_SAMPLES = 3;

/** Parse and lightly validate the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot is missing its protocols or watchlist arrays');
  }
  return raw;
}

/** Whole days between the listing day and the snapshot day; null if unknown. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The market-cap / TVL multiples the snapshot itself implies: one median per
 * category with enough traded members, plus the all-market median.
 */
export function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const global = clamp(median(all), MULTIPLE_MIN, MULTIPLE_MAX);
  const byCategory = new Map<string, number>();
  for (const [category, ratios] of ratiosByCategory) {
    if (ratios.length >= MIN_CATEGORY_SAMPLES) {
      byCategory.set(category, clamp(median(ratios), MULTIPLE_MIN, MULTIPLE_MAX));
    }
  }
  return { byCategory, global };
}

/** Records no token in the snapshot (DefiLlama may lag; the board says "records none", never "has none"). */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
const DERIVATIVE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A genuine launch candidate below the floor: pre-token and not a derivative product of a traded token. */
export function isCandidate(p: Protocol): boolean {
  return (
    recordsNoToken(p) &&
    !VERSIONED_NAME.test(p.name) &&
    !WRAPPED_OR_STAKED.test(p.name) &&
    !(p.category !== null && DERIVATIVE_CATEGORIES.has(p.category))
  );
}

/** Score one protocol under the model. Pure and deterministic. */
export function score(p: Protocol, snapshot: Snapshot, multiples: { byCategory: Map<string, number>; global: number }, watchlist: Set<string>): Scored {
  const category = p.category ?? '(uncategorised)';
  const fromCategory = multiples.byCategory.get(category);
  const multiple = fromCategory ?? multiples.global;
  const change = clamp(p.change_7d ?? 0, -30, 30);
  const momentum = 1 + (change / 100) * 0.6;
  const ageDays = ageInDays(snapshot.as_of, p.listed_at);
  const ageForModel = ageDays ?? 365;
  const maturity = 0.92 + 0.16 * (Math.min(ageForModel, 1460) / 1460);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity));
  return {
    protocol: p,
    implied,
    multiple,
    multipleSource: fromCategory !== undefined ? `median of ${category}` : 'all-market median',
    momentum,
    maturity,
    ageDays,
    watchlist: watchlist.has(p.slug),
  };
}

// ---------------------------------------------------------------------------
// Farm plans. Concrete steps per category: what to do, on which chain, what
// it costs and how long it takes. Numbers are working-capital and gas ranges
// a small farmer can actually budget with.
// ---------------------------------------------------------------------------

/** Rough per-transaction gas budget by chain, in USD, as a readable range. */
function gasRange(chain: string): string {
  if (chain === 'Ethereum') return '$8-25';
  if (chain === 'Solana') return 'under $0.05';
  if (chain === 'Bitcoin' || chain === 'Bitcoin Cash') return '$1-5';
  if (chain === 'BSC' || chain === 'Polygon' || chain === 'Avalanche') return '$0.10-0.60';
  return '$0.05-0.50';
}

/** The core on-chain action for a category: the activity a points program would count. */
function coreAction(category: string | null): string {
  switch (category) {
    case 'Dexs':
      return 'swap through the main pools and add two-sided liquidity to the highest-volume pair';
    case 'Lending':
      return 'supply a blue-chip collateral asset, borrow 30-40% against it, and recycle the borrow once';
    case 'Derivatives':
      return 'open small hedged perpetual positions (long one venue, short another) and roll them weekly';
    case 'Yield':
    case 'Yield Aggregator':
      return 'deposit into the flagship vault and keep the position through each weekly epoch';
    case 'Bridge':
    case 'Canonical Bridge':
      return 'bridge stablecoins across the busiest corridor in both directions, on different days';
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Restaking':
      return 'stake the base asset through the protocol and hold the receipt token in the same wallet';
    case 'RWA':
      return 'buy a small position in the flagship tokenised asset and hold it through a full distribution cycle';
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return 'allocate to the flagship curated vault and leave the deposit untouched across rebalances';
    case 'Basis Trading':
      return 'fund the basis vault with stablecoins and keep the position through the funding cycle';
    case 'Launchpad':
      return 'take part in one sale per month with a small ticket and hold the allocation to vesting';
    case 'Payments':
      return 'route a real payment through the protocol once a week, in both directions where it allows';
    case 'Gaming':
      return 'play the live game loop for real stakes: buy in, complete the weekly quests, keep the assets in-wallet';
    default:
      return 'use the protocol\u2019s core product the way a real user would: deposit, transact, and stay active weekly';
  }
}

/** Working-capital suggestion scaled to the protocol's size. */
function capitalFor(tvl: number): string {
  if (tvl >= 500_000_000) return '$1,000-2,500';
  if (tvl >= 100_000_000) return '$500-1,500';
  if (tvl >= 25_000_000) return '$250-750';
  return '$100-400';
}

/** Five concrete farm steps for one protocol, each within the gate's length bounds. */
export function farmSteps(p: Protocol): string[] {
  const mainChain = p.chains[0] ?? 'Ethereum';
  const gas = gasRange(mainChain);
  const capital = capitalFor(p.tvl_usd);
  const steps: string[] = [
    `Set up one clean wallet for ${p.name} and fund it on ${mainChain} with ${capital} of working capital plus a gas buffer; at ${gas} per transaction on ${mainChain}, a month of weekly activity costs roughly ${gas === 'under $0.05' ? 'a dollar' : 'tens of dollars'} in fees, so size the buffer before you start.`,
    `Make the core move: on ${mainChain}, ${coreAction(p.category)}. Keep each position small and real - one genuine position held for weeks outweighs twenty wash transactions if a snapshot is ever taken.`,
    `Repeat on a weekly rhythm for at least 8-12 weeks: one or two sessions a week, about 30-45 minutes each, adding a transaction type you have not used yet (a second pool, a second market, a governance vote) so the wallet reads as a user, not a script.`,
  ];
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    steps.push(
      `Extend to ${second}, the protocol's second chain: bridge a small amount over, repeat the core action there once a fortnight, and keep both wallets funded - multi-chain users are the cohort most launch distributions describe when they publish criteria.`,
    );
  } else {
    steps.push(
      `Deepen the single-chain record instead of spreading thin: raise the position toward the top of the ${capital} band over the first month, and interact in at least 6 distinct weeks - consistency across time is the cheapest signal to build and the hardest to fake later.`,
    );
  }
  steps.push(
    `Track the campaign like a job: note every transaction hash, week and fee in a simple log, watch ${p.name}'s official channels for a points or season announcement, and be holding an active position - not a closed one - whenever a season ends or a snapshot is rumoured. Total running cost: the gas above plus the opportunity cost of ${capital} for one season.`,
  );
  return steps;
}

// ---------------------------------------------------------------------------
// Board assembly and the gate mirror.
// ---------------------------------------------------------------------------

export interface Built {
  rows: BoardRow[];
  scored: Scored[];
}

export function buildBoard(snapshot: Snapshot): Built {
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const chosen: Protocol[] = [];
  const seen = new Set<string>();
  for (const p of snapshot.protocols) {
    if (watchlist.has(p.slug)) {
      chosen.push(p);
      seen.add(p.slug);
    }
  }
  const belowFloor = snapshot.protocols
    .filter((p) => !seen.has(p.slug) && isCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  for (const p of belowFloor) {
    if (chosen.length >= BOARD_SIZE) break;
    chosen.push(p);
  }
  const scored = chosen
    .map((p) => score(p, snapshot, multiples, watchlist))
    .sort((a, b) => b.implied - a.implied || b.protocol.tvl_usd - a.protocol.tvl_usd || (a.protocol.slug < b.protocol.slug ? -1 : 1));
  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.protocol.slug,
    name: s.protocol.name,
    rank: i + 1,
    implied_value_usd: s.implied,
    farm_steps: farmSteps(s.protocol),
  }));
  return { rows, scored };
}

/** A gate-shaped self-check: returns the first problem found, or null when the board is valid. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seenSlugs = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  let allEqual = true;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!known.has(row.slug)) return `row ${i + 1} names unknown slug ${row.slug}`;
    if (seenSlugs.has(row.slug)) return `slug ${row.slug} appears twice`;
    seenSlugs.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1} carries rank ${row.rank}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `row ${row.slug} has a bad implied value`;
    if (row.implied_value_usd > previous) return `implied value rises at rank ${row.rank}`;
    if (i > 0 && row.implied_value_usd !== rows[0]!.implied_value_usd) allEqual = false;
    previous = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${Array.isArray(row.farm_steps) ? row.farm_steps.length : 'no'} farm steps`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `a farm step of ${row.slug} is ${trimmed.length} characters`;
    }
  }
  if (rows.length > 1 && allEqual) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seenSlugs.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The dashboard's data file: everything the page renders, from the same rows.
// ---------------------------------------------------------------------------

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  scanned: number;
  pre_token: number;
  model: {
    summary: string;
    global_multiple: number;
    top_multiples: { category: string; multiple: number }[];
  };
  rows: {
    slug: string;
    name: string;
    rank: number;
    category: string | null;
    chains: string[];
    tvl_usd: number;
    change_7d: number | null;
    listed_at: string | null;
    age_days: number | null;
    implied_value_usd: number;
    multiple: number;
    multiple_source: string;
    momentum: number;
    maturity: number;
    watchlist: boolean;
    farm_steps: string[];
  }[];
}

export function buildData(snapshot: Snapshot, built: Built): RadarData {
  const multiples = categoryMultiples(snapshot);
  const rowBySlug = new Map(built.rows.map((r) => [r.slug, r]));
  const topMultiples = [...multiples.byCategory.entries()]
    .map(([category, multiple]) => ({ category, multiple: Math.round(multiple * 100) / 100 }))
    .sort((a, b) => b.multiple - a.multiple)
    .slice(0, 10);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    scanned: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter(recordsNoToken).length,
    model: {
      summary:
        'Implied value = TVL x the median market-cap/TVL multiple of the same category\u2019s traded tokens, adjusted for 7-day TVL momentum (x0.82-1.18) and for how long the protocol has run with no token (x0.92-1.08). Every figure comes from the sealed snapshot; the value is this board\u2019s own claim, not a prediction that a token will launch.',
      global_multiple: Math.round(multiples.global * 100) / 100,
      top_multiples: topMultiples,
    },
    rows: built.scored.map((s) => ({
      slug: s.protocol.slug,
      name: s.protocol.name,
      rank: rowBySlug.get(s.protocol.slug)!.rank,
      category: s.protocol.category,
      chains: s.protocol.chains,
      tvl_usd: s.protocol.tvl_usd,
      change_7d: s.protocol.change_7d,
      listed_at: s.protocol.listed_at,
      age_days: s.ageDays,
      implied_value_usd: s.implied,
      multiple: Math.round(s.multiple * 100) / 100,
      multiple_source: s.multipleSource,
      momentum: Math.round(s.momentum * 1000) / 1000,
      maturity: Math.round(s.maturity * 1000) / 1000,
      watchlist: s.watchlist,
      farm_steps: rowBySlug.get(s.protocol.slug)!.farm_steps,
    })),
  };
}

/** The data file the dashboard loads: one assignment, no imports, no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR_DATA = ${JSON.stringify(data)};\n`;
}
