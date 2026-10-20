import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "./github.js";
import { loadOrFetchComments } from "./snapshot.js";

const comment: ReviewComment = { id: 1, prNumber: 2, reviewer: "anna", body: "Add a test.", path: "a.ts", diffHunk: "@@", url: "https://github.com/o/r/pull/2#discussion_r1", createdAt: "2026-01-01T00:00:00Z" };

describe("loadOrFetchComments", () => {
  it("fetches once, saves, and then reads the same comments without fetching again", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "snap-")), "nested", "o-r.json");
    let fetches = 0;
    const fetchIt = async () => (fetches++, [comment]);
    const messages: string[] = [];
    expect(await loadOrFetchComments(path, "o/r", fetchIt, (m) => messages.push(m))).toEqual([comment]);
    expect(await loadOrFetchComments(path, "o/r", fetchIt, (m) => messages.push(m))).toEqual([comment]);
    expect(fetches).toBe(1);
    expect(messages[0]).toContain("Saved 1 comments");
    expect(messages[1]).toContain("GitHub is not contacted");
  });

  it("reads and writes gzip-compressed snapshots for a .gz path", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "snap-")), "o-r.json.gz");
    let fetches = 0;
    const fetchIt = async () => (fetches++, [comment]);
    expect(await loadOrFetchComments(path, "o/r", fetchIt)).toEqual([comment]);
    expect((await readFile(path)).subarray(0, 2).toString("hex")).toBe("1f8b");
    expect(await loadOrFetchComments(path, "o/r", fetchIt)).toEqual([comment]);
    expect(fetches).toBe(1);
  });

  it("does not use or write a file when no path is given", async () => {
    let fetches = 0;
    await loadOrFetchComments(undefined, "o/r", async () => (fetches++, []));
    await loadOrFetchComments(undefined, "o/r", async () => (fetches++, []));
    expect(fetches).toBe(2);
  });

  it("refuses a snapshot of another repository and an unreadable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-"));
    const path = join(dir, "s.json");
    await loadOrFetchComments(path, "o/r", async () => [comment]);
    await expect(loadOrFetchComments(path, "x/y", async () => [])).rejects.toThrow("is for o/r, not x/y");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    await expect(loadOrFetchComments(dir, "o/r", async () => [])).rejects.toThrow(/Cannot use snapshot/);
  });
});
