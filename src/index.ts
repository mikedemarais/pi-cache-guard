// pi-cache-guard: asks before a prompt that would re-cache a large conversation, and publishes the
// prompt cache's time left as the `cache-guard` status (pi-status-footer folds it into its context
// row). Keeping the cache warm is Pi's own job: `cacheWarming: "idle"` in settings.json. Its
// refreshes are `cache_warm` usage entries, which this clock reads as cache activity.
//
// With Jev set up (`/cache-guard jev`), it also keeps the context lean (`context.ts`): large tool
// output is trimmed as it arrives, and a cold cache can be compacted in about a second.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { type CacheView, type LastRequest, type ModelInfo, lastRequest, view } from "./clock.ts";
import { loadSettings, saveUserSettings } from "./config.ts";
import { type Lean, leanContext, trimStatus } from "./context.ts";
import { HerdrReporter } from "./herdr.ts";
import { JEV_LOGINS, type JevState, label, probe } from "./jev.ts";
import { JEV_KEY_URL, JEV_PITCH } from "./lean.ts";
import { type AssistantLike, NOTICE_TYPE, type Notice, detectMiss, noticeLine, warmRunNotice } from "./notices.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_SETTINGS,
  NAME,
  type Settings,
  describeMiss,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  choiceCosts,
  compactionFocus,
  herdrCacheValue,
  missCost,
  worthWarning,
} from "./core.ts";

const STATUS_KEY = NAME;
const TICK_MS = 1_000;
const SUBCOMMANDS = ["status", "on", "off", "fresh", "compact", "jev"];
/** The `/cache-guard jev` and `/cache-guard compact` choices. */
const JEV_DONE = "Done";
const JEV_ON = "Turn Jev on";
const JEV_LEAVE_OFF = "Leave it off";
const JEV_OFF = "Turn Jev off";
const JEV_OFF_TIPS = "Turn Jev off (no more tips)";
const JEV_ANY = "Use any provider that works (clear jev.provider)";
const JEV_SETUP = "Set up Jev";
const COMPACT_PI = "Compact with Pi's summary";
/** The guidance choices after "Compact first". */
const SUMMARY_DEFAULT = "Default summary";
const SUMMARY_FOCUS = "Focus the summary on this prompt";
const SUMMARY_WRITE = "Write guidance for the summary...";

type ModelLike = NonNullable<ExtensionContext["model"]>;

/** The TTL Pi requests for this model: its `promptCache` lifetime for the active retention tier. */
export function modelInfo(model: ModelLike | undefined, env: NodeJS.ProcessEnv = process.env): ModelInfo | undefined {
  if (!model) return undefined;
  const retention = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  const seconds = (model as { promptCache?: { short?: number; long?: number } }).promptCache?.[retention];
  const cost = model.cost;
  const price = cost && cost.input > 0
    ? { input: cost.input, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite > 0 ? cost.cacheWrite : cost.input }
    : undefined;
  return { provider: model.provider, id: model.id, ttlMs: seconds === undefined ? undefined : seconds * 1000, price };
}

/** The status text: time left while warm, "cold" once the next request misses. */
export function statusText(v: CacheView | undefined): string | undefined {
  if (!v) return undefined;
  if (v.remainingMs !== undefined) return `cache ${formatClock(v.remainingMs)}`;
  if (v.cold?.kind === "model") return "cache cold (model)";
  if (v.cold) return v.cold.kind === "idle" ? "cache cold?" : "cache cold";
  return undefined;
}

/** What `/cache-guard fresh` hands the new session's runtime. */
interface FreshStart {
  text: string;
  images?: ImageContent[];
  provider?: string;
  modelId?: string;
  thinking?: string;
}
const FRESH_KEY = Symbol.for("pi-cache-guard/fresh");

export type Choice = "keep" | "jev" | "compact" | "fresh" | "send" | "mute";

/** Under the cold-cache question while Jev is not set up (and not turned off). */
export const JEV_TIP = "Tip: /cache-guard jev sets up Jev, which compacts in about a second for ~$0 (or turns this tip off).";

