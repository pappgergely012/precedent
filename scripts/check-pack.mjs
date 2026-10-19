// Fails when the npm tarball would contain files that do not belong in it (tests, project notes, CI config, fixtures)
// or lacks the files an install needs. Run after `pnpm build`: `pnpm build && pnpm check:pack`.
import { execFileSync } from "node:child_process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const must = ["package.json", "README.md", "LICENSE", "dist/cli.js", "dist/index.js", "dist/index.d.ts"];
const missing = must.filter((f) => !files.includes(f));
const stray = files.filter((f) => !/^(dist\/|package\.json$|README\.md$|LICENSE$)/.test(f) || /\.test\.(js|ts|d\.ts)(\.map)?$/.test(f));
if (missing.length || stray.length) {
  console.error(`Tarball problems.\n  missing: ${missing.join(", ") || "none"}\n  unexpected: ${stray.join(", ") || "none"}`);
  process.exit(1);
}
console.log(`Tarball ok: ${files.length} files, nothing but dist, package.json, README and LICENSE.`);
