import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { evaluatePredicate, resolvePath, toMembers, UNAVAILABLE } from "../../scripts/predicate.mjs";

/**
 * Property tests for the predicate language.
 *
 * The example tests next door check the operators on the inputs their author
 * thought of. These state the laws the language is supposed to obey, over every
 * input fast-check can build: a predicate tree is generated, evaluated against a
 * generated context, and the verdict is compared with the verdict of a predicate
 * that should mean the same thing.
 *
 * Why laws rather than more examples. The language is three-valued -- true, false,
 * and UNAVAILABLE for "the thing this reads is not there to read" -- and the whole
 * honesty of the report rests on that third value propagating instead of collapsing
 * into false. A collapse is exactly what an example suite misses, because it only
 * shows up when an unreadable branch meets a readable one, and there are more of
 * those combinations than anyone writes out by hand.
 *
 * On a failure: fast-check prints the shrunk counterexample and a seed. Pin the
 * seed in a comment beside the regression example it becomes.
 */

const RUNS = { numRuns: 1000 };

/**
 * Records, with prototypes.
 *
 * `fc.record` is free to hand back null-prototype objects, and one of those has no
 * `toString`, so `Number([obj])` throws where a real document coerces to NaN. That
 * is a fault in the generator rather than in the module: every value these rows read
 * is a Foundry document or a plain field off one, and all of them have a prototype.
 * Left unconstrained it reports a throw the running module cannot reach, which is the
 * under-constrained-generator failure the Hardening workflow warns about.
 */
const rec = (shape: any) => fc.record(shape, { noNullPrototype: true });

/** Three-valued verdict as a printable tag, so a failure message reads. */
function tag(verdict: unknown) {
  return (verdict === UNAVAILABLE) ? "unavailable" : String(verdict);
}

/** Members carry a readable flag, an unreadable one, and an id the baseline can name. */
const member = rec({
  id: fc.string({ minLength: 1, maxLength: 4 }),
  lit: fc.oneof(fc.boolean(), fc.constant(null)),
  size: fc.integer({ min: -20, max: 200 })
});

/**
 * A context with a field of every shape a row meets: present, falsy-but-present,
 * explicitly null, absent, and a collection.
 */
const context = rec({
  lit: fc.boolean(),
  size: fc.integer({ min: -50, max: 200 }),
  name: fc.string({ maxLength: 8 }),
  zero: fc.constant(0),
  unset: fc.constant(null),
  members: fc.array(member, { maxLength: 6 })
});

/** Paths that hit something, paths that hit null, and paths that hit nothing at all. */
const ANY_PATH = fc.constantFrom("lit", "size", "name", "zero", "unset", "missing", "nested.deep", "members");
const NUMERIC_PATH = fc.constantFrom("size", "zero");
// `name` is in here deliberately. It was absent, and that absence hid a real
// fault: a string is iterable, so a collection operator on a text field counted
// characters. Every collection property was blind to the case it most needed.
const COLLECTION_PATH = fc.constantFrom("members", "missing", "size", "name");

/** A where clause, read against a member rather than the context. */
const where = fc.oneof(
  rec({ op: fc.constantFrom("truthy", "falsy", "exists", "absent"), path: fc.constantFrom("lit", "size", "gone") }),
  rec({ op: fc.constantFrom("eq", "gte", "lt"), path: fc.constantFrom("lit", "size", "gone"), value: fc.integer({ min: -20, max: 200 }) })
);

const leaf = fc.oneof(
  rec({ op: fc.constantFrom("exists", "absent", "truthy", "falsy"), path: ANY_PATH }),
  rec({
    op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte"),
    path: ANY_PATH,
    value: fc.oneof(fc.integer({ min: -50, max: 200 }), fc.boolean(), fc.string({ maxLength: 4 }))
  }),
  rec({ op: fc.constant("in"), path: ANY_PATH, value: fc.array(fc.integer({ min: -50, max: 200 }), { maxLength: 4 }) }),
  rec({ op: fc.constant("count_gte"), path: COLLECTION_PATH, value: fc.integer({ min: 0, max: 8 }) }),
  rec({ op: fc.constantFrom("some", "none"), path: COLLECTION_PATH, where, min: fc.integer({ min: 1, max: 4 }) }),
  rec({ op: fc.constant("every"), path: COLLECTION_PATH, where })
);

