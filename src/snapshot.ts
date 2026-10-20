import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { z } from "zod";
import type { ReviewComment } from "./github.js";

const CommentSchema = z.object({
  id: z.number(),
  prNumber: z.number(),
  reviewer: z.string(),
  body: z.string(),
  path: z.string(),
  diffHunk: z.string(),
  url: z.string(),
  createdAt: z.string(),
  inReplyTo: z.number().optional(),
  byPullRequestAuthor: z.boolean().optional(),
});
const SnapshotSchema = z.object({ version: z.literal(1), repo: z.string(), fetchedAt: z.string(), comments: z.array(CommentSchema) });

/**
 * A saved copy of the fetched review comments, so several runs (variants, repeated measurements)
 * read exactly the same input and GitHub drift cannot confound the comparison.
 * A path ending in `.gz` is read and written gzip-compressed (about 7x smaller).
 * The snapshot holds raw comment bodies: only snapshot public repositories into shared places.
 */
export async function loadOrFetchComments(
  path: string | undefined,
  repo: string,
  fetchComments: () => Promise<ReviewComment[]>,
  log: (message: string) => void = () => {},
): Promise<ReviewComment[]> {
  if (!path) return fetchComments();
  const gz = path.endsWith(".gz");
  const existing = await readFile(path).then(
    (bytes) => SnapshotSchema.parse(JSON.parse((gz ? gunzipSync(bytes) : bytes).toString("utf8"))),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new Error(`Cannot use snapshot ${path}: ${error.message.split("\n")[0]}`);
    },
  );
  if (existing) {
    if (existing.repo !== repo) throw new Error(`Snapshot ${path} is for ${existing.repo}, not ${repo}.`);
    log(`Using ${existing.comments.length} comments saved at ${existing.fetchedAt} in ${path}; GitHub is not contacted.`);
    return existing.comments;
  }
  const comments = await fetchComments();
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify({ version: 1, repo, fetchedAt: new Date().toISOString(), comments })}\n`;
  await writeFile(path, gz ? gzipSync(text, { level: 9 }) : text);
  log(`Saved ${comments.length} comments to ${path} for later runs.`);
  return comments;
}
