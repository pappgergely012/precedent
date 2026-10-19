import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync("npx", ["tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "test-key", GITHUB_TOKEN: undefined, ...env },
  });

describe("cli errors", () => {
  it("prints a one-line error without a stack trace for an invalid repo", () => {
    const r = run(["mine", "nonsense"]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n").pop()).toBe('Error: Invalid repo "nonsense", expected "owner/name"');
    expect(r.stderr).not.toContain("    at ");
  });

  it("warns up front when GITHUB_TOKEN is unset", () => {
    const r = run(["mine", "nonsense"]);
    expect(r.stderr).toContain("Warning: GITHUB_TOKEN is not set");
  });

  it("still requires an Anthropic key", () => {
    const r = run(["mine", "o/r"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Set PRECEDENT_ANTHROPIC_API_KEY");
  });
});
