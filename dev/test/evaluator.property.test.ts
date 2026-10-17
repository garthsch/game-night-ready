import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { runChecks, STATUS, summarise, validateChecks } from "../../scripts/evaluator.mjs";
import { buildReportHtml, nextAction, verdict } from "../../scripts/report.mjs";
import checks from "../../data/checks.json";

/**
 * Property tests for the evaluator and the report it feeds.
 *
 * These state the claims the module makes about itself, over every row set and
 * every count fast-check can build rather than the ones the example tests list:
 * that the name is only said when everything was read and everything passed, that
 * no GM is ever handed a step whose prerequisite is itself outstanding, that the
 * counts in the headline add up to the rows that were run, and that no world,
 * scene or row text can put markup into the report.
 *
 * On a failure: fast-check prints the shrunk counterexample and a seed. Pin the
 * seed in a comment beside the regression example it becomes.
 */

const RUNS = { numRuns: 1000 };

/** See predicate.property.test.ts: an unconstrained record may have no prototype. */
const rec = (shape: any) => fc.record(shape, { noNullPrototype: true });

const STATUSES = [STATUS.PASS, STATUS.OUTSTANDING, STATUS.UNAVAILABLE, STATUS.ERROR];
const COMPETENCIES = ["Canvas preparation", "World setup", "Players and roles", "Content authoring"];

/** A scope context with something readable, something unreadable, and a collection. */
const scopeContext = rec({
  lit: fc.boolean(),
  size: fc.integer({ min: -20, max: 200 }),
  unset: fc.constant(null),
  members: fc.array(rec({ id: fc.string({ minLength: 1, maxLength: 3 }) }), { maxLength: 5 })
});

/** Scopes, any of which may be unreadable right now, which is the normal case. */
const scopes = rec({
  scene: fc.oneof(scopeContext, fc.constant(null)),
  world: fc.oneof(scopeContext, fc.constant(null)),
  user: fc.oneof(scopeContext, fc.constant(null))
});

/** Predicates spanning all four outcomes a row can have, broken rows included. */
const rowPredicate = fc.oneof(
  rec({ op: fc.constantFrom("truthy", "falsy", "exists", "absent"), path: fc.constantFrom("lit", "unset", "gone") }),
  rec({ op: fc.constantFrom("eq", "gte", "lt"), path: fc.constantFrom("size", "unset"), value: fc.integer({ min: -20, max: 200 }) }),
  rec({ op: fc.constant("count_gte"), path: fc.constantFrom("members", "gone"), value: fc.integer({ min: 0, max: 6 }) }),
  // A row the evaluator must contain rather than let through: an unknown operator
  // throws, and the run has to report that row broken and keep going.
  rec({ op: fc.constant("not_an_operator"), path: fc.constant("lit") })
);

const ID = fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom("a", "b", "c", "d", "e", "f") });

/** A row set with unique ids, each row optionally naming another row as its prerequisite. */
const rowSet = fc.uniqueArray(ID, { minLength: 1, maxLength: 8 }).chain(ids => fc.tuple(...ids.map(id => rec({
  id: fc.constant(id),
  week: fc.integer({ min: 1, max: 12 }),
  competency: fc.constantFrom(...COMPETENCIES),
  topic: fc.constant(`TOPIC-${id}`),
  scope: fc.constantFrom("scene", "world", "user", "no_such_scope"),
  predicate: rowPredicate,
  message: fc.constant(`MSG-${id}`),
  done: fc.constant(`DONE-${id}`),
  hint: fc.constant(`HINT-${id}`),
  needs: fc.oneof(fc.constant(null), fc.constantFrom(...ids))
}))) as fc.Arbitrary<any[]>);

/** Counts as the report receives them, with no relationship assumed between them. */
const countSet = rec({
  pass: fc.integer({ min: 0, max: 40 }),
  outstanding: fc.integer({ min: 0, max: 40 }),
  unavailable: fc.integer({ min: 0, max: 40 }),
  error: fc.integer({ min: 0, max: 40 })
});

