// Transcript notices for the prompt cache: a miss that re-billed the conversation, a keep-warm
// refresh, and what a compaction cost. Pi prints the same lines itself under
// `showCacheMissNotices`, but that setting also prints "Anthropic dropped N thinking blocks";
// these let it stay off. The miss detection mirrors Pi's own (core/cache-stats.ts), which is not
// exported. Pi-only: the other ports do not share this file.

export const NOTICE_TYPE = "cache-guard-notice";

/** Misses at or below this many tokens are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;
/** A miss is worth a line from this many tokens or this many dollars. */
const MISS_MIN_TOKENS = 20_000;
const MISS_MIN_COST = 0.1;

export type Notice =
  | { kind: "miss"; missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean }
  | { kind: "warm"; cost: number; note?: string }
  | { kind: "compaction"; tokens: number; cost: number };

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface AssistantLike {
  role: string;
  provider: string;
  model: string;
  timestamp: number;
  stopReason?: string;
  usage: Usage;
}

interface Previous {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

/** $/million cache-read price for a model, when its usage reported no reads to derive it from. */
export type CacheReadPrice = (provider: string, model: string) => number | undefined;

const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

/** The last request in `entries` that a new assistant message is compared with. */
function previous(entries: readonly unknown[]): Previous | undefined {
  let prev: Previous | undefined;
  for (const raw of entries) {
    const entry = raw as { type?: string; kind?: string; timestamp?: string; provider?: string; model?: string; usage?: Usage; message?: AssistantLike };
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      // The context changed on purpose: the next prompt is new content, not re-billed content.
      prev = undefined;
    } else if (entry.type === "usage" && entry.kind === "cache_warm" && entry.usage) {
      const tokens = promptTokens(entry.usage);
      if (tokens > 0) {
        prev = { promptTokens: tokens, modelKey: `${entry.provider}/${entry.model}`, timestamp: Date.parse(entry.timestamp ?? ""), reportedCache: true };
      }
    } else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      const u = entry.message.usage;
      const tokens = promptTokens(u);
      if (tokens > 0) {
        prev = {
          promptTokens: tokens,
          modelKey: `${entry.message.provider}/${entry.message.model}`,
          timestamp: entry.message.timestamp,
          reportedCache: (prev?.reportedCache ?? false) || u.cacheRead + u.cacheWrite > 0,
        };
      }
    }
  }
  return prev;
}

/**
 * The cache miss on a just-finished assistant message, compared with the last request in `entries`
 * (which must not contain the message yet), when it is big enough to mention.
 */
export function detectMiss(entries: readonly unknown[], message: AssistantLike, cacheReadPrice: CacheReadPrice): Notice | undefined {
  const prev = previous(entries);
  const u = message.usage;
  const tokens = promptTokens(u);
  // A turn without cache activity only counts when the provider reported caching before.
  if (!prev || tokens <= 0 || (u.cacheRead + u.cacheWrite === 0 && !prev.reportedCache)) return undefined;
  const missedTokens = Math.min(prev.promptTokens, tokens) - u.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
  // Missed tokens land in input or cacheWrite, so this message's own costs give the paid rate.
  const paid = u.input + u.cacheWrite;
  const paidPerToken = paid > 0 ? ((u.cost?.input ?? 0) + (u.cost?.cacheWrite ?? 0)) / paid : 0;
  const readPerToken = u.cacheRead > 0
    ? (u.cost?.cacheRead ?? 0) / u.cacheRead
    : (cacheReadPrice(message.provider, message.model) ?? 0) / 1_000_000;
  // A priced model whose cache read costs as much as input saves nothing by caching.
  if (paidPerToken > 0 && readPerToken >= paidPerToken * 0.99) return undefined; // 1%: float rounding
  const missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
  if (missedTokens < MISS_MIN_TOKENS && missedCost < MISS_MIN_COST) return undefined;
  return {
    kind: "miss",
    missedTokens,
    missedCost,
    idleMs: Math.max(0, message.timestamp - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

/** Pi's token format: 950, 1.2k, 601k, 1.4M. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** The line for a notice, and Pi's color for it. */
export function noticeLine(notice: Notice): { text: string; color: "warning" | "dim" } {
  switch (notice.kind) {
    case "miss": {
      const cost = notice.missedCost >= 0.01 ? ` (~$${notice.missedCost.toFixed(2)})` : "";
      let label = "Cache miss";
      if (notice.modelChanged) label = "Cache miss after model switch";
      else if (notice.idleMs >= 300_000) label = `Cache miss after ${Math.round(notice.idleMs / 60_000)}m idle`;
      return { text: `${label}: ${formatTokens(notice.missedTokens)} tokens re-billed${cost}`, color: "warning" };
    }
    case "warm": {
      const note = notice.note ? ` (${notice.note})` : "";
      const cost = notice.cost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
      return { text: `Cache warmed${note}: $${cost}`, color: "dim" };
    }
    case "compaction": {
      const cost = notice.cost >= 0.01 ? ` (~$${notice.cost.toFixed(2)})` : "";
      return { text: `Compaction: ${formatTokens(notice.tokens)} tokens billed${cost}`, color: "warning" };
    }
  }
}
