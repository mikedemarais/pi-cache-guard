# pi-cache-guard

A [Pi](https://pi.dev) extension that asks before a prompt would re-cache a large conversation,
shows how long the prompt cache has left, and, with [Jev](https://docs.typesafe.ai) (TypeSafe's
fast judgment model), keeps the context lean: large tool output is trimmed to what the agent needs,
and a conversation compacts in about a second. Everything but the Jev parts works without Jev.

Part of the cache-guard family:
[claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard),
[opencode-cache-guard](https://github.com/justmytwospence/opencode-cache-guard) and
[codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard) share its core
(`src/core.ts`, the clock and the settings), its Jev logic (`src/lean.ts`, the trimming and
compaction, with no harness imports) and its settings file. It replaces pi-lean-context.

## What it does

**Warns.** Anthropic keeps a cached prompt prefix for its TTL (5 minutes, or 1 hour with
`PI_CACHE_RETENTION=long`) from the start of the last request that used it. The first prompt after
that writes the whole conversation to the cache again, at 1.25x (or 2x) the input price instead of
0.05-0.1x for a read. When that rewrite would cost at least `warn.minCost` (default $0.50 at API
prices), the prompt waits for a choice:

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).
-> Send anyway (~$3.00)
   Send, and stop asking in this session
   Compact with Jev, then send it (~1s, ~$0)
   Compact with a summary, then send it (up to ~$2.40)
   Start a new session with this prompt (no history, ~$0)
   Keep the prompt in the editor
```

The options:

- **Send anyway**, or **Send, and stop asking in this session.** Sending is the default, so Enter
  sends as if nothing had asked. The second keeps the clock and the herdr token running.
- **Compact with Jev** (when Jev is set up). Jev judges every message and tool call against the
  held prompt, and the summary is written in code from its choices: no LLM reads the history, so it
  takes about a second and costs next to nothing. If Jev fails, nothing is compacted and the prompt
  goes back in the editor with the reason.
- **Compact with a summary** (**Compact first** without Jev). Asks what the summary should keep:
  Pi's default summary, a summary focused on the held prompt (keep what it needs, drop the rest), or
  your own guidance. It then compacts and sends the prompt onto the small context. Compacting reads
  the history once, at input price instead of a cache write; with Jev it reads only what Jev did not
  drop, so the price shown is an upper bound. If compaction fails (for example the session is too
  small), the prompt goes back in the editor.
- **Start a new session.** Opens a new session linked to this one, on the same model and thinking
  level, and sends the prompt there. Also available as `/cache-guard fresh`, which takes the
  editor's text.
- **Keep the prompt in the editor.** Esc does the same, and spends nothing.

Without Jev the question ends with a tip: `/cache-guard jev` sets it up, or turns it (and the tip)
off.

The headline cost is what the miss adds over a cache hit. The costs in the options are each
path's total.

It also asks when the selected model differs from the one the conversation was cached for (each
model has its own cache). For models without a published TTL (OpenAI and Codex models) it asks
after `warn.idleMinutes` (default 180) idle, worded as a likelihood. Commands (`/...`), shell
input (`!...`), steering and follow-ups while the agent runs, and input from other extensions are
never held.

**Trims tool output (Jev).** Large text results (over 12k characters from `bash`, `grep`, `find`,
`ls`, MCP and web tools; over 50k from `read`) are trimmed before they enter the context, so the
prompt cache is never disturbed. Jev reads the agent's current step and the output, split into at
most 150 blocks, and says which blocks hold what the agent needs: errors, failures, warnings,
requested values, results. The kept blocks plus the first 5 and last 20 lines stay, in order, with
`[… N lines omitted …]` markers, and a footer points at the full output saved under
`~/.pi/agent/cache-guard/tool-output/<session>/`, to read with `offset`/`limit`.

Output too large for one Jev request is pre-filtered in code first (head, tail, every line that
looks like an error with two lines of context, and an even sample). Nothing is trimmed when Jev
thinks the agent wants the whole output, when more than 70% would be kept, when the same call was
already trimmed this turn (asking again returns everything), for nested calls from codemode
scripts, or when Jev is unavailable. Jev's token usage is added to the tool result. On ten 700-1,100
line build and test logs, about 3% of the characters remain and every failing line survives, in
300-700 ms (`npm run eval`). The `lean-context` status (`lean: −12k tok`, the tokens kept out so
far) is what pi-status-footer shows on its context row.

**Compacts with Jev.** Jev sorts every message and tool call being compacted into *verbatim*
(requirements, decisions, exact values, open errors), *summarize*, or *drop* (superseded or noise),
in batches of up to 120.

- **The cold-cache menu, `/cache-guard compact [focus]` and context-overflow recovery** write the
  summary in code, with no LLM, in about a second: the earlier summary, your requests, the verbatim
  items, one-line notes for the rest, and the files read and modified. The menu and the command
  cancel when Jev fails; overflow recovery falls back to Pi's compaction.
- **`/compact` and automatic compaction** run Pi's own summarizer on the conversation with dropped
  items removed and summarized ones shortened, then append the verbatim items
  (`"compact": { "filter": false }` leaves them to Pi alone). Any failure falls back to Pi's normal
  compaction.

**Shows the clock.** The `cache-guard` status reads `cache 4:12` (time left), `cache cold`,
`cache cold (model)` or `cache cold?` (no TTL known, long idle). pi-status-footer folds it into its
context row.

**Tells herdr.** Inside a [herdr](https://herdr.dev) pane, with
[pi-herdr](https://github.com/justmytwospence/pi-herdr) installed, it reports the pane token `cache`:
`cold 601k` (or `cold? 180k` for a guess from idle time) while the next prompt would re-cache at
least the warning threshold, and clears it while the cache is warm or small, and when the session
ends. Show it in herdr's agents sidebar with a custom token in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$cache", fg = "#5f87d7", rules = [{ starts_with = "cold?", dim = true }] }]]
```

`src/herdr.ts` hands the token to pi-herdr's event-bus bridge (`herdr:token`), which does the herdr
work; the opencode and Codex ports keep their own socket reporter. `"herdr": { "enabled": false }`
turns it off.

**Keeps the cache warm: not here.** Pi does that itself. With `"cacheWarming": "idle"` (Pi's default
since 1.5.1) in `~/.pi/agent/settings.json`, Pi re-sends the last request with a one-token output
cap at 90% of the TTL, between runs too, while the expected saving is at least $0.05 and for up to
30 minutes after the last real request (`/session` shows its next decision). Those refreshes are
recorded as `cache_warm` usage entries, and this extension's clock counts the ones that hit the
cache.

**Notes misses in the transcript.** A line after each turn that re-billed a significant part of the
conversation (`Cache miss after 12m idle: 600k tokens re-billed (~$2.88)`, from 20k tokens or
$0.10), one for each run of back-to-back keep-warm refreshes with their total (`Cache warmed:
$0.0123`, as Pi 1.5.1 draws its own) and one for what a compaction billed. These are Pi's own
`showCacheMissNotices` lines; that setting also prints `Anthropic dropped N thinking blocks` after
every turn, so leave it off and let this extension print the cache lines. They are custom session
entries (never sent to the model), so they show again on resume. `/cache-guard off` stops them for
the session.

## Setting up Jev

Jev runs through Pi's classifier models, so Pi holds the credentials. Any of these works; the
first one Pi can reach is used:

| Provider | Model | Credentials |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY`, or `/login typesafe` with a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` or `/login openrouter` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |

`/cache-guard jev` shows which one is in use and checks that it answers (`Jev:
typesafe/jev-latest, answered in 312 ms.`), offers the others it found, and can turn Jev off. With
none set up it explains the choices and puts `/login typesafe` (or `/login openrouter`) in the
editor; run `/cache-guard jev` again afterwards to check. Its choices are saved to
`~/.pi/agent/cache-guard.json` (`jev.provider`, `jev.model`, `jev.enabled`). Jev needs Pi 0.99 or
newer.

## Commands

- `/cache-guard` or `/cache-guard status`: the last request, TTL, time left or why it is cold,
  whether the next prompt will ask, and which Jev is in use.
- `/cache-guard compact [focus]`: a Jev compaction now, judged against the focus (or your last
  requests). Without Jev it offers Pi's summary instead.
- `/cache-guard jev`: set up, check, switch or turn off Jev.
- `/cache-guard fresh`: a new linked session that starts with the editor's text.
- `/cache-guard on`, `/cache-guard off`: the warning, the clock and the transcript lines, for this
  session. Trimming and compaction follow the settings.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then `~/.pi/agent/cache-guard.json`,
then the project's `.agents/cache-guard.json` and `.pi/cache-guard.json`. Later files win; objects
merge. Pi reads all but `warm`; the defaults:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "idleMinutes": 180 },
  "herdr": { "enabled": true },
  "jev": { "enabled": true, "provider": "", "model": "", "timeoutMs": 2500 },
  "trim": { "enabled": true, "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
            "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20 },
  "compact": { "filter": true, "timeoutMs": 10000, "concurrency": 4 }
}
```

`minTokens` applies only to models Pi has no prices for. `warm` settings are for the ports whose
harness has no built-in warming. An empty `jev.provider` picks the first provider that works.
`"enabled": false` turns everything off, Jev included; `"jev": { "enabled": false }` only the Jev
parts.

Jev's decisions are recorded in the session as `cache-guard:jev` entries (never sent to the model).

## Limits

- The clock is the API's guaranteed minimum, measured from each request's start; entries are
  deleted soon after it, not exactly at it. Other invalidations (tool or system prompt changes,
  an MCP server reconnecting) are not visible to it.
- Images attached to a held prompt are not put back in the editor.
- A Jev summary is assembled, not written: the requests, the items Jev kept word for word and a
  line for the rest. Pi's summary reads better when the history needs explaining.

## Development

```sh
npm ci && npm run check   # typecheck and unit tests
npm run eval              # live Jev through the installed Pi (needs Jev credentials)
pi -e ./src/index.ts
```
