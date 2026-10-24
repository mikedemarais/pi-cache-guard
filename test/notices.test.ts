import { describe, expect, test } from "vitest";

import { detectMiss, noticeLine } from "../src/notices.ts";

const T = Date.parse("2026-10-07T12:00:00Z");
const usage = (input: number, cacheRead: number, cacheWrite: number) => ({
  input, output: 100, cacheRead, cacheWrite,
  // $4/M input, $5/M write, $0.2/M read.
  cost: { input: input * 4e-6, cacheWrite: cacheWrite * 5e-6, cacheRead: cacheRead * 0.2e-6 },
});
const msg = (at: number, u: ReturnType<typeof usage>, model = "claude-opus-5-5") =>
  ({ role: "assistant", provider: "anthropic", model, timestamp: at, stopReason: "stop", usage: u });
const entry = (m: ReturnType<typeof msg>) => ({ type: "message", message: m });
const price = () => 0.2;

describe("detectMiss", () => {
  test("a re-cache after idle is a miss with its cost", () => {
    const prior = [entry(msg(T - 600_000, usage(2, 600_000, 0)))];
    const miss = detectMiss(prior, msg(T, usage(2, 0, 601_000)), price);
    expect(miss).toMatchObject({ kind: "miss", missedTokens: 600_002, modelChanged: false, idleMs: 600_000 });
    expect(noticeLine(miss!).text).toBe("Cache miss after 10m idle: 600k tokens re-billed (~$2.88)");
  });

  test("a hit, a small miss, the first turn and after compaction are not", () => {
    const prior = [entry(msg(T - 60_000, usage(2, 600_000, 0)))];
    expect(detectMiss(prior, msg(T, usage(2, 600_000, 1_000)), price)).toBeUndefined();
    expect(detectMiss(prior, msg(T, usage(2, 590_000, 11_000)), price)).toBeUndefined();
    expect(detectMiss([], msg(T, usage(2, 0, 601_000)), price)).toBeUndefined();
    expect(detectMiss([...prior, { type: "compaction" }], msg(T, usage(2, 0, 50_000)), price)).toBeUndefined();
  });

  test("a model whose cache read costs as much as input has nothing to miss", () => {
    // Venice's qwen-3-8-27b: $0.45/M either way.
    const flat = (input: number, cacheRead: number) => ({ input, output: 100, cacheRead, cacheWrite: 0,
      cost: { input: input * 0.45e-6, cacheWrite: 0, cacheRead: cacheRead * 0.45e-6 } });
    const prior = [entry(msg(T - 10_000, flat(9_000, 13_000), "qwen-3-8-27b"))];
    expect(detectMiss(prior, msg(T, flat(60_000, 0), "qwen-3-8-27b"), () => 0.45)).toBeUndefined();
    // A real discount just below the input price still reports the miss.
    expect(detectMiss(prior, msg(T, flat(600_000, 0), "qwen-3-8-27b"), () => 0.449)).toMatchObject({ kind: "miss" });
    // A free (subscription-priced) model still reports its misses: the quota is the cost.
    const free = (input: number, cacheRead: number) => ({ input, output: 100, cacheRead, cacheWrite: 0, cost: { input: 0, cacheWrite: 0, cacheRead: 0 } });
    expect(detectMiss([entry(msg(T - 10_000, free(2, 600_000)))], msg(T, free(601_000, 0)), () => 0)).toMatchObject({ kind: "miss" });
  });

  test("a model switch; a cache_warm refresh counts as the previous request", () => {
    const prior = [entry(msg(T - 60_000, usage(2, 600_000, 0), "claude-sonnet-5-5"))];
    expect(noticeLine(detectMiss(prior, msg(T, usage(2, 0, 601_000)), price)!).text).toMatch(/^Cache miss after model switch: 600k/);
    const warmed = [entry(msg(T - 900_000, usage(2, 600_000, 0))),
      { type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", timestamp: new Date(T - 60_000).toISOString(), usage: usage(2, 600_000, 0) }];
    expect(noticeLine(detectMiss(warmed, msg(T, usage(2, 0, 601_000)), price)!).text).toMatch(/^Cache miss: 600k/);
  });

  test("warm and compaction lines", () => {
    expect(noticeLine({ kind: "warm", cost: 0.0123 }).text).toBe("Cache warmed: $0.0123");
    expect(noticeLine({ kind: "compaction", tokens: 650_000, cost: 1.2 }).text).toBe("Compaction: 650k tokens billed (~$1.20)");
  });
});
