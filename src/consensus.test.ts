import { describe, expect, it } from "vitest";
import { majority, majorityGroups } from "./consensus.js";

describe("majority", () => {
  it("is more than half", () => {
    expect([1, 2, 3, 4, 5].map(majority)).toEqual([1, 2, 2, 3, 3]);
  });
});

describe("majorityGroups", () => {
  it("keeps pairs that 2 of 3 groupings agree on", () => {
    const runs = [[[1, 2, 3]], [[1, 2], [3, 4]], [[1, 2, 3], [5, 6]]];
    // 1-2 in 3 runs, 1-3 and 2-3 in 2 runs, 3-4 in 1, 5-6 in 1
    expect(majorityGroups(runs, 2)).toEqual([[1, 2, 3]]);
  });

  it("drops pairs with too few votes and items left without a partner", () => {
    const runs = [[[1, 2]], [[3, 4]], [[5, 6]]];
    expect(majorityGroups(runs, 2)).toEqual([]);
  });

  it("is the identity for a single grouping with one vote", () => {
    expect(majorityGroups([[[3, 1], [2, 4, 5]]], 1)).toEqual([[1, 3], [2, 4, 5]]);
  });

  it("ignores duplicate ids inside a group and does not depend on group order", () => {
    expect(majorityGroups([[[1, 1, 2]], [[2, 1]]], 2)).toEqual([[1, 2]]);
  });

  it("chains agreed pairs into one group", () => {
    const runs = [[[1, 2], [2, 3]], [[1, 2], [2, 3]], [[7, 8]]];
    expect(majorityGroups(runs, 2)).toEqual([[1, 2, 3]]);
  });
});
