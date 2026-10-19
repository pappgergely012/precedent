import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The "Run Precedent" step of action.yml is plain bash. These tests run it with a stub `node`
// that records its arguments, so no network, API key or model call is involved.
function runStepScript(): string {
  const lines = readFileSync(join(__dirname, "..", "action.yml"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("name: Run Precedent"));
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const body: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== "" && !l.startsWith("        ")) break;
    body.push(l.slice(8));
  }
  return body.join("\n");
}

function runAction(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "precedent-action-"));
  const log = join(dir, "node-args.txt");
  writeFileSync(join(dir, "node"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(dir, "node"), 0o755);
  const result = spawnSync("bash", ["-c", runStepScript()], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      GITHUB_ACTION_PATH: "/action",
      REPO: "acme/widgets",
      RULES_FILE: ".precedent/rules.json",
      POST: "true",
      ...env,
    },
    encoding: "utf8",
  });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8").trim();
  } catch {
    // stub never ran
  }
  return { status: result.status, stdout: result.stdout, calls };
}

describe("action.yml run step", () => {
  it("skips quietly without an API key and never starts the CLI", () => {
    const r = runAction({ MODE: "review", PR_NUMBER: "5", PRECEDENT_ANTHROPIC_API_KEY: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::notice::No Anthropic API key");
    expect(r.calls).toBe("");
  });

  it("reviews the pull request and posts by default", () => {
    const r = runAction({ MODE: "review", PR_NUMBER: "5", PRECEDENT_ANTHROPIC_API_KEY: "k" });
    expect(r.status).toBe(0);
    expect(r.calls).toBe("/action/dist/cli.js review acme/widgets 5 --rules .precedent/rules.json --post");
  });

  it("does not post when post is false", () => {
    const r = runAction({ MODE: "review", PR_NUMBER: "5", POST: "false", PRECEDENT_ANTHROPIC_API_KEY: "k" });
    expect(r.calls).toBe("/action/dist/cli.js review acme/widgets 5 --rules .precedent/rules.json");
  });

  it("fails review mode outside a pull_request event", () => {
    const r = runAction({ MODE: "review", PR_NUMBER: "", PRECEDENT_ANTHROPIC_API_KEY: "k" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("needs a pull_request event");
    expect(r.calls).toBe("");
  });

  it("mines into the rules file", () => {
    const r = runAction({ MODE: "mine", PR_NUMBER: "", PRECEDENT_ANTHROPIC_API_KEY: "k" });
    expect(r.calls).toBe("/action/dist/cli.js mine acme/widgets --out .precedent/rules.json");
  });

  it("rejects an unknown mode", () => {
    const r = runAction({ MODE: "audit", PR_NUMBER: "", PRECEDENT_ANTHROPIC_API_KEY: "k" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Unknown mode 'audit'");
    expect(r.calls).toBe("");
  });
});
