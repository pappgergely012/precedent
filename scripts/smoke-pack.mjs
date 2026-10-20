// Installs the packed tarball into an empty temp project, the way a user would, and runs the CLI from there.
// Run after `pnpm build`: `pnpm smoke:pack`. Needs the npm registry (the dependencies are installed from it).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" } });
const work = mkdtempSync(join(tmpdir(), "precedent-smoke-"));
const packDir = join(work, "pack");
const project = join(work, "project");
try {
  execFileSync("mkdir", ["-p", packDir, project]);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], process.cwd());
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz")));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", version: "0.0.0", private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], project);
  const bin = join(project, "node_modules", ".bin", "precedent");
  const expect = (args, text) => {
    const out = run(bin, args, project);
    if (!out.includes(text)) throw new Error(`"precedent ${args.join(" ")}" did not print "${text}":\n${out}`);
  };
  expect(["--help"], "precedent check");
  expect(["check", "--help"], "precedent check <owner/repo>");
  expect(["--version"], ".");
  console.log("Smoke test ok: the packed tarball installs and runs --help, check --help and --version.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
