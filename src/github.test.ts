import { describe, expect, it } from "vitest";
import { fetchReviewComments } from "./github.js";

const comment = (id: number, login: string, type = "User") => ({
  id,
  pull_request_url: "https://api.github.com/repos/o/r/pulls/42",
  user: { login, type },
  body: "Please add a rate limit here.",
  path: "src/api.ts",
  diff_hunk: "@@ -1,3 +1,4 @@",
  html_url: `https://github.com/o/r/pull/42#discussion_r${id}`,
  created_at: "2026-01-01T00:00:00Z",
});

const json = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status }));

describe("fetchReviewComments", () => {
  it("maps comments and skips bots", async () => {
    const fetchImpl = (() => json([comment(1, "anna"), comment(2, "ci-bot", "Bot")])) as typeof fetch;
    const result = await fetchReviewComments("o/r", { fetchImpl });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, prNumber: 42, reviewer: "anna", path: "src/api.ts" });
  });

  it("skips review bots that run as ordinary user accounts", async () => {
    const fetchImpl = (() =>
      json([comment(1, "anna"), comment(2, "zigpy-review-bot"), comment(3, "balloobbot"), comment(4, "dependabot[bot]")])) as typeof fetch;
    const result = await fetchReviewComments("o/r", { fetchImpl });
    expect(result.map((c) => c.reviewer)).toEqual(["anna"]);
  });

  it("paginates until a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i + 1, "anna"));
    let calls = 0;
    const fetchImpl = (() => json(++calls === 1 ? full : [comment(999, "bob")])) as typeof fetch;
    const result = await fetchReviewComments("o/r", { fetchImpl });
    expect(calls).toBe(2);
    expect(result).toHaveLength(101);
  });

  it("rejects an invalid repo name", async () => {
    await expect(fetchReviewComments("not-a-repo")).rejects.toThrow("Invalid repo");
  });

  it("throws on API errors", async () => {
    const fetchImpl = (() => json({ message: "Not Found" }, 404)) as typeof fetch;
    await expect(fetchReviewComments("o/r", { fetchImpl })).rejects.toThrow("404");
  });
});