/** Predicate trees, combinators included, bounded so a run stays fast. */
const { predicate } = fc.letrec(tie => ({
  predicate: fc.oneof(
    { maxDepth: 3, depthIdentifier: "predicate" },
    leaf,
    rec({ op: fc.constant("not"), of: tie("predicate") }),
    rec({
      op: fc.constantFrom("any_of", "all_of"),
      of: fc.array(tie("predicate"), { minLength: 1, maxLength: 3 })
    })
  )
})) as { predicate: fc.Arbitrary<any> };

describe("resolvePath is total", () => {
  // Every path in a check row is author-written and read against whatever Foundry
  // hands back, so a path that misses has to return nothing rather than throw: a
  // throw inside a predicate is reported as a broken check, which is a worse
  // answer than "could not read this".
  test("no context and path pair makes it throw", () => {
    fc.assert(fc.property(
      fc.oneof(context, fc.anything(), fc.constant(null), fc.constant(undefined)),
      fc.oneof(fc.string({ maxLength: 12 }), fc.constant(""), ANY_PATH),
      (ctx, path) => { resolvePath(ctx, path); }
    ), RUNS);
  });

  test("an empty path is the identity, for every context", () => {
    fc.assert(fc.property(fc.anything(), ctx => {
      expect(resolvePath(ctx, "")).toBe(ctx);
    }), RUNS);
  });
});

describe("toMembers conserves membership", () => {
  test("an array comes back as itself", () => {
    fc.assert(fc.property(fc.array(member, { maxLength: 8 }), arr => {
      expect(toMembers(arr)).toBe(arr);
    }), RUNS);
  });

  test("a Foundry-shaped collection yields exactly its contents, in order", () => {
    fc.assert(fc.property(fc.array(member, { maxLength: 8 }), members => {
      const map = new Map(members.map((m, i) => [m.id || String(i), m]));
      const collection = Object.assign(map, { get contents() { return members; } });
      expect(toMembers(collection)).toEqual(members);
    }), RUNS);
  });

  test("a Set yields the same member count", () => {
    fc.assert(fc.property(fc.array(member, { maxLength: 8 }), members => {
      const set = new Set(members);
      expect(toMembers(set)).toHaveLength(set.size);
    }), RUNS);
  });

  test("nothing readable as a collection is UNAVAILABLE, never an empty array", () => {
    // The distinction is the whole point: an empty collection is a finding, an
    // unreadable one is not, and reporting the second as the first invents a gap.
    fc.assert(fc.property(
      fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined),
        fc.double({ noNaN: true }), fc.string()),
      value => {
        expect(toMembers(value)).toBe(UNAVAILABLE);
      }
    ), RUNS);
  });
});

describe("a text field is not a collection", () => {
  test("no string is readable as members, however long", () => {
    // A string is iterable, so this returned one member per character until
    // `toMembers` guarded it. The law above was written without strings in its
    // generator, so it passed while being false.
    fc.assert(fc.property(fc.string(), value => {
      expect(toMembers(value)).toBe(UNAVAILABLE);
    }), RUNS);
  });

  test("a collection operator on a text field reads as unavailable, not as a count", () => {
    // The fabricated pass this prevents: `count_gte 1` on a scene named "Keep"
    // reported four members and passed, and an empty name reported a gap.
    fc.assert(fc.property(fc.string(), fc.integer({ min: 0, max: 4 }), (name, value) => {
      const ctx = { name };
      expect(evaluatePredicate({ op: "count_gte", path: "name", value }, ctx)).toBe(UNAVAILABLE);
      expect(evaluatePredicate({ op: "every", path: "name", where: { op: "truthy", path: "x" } }, ctx))
        .toBe(UNAVAILABLE);
      expect(evaluatePredicate({ op: "some", path: "name", where: { op: "truthy", path: "x" }, min: 1 }, ctx))
        .toBe(UNAVAILABLE);
    }), RUNS);
  });
});

