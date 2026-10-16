import { describe, expect, test } from "bun:test";
import { evaluatePredicate, resolvePath, toMembers, UNAVAILABLE } from "../../scripts/predicate.mjs";

/** Stand-in for a Foundry EmbeddedCollection: Map-like with `.contents`. */
function collection(members: any[]) {
  const map = new Map(members.map((m, i) => [m.id ?? String(i), m]));
  return Object.assign(map, { get contents() { return members; } });
}

describe("resolvePath", () => {
  test("walks nested fields", () => {
    expect(resolvePath({ grid: { size: 140 } }, "grid.size")).toBe(140);
  });
  test("returns undefined on a missing segment instead of throwing", () => {
    expect(resolvePath({ grid: {} }, "grid.nope.deeper")).toBeUndefined();
  });
  test("empty path returns the context", () => {
    const ctx = { a: 1 };
    expect(resolvePath(ctx, "")).toBe(ctx);
  });
});

describe("toMembers", () => {
  test("unwraps a Foundry-style collection", () => {
    const walls = collection([{ id: "a" }, { id: "b" }]);
    expect(toMembers(walls)).toHaveLength(2);
  });
  test("passes arrays through", () => {
    expect(toMembers([1, 2, 3])).toHaveLength(3);
  });
  test("reports UNAVAILABLE for a non-collection", () => {
    expect(toMembers(42)).toBe(UNAVAILABLE);
    expect(toMembers(null)).toBe(UNAVAILABLE);
  });
});

describe("comparators", () => {
  const scene = { grid: { size: 100, type: 1 }, tokenVision: true };
  test("eq / neq", () => {
    expect(evaluatePredicate({ op: "eq", path: "grid.size", value: 100 }, scene)).toBe(true);
    expect(evaluatePredicate({ op: "neq", path: "grid.size", value: 100 }, scene)).toBe(false);
  });
  test("truthy / falsy", () => {
    expect(evaluatePredicate({ op: "truthy", path: "tokenVision" }, scene)).toBe(true);
    expect(evaluatePredicate({ op: "falsy", path: "tokenVision" }, scene)).toBe(false);
  });
  test("an unset field compares as UNAVAILABLE, never as false", () => {
    expect(evaluatePredicate({ op: "gte", path: "grid.nope", value: 1 }, scene)).toBe(UNAVAILABLE);
  });
  test("falsy on an unset field is true, because absent is not lit", () => {
    expect(evaluatePredicate({ op: "falsy", path: "environment.globalLight.enabled" }, scene)).toBe(true);
  });
});

describe("collection operators", () => {
  const scene = {
    walls: collection([
      { id: "w1", door: 0, sight: 1 },
      { id: "w2", door: 1, sight: 0 }
    ]),
    tokens: collection([{ id: "t1", sight: { enabled: false } }]),
    lights: collection([])
  };
  test("count_gte", () => {
    expect(evaluatePredicate({ op: "count_gte", path: "walls", value: 2 }, scene)).toBe(true);
    expect(evaluatePredicate({ op: "count_gte", path: "lights", value: 1 }, scene)).toBe(false);
  });
  test("some with a where clause", () => {
    expect(evaluatePredicate({
      op: "some", path: "walls", where: { op: "gte", path: "door", value: 1 }
    }, scene)).toBe(true);
    expect(evaluatePredicate({
      op: "some", path: "tokens", where: { op: "truthy", path: "sight.enabled" }
    }, scene)).toBe(false);
  });
  test("some honours min", () => {
    expect(evaluatePredicate({
      op: "some", path: "walls", where: { op: "gte", path: "sight", value: 1 }, min: 2
    }, scene)).toBe(false);
  });
  test("every and none", () => {
    expect(evaluatePredicate({
      op: "every", path: "walls", where: { op: "exists", path: "id" }
    }, scene)).toBe(true);
    expect(evaluatePredicate({
      op: "none", path: "walls", where: { op: "gte", path: "door", value: 2 }
    }, scene)).toBe(true);
  });
  test("a missing collection is UNAVAILABLE, not a failure", () => {
    expect(evaluatePredicate({ op: "count_gte", path: "regions", value: 1 }, scene)).toBe(UNAVAILABLE);
  });
});

describe("combinators", () => {
  const scene = { grid: { size: 100, type: 0 } };
  test("any_of short-circuits to true", () => {
    expect(evaluatePredicate({
      op: "any_of",
      of: [
        { op: "neq", path: "grid.size", value: 100 },
        { op: "eq", path: "grid.type", value: 0 }
      ]
    }, scene)).toBe(true);
  });
  test("all_of fails on one false branch", () => {
    expect(evaluatePredicate({
      op: "all_of",
      of: [{ op: "eq", path: "grid.size", value: 100 }, { op: "eq", path: "grid.type", value: 1 }]
    }, scene)).toBe(false);
  });
  test("any_of stays UNAVAILABLE when no branch could be read", () => {
    expect(evaluatePredicate({
      op: "any_of",
      of: [{ op: "gte", path: "missing.a", value: 1 }, { op: "gte", path: "missing.b", value: 1 }]
    }, scene)).toBe(UNAVAILABLE);
  });
  test("not inverts, and propagates UNAVAILABLE", () => {
    expect(evaluatePredicate({ op: "not", of: { op: "eq", path: "grid.type", value: 1 } }, scene)).toBe(true);
    expect(evaluatePredicate({ op: "not", of: { op: "gte", path: "missing", value: 1 } }, scene)).toBe(UNAVAILABLE);
  });
});

describe("baseline exclusion", () => {
  const scene = {
    walls: collection([{ id: "shipped1" }, { id: "shipped2" }, { id: "learner1" }])
  };
  test("ignores documents that arrived with the adventure", () => {
    const baseline = new Set(["shipped1", "shipped2"]);
    expect(evaluatePredicate(
      { op: "count_gte", path: "walls", value: 1, excludeBaseline: true }, scene, { baseline }
    )).toBe(true);
    expect(evaluatePredicate(
      { op: "count_gte", path: "walls", value: 2, excludeBaseline: true }, scene, { baseline }
    )).toBe(false);
  });
  test("a learner who added nothing fails a baseline-excluded check", () => {
    const baseline = new Set(["shipped1", "shipped2", "learner1"]);
    expect(evaluatePredicate(
      { op: "count_gte", path: "walls", value: 1, excludeBaseline: true }, scene, { baseline }
    )).toBe(false);
  });
  test("rows without excludeBaseline count everything", () => {
    const baseline = new Set(["shipped1", "shipped2", "learner1"]);
    expect(evaluatePredicate({ op: "count_gte", path: "walls", value: 3 }, scene, { baseline })).toBe(true);
  });
});

describe("bad input", () => {
  test("an unknown op throws rather than passing silently", () => {
    expect(() => evaluatePredicate({ op: "sorcery", path: "a" }, {})).toThrow(/unknown predicate op/);
  });
  test("a predicate with no op throws", () => {
    expect(() => evaluatePredicate({ path: "a" } as any, {})).toThrow(/requires an op/);
  });
  test("an empty combinator throws", () => {
    expect(() => evaluatePredicate({ op: "any_of", of: [] }, {})).toThrow(/non-empty/);
  });
});