/** Results as the report receives them, with markers so a sentence can be traced to a row. */
const resultSet = fc.array(ID.chain(id => rec({
  id: fc.constant(id),
  week: fc.integer({ min: 1, max: 12 }),
  competency: fc.constantFrom(...COMPETENCIES),
  topic: fc.constant(`TOPIC(${id})`),
  status: fc.constantFrom(...STATUSES),
  message: fc.constant(`MSG(${id})`),
  done: fc.constant(`DONE(${id})`),
  hint: fc.constant(`HINT(${id})`),
  tour: fc.constant(null),
  detail: fc.oneof(fc.constant(undefined), fc.constant("DETAIL"))
})) as fc.Arbitrary<any>, { minLength: 1, maxLength: 10 });

describe("a run reports on exactly the rows it was given", () => {
  test("one result per row, in row order, whatever the scopes could be read", () => {
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      const results = runChecks(rows, scopeMap);
      expect(results).toHaveLength(rows.length);
      expect(results.map((r: any) => r.id)).toEqual(rows.map((r: any) => r.id));
    }), RUNS);
  });

  test("every result carries one of the four statuses and nothing else", () => {
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      for ( const result of runChecks(rows, scopeMap) ) expect(STATUSES).toContain(result.status);
    }), RUNS);
  });

  test("a row that throws is contained to its own result", () => {
    // The row set generator plants an unknown operator. A thrown predicate must
    // become that row's `error`, never the run's.
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      const results = runChecks(rows, scopeMap);
      const broken = results.filter((r: any) => r.status === STATUS.ERROR);
      for ( const result of broken ) expect(typeof result.detail).toBe("string");
      expect(results.length - broken.length).toBe(rows.length - broken.length);
    }), RUNS);
  });

  test("the display text of each row survives the run unchanged", () => {
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      for ( const result of runChecks(rows, scopeMap) ) {
        expect(result.message).toBe(`MSG-${result.id}`);
        expect(result.done).toBe(`DONE-${result.id}`);
        expect(result.hint).toBe(`HINT-${result.id}`);
        expect(result.topic).toBe(`TOPIC-${result.id}`);
      }
    }), RUNS);
  });
});

describe("no step is put in front of a GM who cannot take it", () => {
  test("no outstanding row's prerequisite is itself outstanding", () => {
    // The product claim behind the two-pass run. Stated over every row set rather
    // than the two the example tests build: if this ever broke, the report would
    // hand someone a step that cannot be done until another step it never named.
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      const results = runChecks(rows, scopeMap);
      const outstanding = new Set(results.filter((r: any) => r.status === STATUS.OUTSTANDING).map((r: any) => r.id));
      for ( const result of results ) {
        if ( result.status !== STATUS.OUTSTANDING ) continue;
        if ( result.needs ) expect(outstanding.has(result.needs)).toBe(false);
      }
    }), RUNS);
  });

  test("holding a row back is the only thing the second pass does", () => {
    // Everything except an outstanding-row-with-an-outstanding-prerequisite has to
    // come through the second pass with the status the first pass gave it.
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      const unlinked = rows.map((r: any) => ({ ...r, needs: null }));
      const direct = runChecks(unlinked, scopeMap);
      const gated = runChecks(rows, scopeMap);
      const firstPass = new Map(direct.map((r: any) => [r.id, r.status]));
      for ( const result of gated ) {
        const before = firstPass.get(result.id);
        if ( result.status === before ) continue;
        // The one legal change, and only in this direction.
        expect(before).toBe(STATUS.OUTSTANDING);
        expect(result.status).toBe(STATUS.UNAVAILABLE);
        expect(result.detail).toContain(result.needs);
      }
    }), RUNS);
  });
});

describe("the counts account for every row", () => {
  test("the four counts sum to the number of results", () => {
    fc.assert(fc.property(resultSet, results => {
      const { counts, total } = summarise(results);
      expect(counts.pass + counts.outstanding + counts.unavailable + counts.error).toBe(results.length);
      expect(total).toBe(results.length);
    }), RUNS);
  });

  test("the competency groups partition the results, losing and duplicating none", () => {
    fc.assert(fc.property(resultSet, results => {
      const { byCompetency } = summarise(results);
      const grouped = [...byCompetency.values()].flat();
      expect(grouped).toHaveLength(results.length);
      expect(new Set(grouped).size).toBe(new Set(results).size);
      for ( const [competency, rows] of byCompetency ) {
        for ( const row of rows ) expect(row.competency).toBe(competency);
      }
    }), RUNS);
  });

  test("groups come back in the order they first appear", () => {
    fc.assert(fc.property(resultSet, results => {
      const expected = [...new Set(results.map((r: any) => r.competency))];
      expect([...summarise(results).byCompetency.keys()]).toEqual(expected);
    }), RUNS);
  });
});