describe("the predicate language is total on well-formed rows", () => {
  test("every generated predicate returns true, false, or UNAVAILABLE", () => {
    fc.assert(fc.property(predicate, context, (p, ctx) => {
      const verdict = evaluatePredicate(p, ctx);
      expect(verdict === true || verdict === false || verdict === UNAVAILABLE).toBe(true);
    }), RUNS);
  });
});

describe("three-valued logic laws", () => {
  test("not is an involution: not(not(p)) means p", () => {
    fc.assert(fc.property(predicate, context, (p, ctx) => {
      const once = evaluatePredicate({ op: "not", of: { op: "not", of: p } }, ctx);
      expect(tag(once)).toBe(tag(evaluatePredicate(p, ctx)));
    }), RUNS);
  });

  test("De Morgan holds across the unavailable value: not(any_of) means all_of(not)", () => {
    // The law that would break first if UNAVAILABLE ever collapsed to false.
    fc.assert(fc.property(fc.array(predicate, { minLength: 1, maxLength: 3 }), context, (ps, ctx) => {
      const left = evaluatePredicate({ op: "not", of: { op: "any_of", of: ps } }, ctx);
      const right = evaluatePredicate({ op: "all_of", of: ps.map(p => ({ op: "not", of: p })) }, ctx);
      expect(tag(left)).toBe(tag(right));
    }), RUNS);
  });

  test("and its dual: not(all_of) means any_of(not)", () => {
    fc.assert(fc.property(fc.array(predicate, { minLength: 1, maxLength: 3 }), context, (ps, ctx) => {
      const left = evaluatePredicate({ op: "not", of: { op: "all_of", of: ps } }, ctx);
      const right = evaluatePredicate({ op: "any_of", of: ps.map(p => ({ op: "not", of: p })) }, ctx);
      expect(tag(left)).toBe(tag(right));
    }), RUNS);
  });

  test("combinators do not care what order their branches are written in", () => {
    fc.assert(fc.property(
      fc.array(predicate, { minLength: 2, maxLength: 4 }),
      context,
      fc.constantFrom("any_of", "all_of"),
      (ps, ctx, op) => {
        const forward = evaluatePredicate({ op, of: ps }, ctx);
        const back = evaluatePredicate({ op, of: [...ps].reverse() }, ctx);
        expect(tag(forward)).toBe(tag(back));
      }
    ), RUNS);
  });

  test("a branch repeated says no more than the branch alone", () => {
    fc.assert(fc.property(predicate, context, fc.constantFrom("any_of", "all_of"), (p, ctx, op) => {
      expect(tag(evaluatePredicate({ op, of: [p, p] }, ctx))).toBe(tag(evaluatePredicate(p, ctx)));
    }), RUNS);
  });

  test("nesting a combinator inside itself means flattening it", () => {
    fc.assert(fc.property(
      predicate, predicate, predicate, context, fc.constantFrom("any_of", "all_of"),
      (a, b, c, ctx, op) => {
        const nested = evaluatePredicate({ op, of: [{ op, of: [a, b] }, c] }, ctx);
        const flat = evaluatePredicate({ op, of: [a, b, c] }, ctx);
        expect(tag(nested)).toBe(tag(flat));
      }
    ), RUNS);
  });
});

