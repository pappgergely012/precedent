import { describe, expect, it } from "vitest";
import type { Rule } from "./rule.js";
import { commentIdFromUrl, verifyRules } from "./verify.js";

const source = (id: number, pr: number, reviewer = "anna") => ({
  prNumber: pr,
  reviewer,
  commentUrl: `https://github.com/o/r/pull/${pr}#discussion_r${id}`,
});
const rule = (sources: Rule["sources"]): Rule => ({ id: "r1", description: "Do X", scope: [], confidence: 0.4, sources });

/** Fake API: known comments by id, everything else 404. */
const api = (known: Record<number, { login: string; pr: number }>) =>
  ((url: string) => {
    const id = Number(url.split("/").pop());
    const k = known[id];
    return Promise.resolve(
      k
        ? new Response(JSON.stringify({ user: { login: k.login }, pull_request_url: `https://api.github.com/repos/o/r/pulls/${k.pr}` }))
        : new Response("{}", { status: 404 }),
    );
  }) as unknown as typeof fetch;

describe("commentIdFromUrl", () => {
  it("extracts the discussion id", () => {
    expect(commentIdFromUrl("https://github.com/o/r/pull/3#discussion_r42")).toBe(42);
    expect(commentIdFromUrl("https://github.com/o/r/pull/3")).toBeUndefined();
  });
});

describe("verifyRules", () => {
  it("keeps rules whose citations resolve", async () => {
    const fetchImpl = api({ 1: { login: "anna", pr: 10 }, 2: { login: "anna", pr: 11 } });
    const out = await verifyRules("o/r", [rule([source(1, 10), source(2, 11)])], { fetchImpl });
    expect(out).toHaveLength(1);
  });

  it("drops unresolvable sources and rules that fall below the threshold", async () => {
    const fetchImpl = api({ 1: { login: "anna", pr: 10 } });
    expect(await verifyRules("o/r", [rule([source(1, 10), source(2, 11)])], { fetchImpl })).toEqual([]);
  });

  it("rejects a source with the wrong reviewer or pull request", async () => {
    const fetchImpl = api({ 1: { login: "bob", pr: 10 }, 2: { login: "anna", pr: 99 }, 3: { login: "anna", pr: 12 } });
    const out = await verifyRules("o/r", [rule([source(1, 10), source(2, 11), source(3, 12)])], { fetchImpl });
    expect(out).toEqual([]);
  });

  it("treats network errors as unverified", async () => {
    const fetchImpl = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await verifyRules("o/r", [rule([source(1, 10), source(2, 11)])], { fetchImpl, sleep: async () => {} })).toEqual([]);
  });
});
