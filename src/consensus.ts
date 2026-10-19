/**
 * The model groups items differently on every run. Asking k times and keeping only what a
 * majority agrees on removes most of that noise: two items end up together when at least
 * `minVotes` of the groupings put them in the same group, and chains of such pairs form the
 * final groups.
 */
export function majorityGroups(groupings: number[][][], minVotes: number): number[][] {
  const votes = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const grouping of groupings) {
    for (const group of grouping) {
      const ids = [...new Set(group)];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = key(ids[i]!, ids[j]!);
          votes.set(k, (votes.get(k) ?? 0) + 1);
        }
      }
    }
  }

  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const [k, n] of votes) {
    if (n < minVotes) continue;
    const [a, b] = k.split(":").map(Number) as [number, number];
    parent.set(find(a), find(b));
  }

  const components = new Map<number, number[]>();
  for (const x of parent.keys()) {
    const root = find(x);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(x);
  }
  // Only items that actually have a majority partner form a group.
  return [...components.values()]
    .filter((c) => c.length > 1)
    .map((c) => c.sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!);
}

/** Votes needed for a majority of `k` runs (2 of 3, 2 of 2, 1 of 1, 3 of 4). */
export const majority = (k: number): number => Math.floor(k / 2) + 1;