/**
 * The ways through a cold cache, labelled with what they cost. Sending is first, so Enter sends as
 * if nothing had asked; Esc still keeps the prompt in the editor. With Jev there are two
 * compactions: Jev's, written in code, and a summary (which Jev filters first when `filtered`, so
 * its cost is an upper bound).
 */
export function choiceMenu(v: CacheView, jev: { ready: boolean; filtered: boolean } = { ready: false, filtered: false }): Array<{ choice: Choice; label: string }> {
  const costs = v.price ? choiceCosts(v.last.tokens, v.price, v.ttlMs ?? 5 * 60_000) : undefined;
  const about = (cost: number | undefined, upTo = false) => (cost === undefined ? "" : ` (${upTo ? "up to " : ""}~${formatCost(cost)})`);
  const compactions: Array<{ choice: Choice; label: string }> = jev.ready
    ? [
        { choice: "jev", label: "Compact with Jev, then send it (~1s, ~$0)" },
        { choice: "compact", label: `Compact with a summary, then send it${about(costs?.compact, jev.filtered)}` },
      ]
    : [{ choice: "compact", label: `Compact first, then send it${about(costs?.compact)}` }];
  return [
    { choice: "send", label: `Send anyway${about(costs?.send)}` },
    { choice: "mute", label: "Send, and stop asking in this session" },
    ...compactions,
    { choice: "fresh", label: "Start a new session with this prompt (no history, ~$0)" },
    { choice: "keep", label: "Keep the prompt in the editor" },
  ];
}

/** The cost of the miss `v` describes, in dollars at list prices, when Pi knows the model's prices. */
export function coldCost(v: CacheView): number | undefined {
  if (!v.cold || !v.price) return undefined;
  return missCost(v.last.tokens, v.price, v.ttlMs ?? 5 * 60_000);
}

