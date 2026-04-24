import { describe, expect, it } from "vitest";
import { extractSkillInput, parseRouterDecision } from "../src/router/routerClient.js";

describe("router parsing", () => {
  it("parses research JSON", () => {
    const decision = parseRouterDecision(
      '{"skill":"research","args":{"query":"x402 adoption in Asia"},"confidence":0.98}'
    );

    expect(decision.skill).toBe("research");
    expect(extractSkillInput(decision)).toBe("x402 adoption in Asia");
  });

  it("parses enrich JSON embedded in wrapper text", () => {
    const decision = parseRouterDecision(
      'Result: {"skill":"enrich","args":{"email":"jane@stripe.com"},"confidence":0.87}'
    );

    expect(decision.skill).toBe("enrich");
    expect(extractSkillInput(decision)).toBe("jane@stripe.com");
  });

  it("returns no args for none", () => {
    const decision = parseRouterDecision(
      '{"skill":"none","args":{},"confidence":0.22}'
    );

    expect(decision.skill).toBe("none");
    expect(extractSkillInput(decision)).toBeNull();
  });
});