describe("the verdict only says the name when it has been earned", () => {
  test("ready means nothing outstanding, nothing unreadable, nothing broken", () => {
    // The module is named after this sentence, so the sentence is the claim most
    // worth stating universally: there is no count combination that reads ready
    // other than the one where everything was read and everything passed.
    fc.assert(fc.property(countSet, counts => {
      const clean = (counts.outstanding === 0) && (counts.unavailable === 0) && (counts.error === 0);
      expect(verdict(counts).state === "ready").toBe(clean);
      if ( clean ) expect(verdict(counts).label).toBe("Game Night Ready.");
    }), RUNS);
  });

  test("a broken check blocks the claim exactly as an unreadable one does", () => {
    fc.assert(fc.property(countSet, counts => {
      const unread = { ...counts, error: 0, unavailable: counts.unavailable + counts.error };
      expect(verdict(counts).state).toBe(verdict(unread).state);
    }), RUNS);
  });

  test("an incomplete read is always said out loud, never swallowed by a gap count", () => {
    // The failure this guards is the loud-fact-only report: outstanding rows found
    // AND rows that could not be read, with only the first number printed, which
    // implies the module looked at everything.
    fc.assert(fc.property(countSet, counts => {
      const unread = counts.unavailable + counts.error;
      const { label } = verdict(counts);
      if ( unread > 0 ) expect(label).toContain(String(unread));
      if ( counts.outstanding > 0 ) expect(label).toContain(String(counts.outstanding));
    }), RUNS);
  });

  test("a clean read carries no caveat clause", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 40 }), (pass, outstanding) => {
      const label = verdict({ pass, outstanding, unavailable: 0, error: 0 }).label;
      expect(label).not.toContain("could not be read");
    }), RUNS);
  });
});

describe("the next step is the earliest one the GM can actually take", () => {
  test("there is a next step exactly when something is outstanding", () => {
    fc.assert(fc.property(resultSet, results => {
      const any = results.some((r: any) => r.status === STATUS.OUTSTANDING);
      expect(nextAction(results) !== null).toBe(any);
    }), RUNS);
  });

  test("it is an outstanding row, at the earliest outstanding week, first-written on a tie", () => {
    // Oracle: the trivial implementation of the same claim, written here so the
    // real one has something independent to disagree with.
    fc.assert(fc.property(resultSet, results => {
      const outstanding = results.filter((r: any) => r.status === STATUS.OUTSTANDING);
      const next = nextAction(results);
      if ( !outstanding.length ) return;
      const earliest = Math.min(...outstanding.map((r: any) => r.week));
      expect(next.status).toBe(STATUS.OUTSTANDING);
      expect(next.week).toBe(earliest);
      expect(next).toBe(outstanding.find((r: any) => r.week === earliest));
    }), RUNS);
  });

  test("a row the run held back for its prerequisite is never the next step", () => {
    fc.assert(fc.property(rowSet, scopes, (rows, scopeMap) => {
      const results = runChecks(rows, scopeMap);
      const next = nextAction(results);
      if ( !next ) return;
      expect(next.status).toBe(STATUS.OUTSTANDING);
      expect(next.detail).toBeUndefined();
    }), RUNS);
  });
});