export default function cacheGuard(pi: ExtensionAPI, options: { herdr?: HerdrReporter } = {}) {
  // Inside a herdr pane (through pi-herdr): the `cache` token, so herdr's agents sidebar shows this
  // session when doomed.
  const herdr = options.herdr ?? new HerdrReporter(pi.events);
  pi.events?.on("herdr:ready", () => herdr.resend());
  // Jev: trimming tool output, and compaction.
  const lean: Lean = leanContext(pi);
  let ctx: ExtensionContext | undefined;
  let settings: Settings = DEFAULT_SETTINGS;
  // A miss found at message_end, written at turn_end once the message itself is in the session.
  let pendingMiss: Notice | undefined;
  // Keep-warm refreshes already noted (Pi has no event for them; the tick looks for new ones).
  let seenWarm = new Set<string>();

  const notify = (notice: Notice) => {
    if (sessionOn && settings.enabled && ctx?.hasUI) pi.appendEntry<Notice>(NOTICE_TYPE, notice);
  };
  /** `cache_warm` usage entries after the last assistant message, oldest first. */
  const recentWarms = (context: ExtensionContext) => {
    const branch = context.sessionManager.getBranch() as Array<{ id?: string; type?: string; kind?: string; note?: string; usage?: { cost?: { total?: number } }; message?: { role?: string } }>;
    const warms = [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type === "message" && entry.message?.role === "assistant") break;
      if (entry.type === "usage" && entry.kind === "cache_warm" && entry.id) warms.unshift(entry);
    }
    return warms;
  };
  const noteWarms = (context: ExtensionContext) => {
    for (const entry of recentWarms(context)) {
      if (seenWarm.has(entry.id!)) continue;
      seenWarm.add(entry.id!);
      notify({ kind: "warm", cost: entry.usage?.cost?.total ?? 0, note: entry.note });
    }
  };
  let sessionOn = true;
  // "Send, and stop asking": the warning is off for this session, the clock and herdr stay on.
  let askOn = true;
  // A held prompt the `/cache-guard fresh` command carries into a new session.
  let pending: { text: string; images?: ImageContent[] } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shown: string | undefined;
  // Request start of the assistant message streaming now; the branch only has it at message_end.
  let live: { at: number; provider: string; model: string } | undefined;

  const current = (context: ExtensionContext): CacheView | undefined => {
    const info = modelInfo(context.model);
    if (!info) return undefined;
    let last: LastRequest | undefined = lastRequest(context.sessionManager.getBranch());
    if (live && last && live.provider === last.provider && live.model === last.model && live.at > last.at) {
      last = { ...last, at: live.at, realAt: live.at };
    }
    if (!last) return undefined;
    return view(last, info, Date.now(), settings.warn.idleMinutes * 60_000);
  };

  const publish = () => {
    if (!ctx) return;
    noteWarms(ctx);
    const v = sessionOn && settings.enabled ? current(ctx) : undefined;
    const text = statusText(v);
    if (text !== shown) {
      shown = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    }
    herdr.report(v ? herdrCacheValue(v.cold, v.last.tokens, coldCost(v), settings) : undefined);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx && shown !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    shown = undefined;
    void herdr.clear();
    ctx = undefined;
    live = undefined;
  };

  pi.on("session_start", (event, context) => {
    stop();
    const fresh = event.reason === "new" ? (globalThis as Record<symbol, unknown>)[FRESH_KEY] as FreshStart | undefined : undefined;
    if (fresh) {
      delete (globalThis as Record<symbol, unknown>)[FRESH_KEY];
      void startFresh(pi, context, fresh);
    }
    ctx = context;
    sessionOn = true;
    askOn = true;
    settings = loadSettings(context.cwd);
    pendingMiss = undefined;
    seenWarm = new Set(recentWarms(context).map((entry) => entry.id!));
    if (!context.hasUI) return;
    publish();
    timer = setInterval(publish, TICK_MS);
    timer.unref?.();
  });
  pi.on("session_shutdown", () => stop());
  // The context or model changed under the clock: drop the streaming message's start time.
  const refresh = (context: ExtensionContext, keepLive: boolean) => {
    if (!ctx) return;
    ctx = context;
    if (!keepLive) live = undefined;
    publish();
  };
  pi.on("model_select", (_event, context) => refresh(context, false));
  pi.on("session_tree", (_event, context) => refresh(context, false));
  pi.on("session_compact", (event, context) => {
    const usage = (event.compactionEntry as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } }).usage;
    if (ctx && usage) {
      notify({ kind: "compaction", tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite, cost: usage.cost.total });
    }
    refresh(context, false);
  });
  pi.on("message_end", (event, context) => {
    const message = event.message as unknown as AssistantLike;
    if (!ctx || message.role !== "assistant" || !message.usage || message.stopReason === "error" || message.stopReason === "aborted") return;
    // The session does not have this message yet, so the branch ends at the request before it.
    pendingMiss = detectMiss(context.sessionManager.getBranch(), message, (provider, id) => context.modelRegistry.find(provider, id)?.cost.cacheRead);
  });
  const flushMiss = () => {
    if (pendingMiss) notify(pendingMiss);
    pendingMiss = undefined;
  };
  pi.on("turn_end", () => flushMiss());
  pi.on("agent_end", () => flushMiss());

  pi.registerEntryRenderer<Notice>(NOTICE_TYPE, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    // Rendering runs every frame; the run changes only with the session leaf.
    let drawn: { leaf: string | null | undefined; line: ReturnType<typeof noticeLine> | undefined } | undefined;
    const draw = () => {
      const leaf = ctx?.sessionManager.getLeafId();
      if (drawn?.leaf !== leaf || !drawn) {
        const notice = ctx ? warmRunNotice(ctx.sessionManager.getBranch(), { ...entry, data: entry.data! }) : entry.data;
        drawn = { leaf, line: notice && noticeLine(notice) };
      }
      return drawn.line;
    };
    // A later warm of the same run draws nothing; this line, drawn again on every render, shows it.
    if (!draw()) return undefined;
    return {
      render: (width: number) => {
        const line = draw();
        return line ? new Text(theme.fg(line.color, line.text), 1, 0).render(width) : [];
      },
      invalidate: () => {},
    };
  });
  pi.on("agent_settled", (_event, context) => refresh(context, true));
  pi.on("message_start", (event, context) => {
    const message = event.message as { role?: string; timestamp?: number; provider?: string; model?: string };
    if (message.role !== "assistant" || typeof message.timestamp !== "number") return;
    live = { at: message.timestamp, provider: String(message.provider ?? ""), model: String(message.model ?? "") };
    if (ctx) {
      ctx = context;
      publish();
    }
  });

  pi.on("input", async (event, context) => {
    if (!sessionOn || !askOn || event.source !== "interactive" || event.streamingBehavior !== undefined || !context.hasUI) {
      return { action: "continue" };
    }
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    settings = loadSettings(context.cwd);
    const v = current(context);
    if (!v?.cold) return { action: "continue" };
    const cost = coldCost(v);
    if (!worthWarning(v.last.tokens, cost, settings)) return { action: "continue" };
    const jev = await lean.jev(context);
    const menu = choiceMenu(v, { ready: jev.kind === "ready", filtered: settings.compact.filter });
    const title = `Prompt cache miss. ${describeMiss(v.cold, v.last.tokens, cost)}${jev.kind === "missing" ? `\n${JEV_TIP}` : ""}`;
    const picked = await context.ui.select(title, menu.map((item) => item.label));
    const choice = menu.find((item) => item.label === picked)?.choice ?? "keep";
    const keep = () => {
      context.ui.setEditorText(event.text);
      return { action: "handled" as const };
    };
    const content: string | (TextContent | ImageContent)[] = event.images?.length
      ? [{ type: "text", text: event.text }, ...event.images]
      : event.text;
    switch (choice) {
      case "send":
        return { action: "continue" };
      case "mute":
        askOn = false;
        return { action: "continue" };
      case "fresh":
        // Replacing the session is a command's job: run ours once this input has been handled.
        pending = { text: event.text, images: event.images };
        setTimeout(() => void pi.sendUserMessage(`/${NAME} fresh`, { expandPromptTemplates: true }), 0);
        return { action: "handled" };
      case "jev":
        // Jev judges the history against the held prompt and writes the summary in code. Strict: if
        // Jev fails nothing is compacted (no surprise LLM summary), and the prompt goes back.
        lean.armJevCompaction({ goal: event.text, strict: true });
        context.ui.notify("Compacting with Jev, then sending your prompt.", "info");
        context.compact({
          onComplete: () => void pi.sendUserMessage(content),
          onError: (error) => {
            lean.disarm();
            context.ui.notify(`Compaction with Jev did not run: ${lean.lastFailure() ?? error.message}. Your prompt is back in the editor.`, "warning");
            context.ui.setEditorText(event.text);
          },
        });
        return { action: "handled" };
      case "compact": {
        lean.disarm();
        const how = await context.ui.select("Compact first: what should the summary keep?", [SUMMARY_DEFAULT, SUMMARY_FOCUS, SUMMARY_WRITE]);
        let guidance: string | undefined;
        if (how === SUMMARY_FOCUS) guidance = compactionFocus(event.text);
        else if (how === SUMMARY_WRITE) {
          guidance = await context.ui.input("Guidance for the summary", "what to keep or stress");
          if (guidance === undefined) return keep();
        } else if (how !== SUMMARY_DEFAULT) return keep();
        context.ui.notify("Compacting, then sending your prompt.", "info");
        context.compact({
          customInstructions: guidance?.trim() || undefined,
          onComplete: () => void pi.sendUserMessage(content),
          onError: (error) => {
            context.ui.notify(`Compaction failed (${error.message}); your prompt is back in the editor.`, "warning");
            context.ui.setEditorText(event.text);
          },
        });
        return { action: "handled" };
      }
      default:
        return keep();
    }
  });

  /** `/cache-guard jev`: which Jev is in use and whether it answers; or how to set it up. */
  const jevCommand = async (context: ExtensionContext) => {
    const save = (patch: Record<string, unknown>) => {
      try {
        saveUserSettings({ jev: patch });
        return true;
      } catch (error) {
        context.ui.notify(`Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
        return false;
      }
    };
    const current = loadSettings(context.cwd);
    if (!current.enabled) {
      context.ui.notify("cache-guard is off in its settings (\"enabled\": false), Jev included.", "info");
      return;
    }
    if (!current.jev.enabled) {
      const pick = await context.ui.select(`Jev is off: no trimming, no Jev compaction, no tips.\n${JEV_PITCH}`, [JEV_ON, JEV_LEAVE_OFF]);
      if (pick !== JEV_ON || !save({ enabled: true })) return;
    }
    const state = await lean.refresh(context);
    if (state.kind === "ready") {
      const answer = await probe(context.modelRegistry, state.target);
      const head = answer.ok
        ? `Jev: ${label(state.target)}, answered in ${answer.latencyMs} ms.`
        : `Jev: ${label(state.target)} did not answer (${answer.reason}).`;
      const others = state.others.map((target) => ({ target, text: `Use ${label(target)} instead` }));
      const pick = await context.ui.select(
        `${head} It trims large tool output and compacts in about a second: the cold-cache menu, /cache-guard compact.`,
        [JEV_DONE, ...others.map((o) => o.text), JEV_OFF],
      );
      const other = others.find((o) => o.text === pick);
      if (other && save({ provider: other.target.provider, model: other.target.model })) {
        await lean.refresh(context);
        context.ui.notify(`Jev: ${label(other.target)} from now on.`, "info");
      } else if (pick === JEV_OFF && save({ enabled: false })) {
        await lean.refresh(context);
        context.ui.notify("Jev is off: no trimming, no Jev compaction, no tips. /cache-guard jev turns it back on.", "info");
      }
      return;
    }
    if (state.kind === "off") return;
    const logins = JEV_LOGINS.map((login) => ({ ...login, text: `Log in to ${login.label}` }));
    const options = [...logins.map((l) => l.text), ...(current.jev.provider ? [JEV_ANY] : []), JEV_OFF_TIPS];
    const pick = await context.ui.select(
      `Jev is not set up: ${state.reason}.\n${JEV_PITCH}\nIt needs a TypeSafe API key (${JEV_KEY_URL}; or TYPESAFE_API_KEY in the environment), or a provider that serves Jev: OpenRouter, Vercel AI Gateway, Cloudflare Workers AI, OpenCode.`,
      options,
    );
    const login = logins.find((l) => l.text === pick);
    if (login) {
      context.ui.setEditorText(`/login ${login.provider}`);
      context.ui.notify(`Press Enter to log in to ${login.provider}, then run /cache-guard jev to check.`, "info");
    } else if (pick === JEV_ANY && save({ provider: "", model: "" })) {
      await jevCommand(context);
    } else if (pick === JEV_OFF_TIPS && save({ enabled: false })) {
      await lean.refresh(context);
      context.ui.notify("Jev is off: no trimming, no Jev compaction, no tips. /cache-guard jev turns it back on.", "info");
    }
  };

  /** `/cache-guard compact [focus]`: Jev's compaction, written in code; nothing is spent if Jev fails. */
  const compactCommand = async (focus: string, context: ExtensionContext) => {
    const jev = await lean.jev(context);
    if (jev.kind !== "ready") {
      const why = jev.kind === "off" ? "Jev is off" : `Jev is not set up (${jev.reason})`;
      const pick = await context.ui.select(`${why}. Compact with Pi's summary instead?`, [COMPACT_PI, JEV_SETUP]);
      if (pick === JEV_SETUP) await jevCommand(context);
      else if (pick === COMPACT_PI) {
        context.compact({
          customInstructions: focus || undefined,
          onError: (error) => context.ui.notify(`Compaction failed: ${error.message}`, "warning"),
        });
      }
      return;
    }
    lean.armJevCompaction({ strict: true, goal: focus || undefined });
    const started = Date.now();
    context.compact({
      customInstructions: focus || undefined,
      onComplete: () => context.ui.notify(`Compacted with Jev in ${((Date.now() - started) / 1000).toFixed(1)} s.`, "info"),
      onError: (error) => {
        lean.disarm();
        context.ui.notify(`Compaction with Jev did not run: ${lean.lastFailure() ?? error.message}.`, "warning");
      },
    });
  };

  pi.registerCommand(NAME, {
    description: "Prompt cache and context: status, on, off, fresh, compact [focus], jev",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, context) => {
      const command = args.trim().split(/\s+/u)[0] || "status";
      const rest = args.trim().slice(command.length).trim();
      if (command === "jev") return jevCommand(context);
      if (command === "compact") return compactCommand(rest, context);
      if (command === "fresh") {
        // A new session (linked to this one) that starts with the held prompt, or the editor's text.
        const carry = pending ?? (context.ui.getEditorText().trim() ? { text: context.ui.getEditorText() } : undefined);
        pending = undefined;
        if (!carry) {
          context.ui.notify("/cache-guard fresh starts a new session with the prompt in the editor; the editor is empty.", "info");
          return;
        }
        // The new session gets a fresh extension runtime: hand it the prompt, model and thinking
        // level through a process-wide slot that its session_start picks up.
        (globalThis as Record<symbol, unknown>)[FRESH_KEY] = {
          ...carry,
          provider: context.model?.provider,
          modelId: context.model?.id,
          thinking: pi.getThinkingLevel(),
        } satisfies FreshStart;
        const result = await context.newSession({ parentSession: context.sessionManager.getSessionFile() });
        if (result.cancelled) {
          delete (globalThis as Record<symbol, unknown>)[FRESH_KEY];
          context.ui.setEditorText(carry.text);
        }
        return;
      }
      if (command === "on" || command === "off") {
        sessionOn = command === "on";
        askOn = sessionOn;
        ctx = context;
        publish();
        context.ui.notify(`cache-guard ${command} for this session`, "info");
        return;
      }
      settings = loadSettings(context.cwd);
      const v = current(context);
      const lines: string[] = [];
      if (!v) {
        lines.push("No cached request on this branch yet (or the context was just compacted).");
      } else {
        const info = modelInfo(context.model);
        lines.push(`Last request: ${v.last.provider}/${v.last.model}, ${formatTokens(v.last.tokens)} tokens, ${formatDuration(Date.now() - v.last.realAt)} ago` +
          (v.last.at > v.last.realAt ? `; refreshed by cache warming ${formatDuration(Date.now() - v.last.at)} ago.` : "."));
        lines.push(info?.ttlMs === undefined
          ? `TTL: not published for ${info?.provider}/${info?.id}; warning after ${settings.warn.idleMinutes}m idle.`
          : `TTL: ${formatDuration(info.ttlMs)} (${process.env.PI_CACHE_RETENTION === "long" ? "PI_CACHE_RETENTION=long" : "short retention"}).`);
        if (v.remainingMs !== undefined) lines.push(`Warm: ${formatClock(v.remainingMs)} left.`);
        if (v.cold) {
          const cost = coldCost(v);
          lines.push(describeMiss(v.cold, v.last.tokens, cost));
          lines.push(worthWarning(v.last.tokens, cost, settings) ? "The next prompt asks before sending." : "Below the warning threshold.");
        }
      }
      lines.push(`Warning: ${sessionOn && settings.enabled && settings.warn.enabled ? `on, from ${formatCost(settings.warn.minCost)} (or ${formatTokens(settings.warn.minTokens)} tokens without prices)` : "off"}. Keep-warm: Pi's cacheWarming setting (/session shows its next decision).`);
      lines.push(jevLine(await lean.jev(context), settings, lean.savedChars()));
      context.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** The Jev line of `/cache-guard status`. */
export function jevLine(jev: JevState, settings: Settings, savedChars: number): string {
  if (jev.kind === "off") return "Jev: off (/cache-guard jev turns it on).";
  if (jev.kind === "missing") return `Jev: not set up (${jev.reason}); /cache-guard jev.`;
  const trim = settings.trim.enabled ? `trimming on${savedChars ? ` (${trimStatus(savedChars)?.replace("lean: ", "")} so far)` : ""}` : "trimming off";
  const compaction = `Jev compaction from the cold-cache menu and /cache-guard compact${settings.compact.filter ? "; it filters /compact too" : ""}`;
  return `Jev: ${label(jev.target)}; ${trim}; ${compaction}.`;
}

/** In the new session: the old session's model and thinking level, then the held prompt. */
async function startFresh(pi: ExtensionAPI, context: ExtensionContext, fresh: FreshStart): Promise<void> {
  const model = fresh.provider && fresh.modelId ? context.modelRegistry.find(fresh.provider, fresh.modelId) : undefined;
  if (model && (context.model?.provider !== model.provider || context.model?.id !== model.id)) await pi.setModel(model);
  if (fresh.thinking) pi.setThinkingLevel(fresh.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  setTimeout(() => void pi.sendUserMessage(fresh.images?.length ? [{ type: "text", text: fresh.text }, ...fresh.images] : fresh.text), 0);
}
