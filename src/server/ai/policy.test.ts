import { describe, expect, it } from "vitest";
import {
  PROVIDER_BLIP_MS,
  PROVIDER_DOWN_MS,
  explainPriority,
  failoverCooldownMs,
  minExplainPriority,
  providerOrder,
} from "./policy";

const both = { anthropic: true, openai: true };
const now = 1_000_000;

describe("providerOrder", () => {
  it("prefers Anthropic, then OpenAI", () => {
    expect(providerOrder(both, {}, now)).toEqual(["anthropic", "openai"]);
  });

  it("skips Anthropic while it sits out, and re-probes it once the cooldown passes", () => {
    const down = { anthropic: now + PROVIDER_DOWN_MS };
    expect(providerOrder(both, down, now)).toEqual(["openai"]);
    expect(providerOrder(both, down, now + PROVIDER_DOWN_MS - 1)).toEqual(["openai"]);
    expect(providerOrder(both, down, now + PROVIDER_DOWN_MS)).toEqual(["anthropic", "openai"]);
  });

  it("only offers configured providers", () => {
    expect(providerOrder({ anthropic: false, openai: true }, {}, now)).toEqual(["openai"]);
    expect(providerOrder({ anthropic: true, openai: false }, {}, now)).toEqual(["anthropic"]);
    expect(providerOrder({ anthropic: false, openai: false }, {}, now)).toEqual([]);
  });

  it("probes every configured provider when all of them sit out", () => {
    expect(providerOrder(both, { anthropic: now + 10, openai: now + 10 }, now)).toEqual(["anthropic", "openai"]);
    expect(providerOrder({ anthropic: true, openai: false }, { anthropic: now + 10 }, now)).toEqual(["anthropic"]);
  });
});

describe("failoverCooldownMs", () => {
  it("benches a provider for 30 min on billing, auth and unknown-model errors", () => {
    expect(failoverCooldownMs(400, "Your credit balance is too low to access the Anthropic API.")).toBe(PROVIDER_DOWN_MS);
    expect(failoverCooldownMs(429, "You exceeded your current quota, please check your plan and billing details.")).toBe(PROVIDER_DOWN_MS);
    expect(failoverCooldownMs(401, "invalid x-api-key")).toBe(PROVIDER_DOWN_MS);
    expect(failoverCooldownMs(403, "permission denied")).toBe(PROVIDER_DOWN_MS);
    expect(failoverCooldownMs(404, "model: claude-x not found")).toBe(PROVIDER_DOWN_MS);
  });

  it("benches briefly on rate limits, overload, outages and network errors", () => {
    expect(failoverCooldownMs(429, "rate limit")).toBe(PROVIDER_BLIP_MS);
    expect(failoverCooldownMs(529, "Overloaded")).toBe(PROVIDER_BLIP_MS);
    expect(failoverCooldownMs(500, "internal")).toBe(PROVIDER_BLIP_MS);
    expect(failoverCooldownMs(null, "fetch failed")).toBe(PROVIDER_BLIP_MS);
  });

  it("does not fail over on request-specific errors", () => {
    expect(failoverCooldownMs(400, "prompt is too long")).toBeNull();
    expect(failoverCooldownMs(413, "request too large")).toBeNull();
    expect(failoverCooldownMs(422, "invalid")).toBeNull();
  });
});

describe("explanation budget", () => {
  it("ranks live tier, then swarm, then size", () => {
    const small = explainPriority({ live: false, swarm: false, usdValue: 20 });
    const big = explainPriority({ live: false, swarm: false, usdValue: 1500 });
    const swarm = explainPriority({ live: false, swarm: true, usdValue: 20 });
    const live = explainPriority({ live: true, swarm: false, usdValue: null });
    expect(small).toBe(0);
    expect(big).toBeGreaterThan(small);
    expect(swarm).toBeGreaterThan(small);
    expect(live).toBeGreaterThan(big);
    expect(live).toBeGreaterThan(swarm);
  });

  it("raises the bar as the hourly budget fills and stops at the cap", () => {
    expect(minExplainPriority(0, 300)).toBe(0);
    expect(minExplainPriority(149, 300)).toBe(0);
    const mid = minExplainPriority(150, 300);
    const late = minExplainPriority(250, 300);
    expect(mid).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(mid);
    // live-tier alerts still pass until the cap; a small standard-tier trade does not
    expect(explainPriority({ live: true, swarm: false, usdValue: 5 })).toBeGreaterThanOrEqual(late);
    expect(explainPriority({ live: false, swarm: false, usdValue: 50 })).toBeLessThan(mid);
    expect(minExplainPriority(300, 300)).toBe(Infinity);
    expect(minExplainPriority(0, 0)).toBe(Infinity);
  });
});