describe("nothing a world contains can put markup in the report", () => {
  /** Every tag the report writes for itself. Anything else came from the data. */
  const OWN_TAGS = ["div", "p", "h3", "ul", "li", "span", "strong"];

  /** Text that would break out of the report if it were not escaped. */
  const hostile = fc.oneof(
    fc.string({ maxLength: 24 }),
    fc.constantFrom(
      "<script>alert(1)</script>",
      "\"><img src=x onerror=alert(1)>",
      "</li></ul><h1>injected</h1>",
      "<iframe src=//evil></iframe>",
      "' onmouseover='x",
      "<!-- -->",
      "&lt;script&gt;"
    )
  );

  function tagsIn(html: string) {
    return [...html.matchAll(/<\/?([a-zA-Z][^\s>\/]*)/g)].map(m => m[1].toLowerCase());
  }

  test("a scene, world or step name writes no tag of its own", () => {
    fc.assert(fc.property(resultSet, hostile, hostile, hostile, (results, sceneName, worldTitle, tourLabel) => {
      const html = buildReportHtml(results, { sceneName, worldTitle, tourLabel, baselineCount: 3 });
      for ( const tag of tagsIn(html) ) expect(OWN_TAGS).toContain(tag);
    }), { numRuns: 500 });
  });

  test("row text writes no tag of its own either", () => {
    const hostileResults = fc.array(rec({
      id: ID,
      week: fc.integer({ min: 1, max: 12 }),
      competency: hostile,
      topic: hostile,
      status: fc.constantFrom(...STATUSES),
      message: hostile,
      done: hostile,
      hint: hostile,
      tour: fc.constant(null),
      detail: hostile
    }) as fc.Arbitrary<any>, { minLength: 1, maxLength: 6 });
    fc.assert(fc.property(hostileResults, results => {
      for ( const tag of tagsIn(buildReportHtml(results, { sceneName: "Scene" })) ) {
        expect(OWN_TAGS).toContain(tag);
      }
    }), { numRuns: 500 });
  });
});

describe("each status gets only the sentence it can support", () => {
  test("a passing row never prints its own failure sentence", () => {
    // A done label over a failure sentence asserts the opposite of the finding,
    // which is the one wrong answer a passing row can give.
    fc.assert(fc.property(resultSet, results => {
      const html = buildReportHtml(results, { sceneName: "Scene" });
      for ( const row of results ) {
        if ( row.status !== STATUS.PASS ) continue;
        expect(html).toContain(`DONE(${row.id})`);
      }
      const passOnly = results.filter((r: any) => r.status === STATUS.PASS).map((r: any) => r.id);
      const otherwise = new Set(results.filter((r: any) => r.status !== STATUS.PASS).map((r: any) => r.id));
      for ( const id of passOnly ) {
        if ( otherwise.has(id) ) continue;
        expect(html).not.toContain(`MSG(${id})`);
      }
    }), { numRuns: 500 });
  });

  test("a row that could not be read asserts nothing beyond naming its subject", () => {
    fc.assert(fc.property(resultSet, results => {
      const html = buildReportHtml(results, { sceneName: "Scene" });
      const unread = results.filter((r: any) => (r.status === STATUS.UNAVAILABLE) || (r.status === STATUS.ERROR));
      const elsewhere = new Set(results.filter((r: any) => (r.status === STATUS.PASS) || (r.status === STATUS.OUTSTANDING)).map((r: any) => r.id));
      for ( const row of unread ) {
        if ( elsewhere.has(row.id) ) continue;
        expect(html).toContain(`TOPIC(${row.id})`);
        expect(html).not.toContain(`MSG(${row.id})`);
        expect(html).not.toContain(`DONE(${row.id})`);
      }
    }), { numRuns: 500 });
  });

  test("only an outstanding row gets a hint, because only it has something to do", () => {
    fc.assert(fc.property(resultSet, results => {
      const html = buildReportHtml(results, { sceneName: "Scene" });
      const outstanding = new Set(results.filter((r: any) => r.status === STATUS.OUTSTANDING).map((r: any) => r.id));
      for ( const row of results ) {
        if ( outstanding.has(row.id) ) continue;
        expect(html).not.toContain(`HINT(${row.id})`);
      }
    }), { numRuns: 500 });
  });
});

