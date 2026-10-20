/** One file of a pull request diff, reduced to what review needs. */
export interface FileDiff {
  path: string;
  /** Unified diff hunks for the file. */
  patch: string;
  /** Line numbers (in the new file) of added lines; only these can receive comments. */
  addedLines: Set<number>;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };

/** Decode a path git wrapped in double quotes (C-style escapes; non-ASCII bytes as octal) to a plain string. */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const body = quoted.slice(1, quoted.endsWith('"') ? -1 : undefined);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else {
      const next = body[i + 1] ?? "";
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The file path of a `+++ ` header line: without the `b/` prefix, the carriage return of a CRLF diff, or the
 * tab (and timestamp) git and diff append after paths with spaces; quoted paths are decoded.
 */
export function pathFromHeader(line: string): string {
  let raw = line.slice(4).replace(/\r$/, "");
  if (raw.startsWith('"')) raw = unquoteGitPath(raw);
  else raw = raw.split("\t")[0]!;
  return raw.replace(/^b\//, "");
}

/** Split a unified diff (as returned by the GitHub diff media type) into per-file diffs. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { path: string; patch: string[]; addedLines: Set<number> } | undefined;
  let newLine = 0;
  let inHunk = false;

  const flush = () => {
    if (current && current.addedLines.size > 0) {
      files.push({ path: current.path, patch: current.patch.join("\n"), addedLines: current.addedLines });
    }
  };

  for (const rawLine of diff.split("\n")) {
    // A CRLF diff leaves a carriage return on every line; it is never part of the code or the path.
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      flush();
      current = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      // "+++ /dev/null" marks a deleted file, which has nothing to review.
      if (line !== "+++ /dev/null") current = { path: pathFromHeader(line), patch: [], addedLines: new Set() };
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      current?.patch.push(line);
      continue;
    }
    if (!current || !inHunk) continue;
    if (line.startsWith("+")) {
      current.addedLines.add(newLine);
      current.patch.push(`${newLine}: ${line}`);
      newLine++;
    } else if (line.startsWith("-")) {
      current.patch.push(`   ${line}`);
    } else if (line.startsWith("\\")) {
      continue;
    } else {
      current.patch.push(`${newLine}:  ${line.slice(1)}`);
      newLine++;
    }
  }
  flush();
  return files;
}