describe("operator pairs are each other's negation", () => {
  test("exists and absent, on every path", () => {
    fc.assert(fc.property(ANY_PATH, context, (path, ctx) => {
      const exists = evaluatePredicate({ op: "exists", path }, ctx);
      const absent = evaluatePredicate({ op: "absent", path }, ctx);
      // Both are total: presence is always readable, even when the value is not.
      expect(exists).toBe(!absent);
    }), RUNS);
  });

  test("truthy and falsy, on every path", () => {
    fc.assert(fc.property(ANY_PATH, context, (path, ctx) => {
      expect(evaluatePredicate({ op: "truthy", path }, ctx))
        .toBe(!evaluatePredicate({ op: "falsy", path }, ctx));
    }), RUNS);
  });

  test("eq and neq agree on which fields they cannot read", () => {
    fc.assert(fc.property(
      ANY_PATH, fc.oneof(fc.integer({ min: -50, max: 200 }), fc.boolean(), fc.string({ maxLength: 4 })), context,
      (path, value, ctx) => {
        const eq = evaluatePredicate({ op: "eq", path, value }, ctx);
        const neq = evaluatePredicate({ op: "neq", path, value }, ctx);
        if ( eq === UNAVAILABLE ) expect(neq).toBe(UNAVAILABLE);
        else expect(eq).toBe(!neq);
      }
    ), RUNS);
  });

  test("the ordering comparators are dual on the numbers rows actually compare", () => {
    // Constrained to numeric fields and numeric comparands on purpose: that is the
    // domain the operators are for. See the non-numeric case below, which is a
    // separate claim rather than a wider version of this one.
    fc.assert(fc.property(NUMERIC_PATH, fc.integer({ min: -50, max: 200 }), context, (path, value, ctx) => {
      expect(evaluatePredicate({ op: "gt", path, value }, ctx))
        .toBe(!evaluatePredicate({ op: "lte", path, value }, ctx));
      expect(evaluatePredicate({ op: "gte", path, value }, ctx))
        .toBe(!evaluatePredicate({ op: "lt", path, value }, ctx));
    }), RUNS);
  });

  test("a comparison that is not a number at all is false either way round", () => {
    // Number("Caves of Chaos") is NaN, and every NaN comparison is false, so a row
    // comparing a text field with an ordering operator reports a gap that passing
    // the opposite row would also report. Stated here so the behaviour is a known
    // property of the language rather than a surprise in a row someone writes later.
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 6 }).filter(s => Number.isNaN(Number(s))),
      fc.integer({ min: -50, max: 200 }),
      (name, value) => {
        const ctx = { name };
        for ( const op of ["gt", "gte", "lt", "lte"] ) {
          expect(evaluatePredicate({ op, path: "name", value }, ctx)).toBe(false);
        }
      }
    ), RUNS);
  });

  test("some and none are each other's negation, for the same where clause", () => {
    fc.assert(fc.property(COLLECTION_PATH, where, context, (path, w, ctx) => {
      const some = evaluatePredicate({ op: "some", path, where: w, min: 1 }, ctx);
      const none = evaluatePredicate({ op: "none", path, where: w }, ctx);
      if ( some === UNAVAILABLE ) expect(none).toBe(UNAVAILABLE);
      else expect(some).toBe(!none);
    }), RUNS);
  });

  test("every implies none-of-the-opposite, but is not implied by it", () => {
    // One-directional on purpose. `every` demands the clause be true of every
    // member; `none` of the negation is satisfied by a member the clause could not
    // read at all. The implication is the part that holds.
    fc.assert(fc.property(COLLECTION_PATH, where, context, (path, w, ctx) => {
      const every = evaluatePredicate({ op: "every", path, where: w }, ctx);
      if ( every !== true ) return;
      expect(evaluatePredicate({ op: "none", path, where: { op: "not", of: w } }, ctx)).toBe(true);
    }), RUNS);
  });
});