describe("every required field is load-bearing", () => {
  const REQUIRED = ["id", "week", "competency", "topic", "scope", "predicate", "message", "done", "hint"];

  test("blanking any required field of any shipped row is caught", () => {
    // Acceptance-test mutation against the real row set: a validator that lets a
    // field through empty is a validator that is not checking that field at all.
    fc.assert(fc.property(
      fc.nat({ max: (checks as any[]).length - 1 }),
      fc.constantFrom(...REQUIRED),
      fc.constantFrom("", "   ", null, undefined),
      (index, field, blank) => {
        const rows = (checks as any[]).map((row, i) => (i === index ? { ...row, [field]: blank } : row));
        const problems = validateChecks(rows);
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join("\n")).toContain(field);
      }
    ), RUNS);
  });

  test("a duplicated id is caught wherever the copy sits", () => {
    fc.assert(fc.property(
      fc.nat({ max: (checks as any[]).length - 1 }),
      fc.nat({ max: (checks as any[]).length - 1 }),
      (source, target) => {
        if ( source === target ) return;
        const rows = (checks as any[]).map((row, i) => (i === target ? { ...row, id: (checks as any[])[source].id } : row));
        expect(validateChecks(rows).join("\n")).toContain("duplicate id");
      }
    ), RUNS);
  });

  test("the verdict does not depend on what order the rows are written in", () => {
    fc.assert(fc.property(fc.shuffledSubarray(checks as any[]), shuffled => {
      expect(validateChecks([...shuffled]).sort()).toEqual(validateChecks([...shuffled].reverse()).sort());
    }), { numRuns: 300 });
  });

  test("a well-formed row set of any size reports no problems", () => {
    const wellFormed = fc.uniqueArray(ID, { minLength: 1, maxLength: 8 }).map(ids => ids.map(id => ({
      id,
      week: 1,
      competency: "Canvas preparation",
      topic: `TOPIC(${id})`,
      scope: "scene",
      predicate: { op: "truthy", path: "lit" },
      message: `MSG(${id})`,
      done: `DONE(${id})`,
      hint: `HINT(${id})`
    })));
    fc.assert(fc.property(wellFormed, rows => {
      expect(validateChecks(rows)).toEqual([]);
    }), RUNS);
  });
});

describe("the prerequisite graph is a path, not a loop", () => {
  /** Rows that all fail, wired into a ring so each one waits on the next. */
  function ring(size: number) {
    return Array.from({ length: size }, (_, i) => ({
      id: `r${i}`,
      week: 3,
      competency: "Canvas preparation",
      topic: `TOPIC(r${i})`,
      scope: "scene",
      predicate: { op: "truthy", path: "nothing" },
      message: `MSG(r${i})`,
      done: `DONE(r${i})`,
      hint: `HINT(r${i})`,
      needs: `r${(i + 1) % size}`
    }));
  }

  test("a ring of prerequisites strands every row in it, at any size", () => {
    // Why the shipped-data guard below exists. Each row in a ring is held back for
    // the next, so the whole ring reports as unreadable, the report offers no next
    // step, and there is no state of the world a GM could reach that clears it.
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), size => {
      const results = runChecks(ring(size), { scene: { nothing: false } });
      for ( const result of results ) expect(result.status).toBe(STATUS.UNAVAILABLE);
      expect(nextAction(results)).toBeNull();
    }), { numRuns: 100 });
  });

  test("a ring is refused by validation, at any size", () => {
    // The property above says what a ring does to a run. This says it can no longer
    // get that far: `validateChecks` now walks the `needs` chain and refuses a loop,
    // so a row set like this one fails before it is ever evaluated.
    fc.assert(fc.property(fc.integer({ min: 2, max: 6 }), size => {
      const problems = validateChecks(ring(size));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toContain("prerequisite loop");
    }), { numRuns: 100 });
  });

  test("a loop is reported once, not once per row in it", () => {
    const loops = validateChecks(ring(4)).filter(p => p.includes("prerequisite loop"));
    expect(loops).toHaveLength(1);
  });

  test("a row naming itself is refused, and named as itself", () => {
    expect(validateChecks(ring(1)).join("\n")).toContain("names the row itself");
  });

  test("a prerequisite that names no row at all is refused", () => {
    const rows = ring(2);
    rows[0].needs = "nothing_named_this";
    expect(validateChecks(rows).join("\n")).toContain("not a row in this set");
  });

  test("a chain that ends is not a loop", () => {
    // The shape the shipped rows use: several rows onto one prerequisite that has
    // none of its own. Nothing here may be reported.
    const rows = ring(3);
    rows[2].needs = null;
    expect(validateChecks(rows).filter((p: string) => p.includes("loop"))).toEqual([]);
  });

  test("no shipped row waits on itself", () => {
    for ( const row of checks as any[] ) expect(row.needs).not.toBe(row.id);
  });

  test("following the shipped prerequisites always ends", () => {
    const needs = new Map((checks as any[]).map(row => [row.id, row.needs ?? null]));
    for ( const start of needs.keys() ) {
      const walked = new Set<string>();
      let at: string | null = start;
      while ( at ) {
        expect(walked.has(at)).toBe(false);
        walked.add(at);
        at = needs.get(at) ?? null;
      }
    }
  });
});
