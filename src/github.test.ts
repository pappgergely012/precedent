import { describe, expect, it } from "vitest";
import { GitHubApiError, fetchReviewComments } from "./github.js";

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

  it("builds citation urls from the requested repo, not the API html_url", async () => {
    const fetchImpl = (() => json([comment(5, "anna")])) as typeof fetch;
    const [c] = await fetchReviewComments("owner/name", { fetchImpl });
    expect(c!.url).toBe("https://github.com/owner/name/pull/42#discussion_r5");
  });

  it("keeps paging past maxPages until enough top-level comments are found", async () => {
    const reply = (id: number) => ({ ...comment(id, "anna"), in_reply_to_id: 1 });
    const page = (start: number, top: boolean) =>
      Array.from({ length: 100 }, (_, i) => (top ? comment(start + i, "anna") : reply(start + i)));
    let calls = 0;
    const fetchImpl = (() => json(++calls <= 2 ? page(calls * 1000, false) : page(calls * 1000, true))) as typeof fetch;
    const result = await fetchReviewComments("o/r", { fetchImpl, maxPages: 2, minTopLevel: 100 });
    expect(calls).toBe(3);
    expect(result).toHaveLength(300);
  });

  it("rejects an invalid repo name", async () => {
    await expect(fetchReviewComments("not-a-repo")).rejects.toThrow("Invalid repo");
  });

  it("throws on API errors", async () => {
    const fetchImpl = (() => json({ message: "Not Found" }, 404)) as typeof fetch;
    await expect(fetchReviewComments("o/r", { fetchImpl })).rejects.toThrow("404");
  });
});

describe("GitHub API errors", () => {
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status, headers }))) as typeof fetch;

  it("explains a missing repository in one line", async () => {
    const err = await fetchReviewComments("o/gone", { fetchImpl: respond(404, { message: "Not Found" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.message).toBe("Repository o/gone not found (404). Check the name, or set GITHUB_TOKEN to a token with access if it is private.");
  });

  it("says the token is invalid on 401", async () => {
    const err = await fetchReviewComments("o/r", { token: "bogus", fetchImpl: respond(401, { message: "Bad credentials" }) }).catch((e) => e);
    expect(err.message).toContain("GITHUB_TOKEN");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("Bad credentials");
  });

  it("reports rate limits with the reset time", async () => {
    const reset = String(Math.floor(Date.UTC(2026, 9, 19, 21, 30, 0) / 1000));
    const fetchImpl = respond(403, { message: "API rate limit exceeded for 1.2.3.4" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
    const err = await fetchReviewComments("o/r", { fetchImpl }).catch((e) => e);
    expect(err.message).toContain("rate limit reached (403)");
    expect(err.message).toContain("resets at 21:30:00 UTC");
  });

  it("keeps other 403s distinct from rate limits", async () => {
    const err = await fetchReviewComments("o/r", { fetchImpl: respond(403, { message: "Resource not accessible" }) }).catch((e) => e);
    expect(err.message).toBe("GitHub denied reading Repository o/r (403): Resource not accessible.");
  });

  it("does not leak raw JSON for unexpected statuses", async () => {
    const err = await fetchReviewComments("o/r", { fetchImpl: respond(500, { message: "Server Error", documentation_url: "x" }) }).catch((e) => e);
    expect(err.message).toBe("GitHub API 500 reading Repository o/r: Server Error");
  });
});