describe("counting is monotone", () => {
  test("a collection that clears a high bar clears every lower one", () => {
    fc.assert(fc.property(
      fc.array(member, { maxLength: 10 }),
      fc.integer({ min: 0, max: 12 }),
      fc.integer({ min: 0, max: 12 }),
      (members, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const ctx = { members };
        if ( evaluatePredicate({ op: "count_gte", path: "members", value: high }, ctx) === true ) {
          expect(evaluatePredicate({ op: "count_gte", path: "members", value: low }, ctx)).toBe(true);
        }
      }
    ), RUNS);
  });

  test("adding members never turns a met count into an unmet one", () => {
    fc.assert(fc.property(
      fc.array(member, { maxLength: 8 }), fc.array(member, { maxLength: 4 }), fc.integer({ min: 0, max: 8 }),
      (members, extra, value) => {
        const p = { op: "count_gte", path: "members", value };
        if ( evaluatePredicate(p, { members }) !== true ) return;
        expect(evaluatePredicate(p, { members: [...members, ...extra] })).toBe(true);
      }
    ), RUNS);
  });

  test("ignoring the adventure baseline can only make a count harder to meet", () => {
    // The baseline filter exists so a re-run grades what the learner added. It
    // removes members and never adds any, so it must never manufacture a pass.
    fc.assert(fc.property(
      fc.array(member, { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 0, max: 8 }),
      fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 6 }),
      (members, value, baselineIds) => {
        const ctx = { members };
        const baseline = new Set(baselineIds);
        const filtered = { op: "count_gte", path: "members", value, excludeBaseline: true };
        const unfiltered = { op: "count_gte", path: "members", value };
        if ( evaluatePredicate(filtered, ctx, { baseline }) !== true ) return;
        expect(evaluatePredicate(unfiltered, ctx, {})).toBe(true);
      }
    ), RUNS);
  });

  test("the same holds for a some clause", () => {
    fc.assert(fc.property(
      fc.array(member, { minLength: 1, maxLength: 8 }),
      where,
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 6 }),
      (members, w, min, baselineIds) => {
        const ctx = { members };
        const baseline = new Set(baselineIds);
        const filtered = { op: "some", path: "members", where: w, min, excludeBaseline: true };
        const unfiltered = { op: "some", path: "members", where: w, min };
        if ( evaluatePredicate(filtered, ctx, { baseline }) !== true ) return;
        expect(evaluatePredicate(unfiltered, ctx, {})).toBe(true);
      }
    ), RUNS);
  });

  test("excluding the baseline removes exactly the baseline members", () => {
    // The two monotonicity properties above both survive a `filterBaseline` that
    // keeps only the baseline members, because either way the result is a subset.
    // This states the equality instead, which is the claim that mutant breaks.
    fc.assert(fc.property(
      fc.array(member, { maxLength: 8 }),
      fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 6 }),
      fc.integer({ min: 0, max: 9 }),
      (members, baselineIds, value) => {
        const baseline = new Set(baselineIds);
        const expected = members.filter(m => !baseline.has(m.id)).length;
        const verdict = evaluatePredicate(
          { op: "count_gte", path: "members", value, excludeBaseline: true },
          { members },
          { baseline }
        );
        expect(verdict).toBe(expected >= value);
      }
    ), RUNS);
  });

  test("an empty baseline changes no verdict at all", () => {
    fc.assert(fc.property(predicate, context, (p, ctx) => {
      const marked = { ...p, excludeBaseline: true };
      expect(tag(evaluatePredicate(marked, ctx, { baseline: new Set() })))
        .toBe(tag(evaluatePredicate(p, ctx, {})));
    }), RUNS);
  });
});

describe("malformed rows throw rather than passing quietly", () => {
  test("an op the language does not have is never a verdict", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 8 }).filter(s => ![
        "exists", "absent", "truthy", "falsy", "eq", "neq", "gt", "gte", "lt", "lte",
        "in", "count_gte", "some", "every", "none", "any_of", "all_of", "not"
      ].includes(s)),
      context,
      (op, ctx) => {
        expect(() => evaluatePredicate({ op, path: "lit" }, ctx)).toThrow();
      }
    ), RUNS);
  });

  test("an empty combinator throws however deep it is buried", () => {
    fc.assert(fc.property(context, fc.constantFrom("any_of", "all_of"), (ctx, op) => {
      expect(() => evaluatePredicate({ op: "not", of: { op, of: [] } }, ctx)).toThrow();
    }), RUNS);
  });
});
