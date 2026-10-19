/** One file of a pull request diff, reduced to what review needs. */
export interface FileDiff {
  path: string;
  /** Unified diff hunks for the file. */
  patch: string;
  /** Line numbers (in the new file) of added lines; only these can receive comments. */
  addedLines: Set<number>;
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

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      // "+++ /dev/null" marks a deleted file, which has nothing to review.
      if (line !== "+++ /dev/null") current = { path: line.slice(4).replace(/^b\//, ""), patch: [], addedLines: new Set() };
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
