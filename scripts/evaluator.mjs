/**
 * The one generic evaluator.
 *
 * It walks the check rows, resolves each row's scope to a context object,
 * runs the row's predicate, and returns a result per row. There is no
 * per-check code anywhere: a new check is a new row in data/checks.json.
 *
 * Pure with respect to Foundry: the caller supplies the scopes, so this file
 * runs under `bun test` against plain objects.
 */

import { evaluatePredicate, UNAVAILABLE } from "./predicate.mjs";
import { validateTourTargets } from "./tours.mjs";

/** The nine fields every row must carry. `message` states what is missing, `done` what was found,
 * and `topic` names the thing itself, for the case where the check could not be read at all. */
export const REQUIRED_FIELDS = ["id", "week", "competency", "topic", "scope", "predicate", "message", "done", "hint"];

export const STATUS = {
  PASS: "pass",
  OUTSTANDING: "outstanding",
  UNAVAILABLE: "unavailable",
  ERROR: "error"
};

/**
 * Validate a row set. Returns an array of problem strings; empty means valid.
 *
 * Takes the whole set, not a sample of it. Prerequisites are named by id, so
 * whether a named row exists is only answerable about a complete set: run this
 * over a subset and a row whose prerequisite was left out of the subset is
 * reported as naming a row that does not exist.
 */
export function validateChecks(rows) {
  const problems = [];
  if ( !Array.isArray(rows) ) return ["checks must be an array"];
  const seen = new Set();
  rows.forEach((row, index) => {
    const label = row?.id ?? `row ${index}`;
    for ( const field of REQUIRED_FIELDS ) {
      const value = row?.[field];
      const missing = (value === undefined) || (value === null)
        || ((typeof value === "string") && !value.trim());
      if ( missing ) problems.push(`${label}: missing required field \`${field}\``);
    }
    // Typed outside the truthiness guard below, which is what `0` and `false` slip
    // through: both are present, neither is blank, and a falsy id drops the row out
    // of the prerequisite graph entirely. A missing id is already reported above, so
    // this speaks only about one that is there and is the wrong kind of thing.
    const id = row?.id;
    if ( (id !== undefined) && (id !== null) && (typeof id !== "string") ) {
      problems.push(`${label}: \`id\` must be a string`);
    }
    if ( row?.id ) {
      if ( seen.has(row.id) ) problems.push(`${label}: duplicate id`);
      seen.add(row.id);
    }
    if ( row?.predicate && !row.predicate.op ) problems.push(`${label}: predicate has no \`op\``);
  });
  // `tour` is optional: a row with no shipped tour step to point at keeps its
  // text and offers no button. A malformed one is a fault worth reporting.
  problems.push(...validateTourTargets(rows));
  problems.push(...validatePrerequisites(rows));
  return problems;
}

/**
 * Problems in the `needs` graph: a prerequisite that names no row, and a chain of
 * prerequisites that never ends.
 *
 * Why a cycle has to be a validation fault rather than a run-time curiosity. The
 * run holds a row back when its prerequisite is outstanding, which is right, and
 * in a cycle every row in the loop is held back by another one in the loop. The
 * report then says it could not read any of them, offers no next step, and there
 * is no state of the world a GM could reach that clears it. Week order does not
 * prevent it either, since rows inside one week may name each other.
 */
function validatePrerequisites(rows) {
  const problems = [];
  const known = new Set((rows ?? []).map(row => row?.id).filter(id => typeof id === "string"));

  // Edges accumulate per id rather than overwrite. Keyed by id with one value, a
  // second row sharing an id replaced the first row's edge, and a loop running
  // through it was never named: validation reported only the duplicate id while the
  // run stranded every row in the loop.
  const edges = new Map();
  for ( const row of rows ?? [] ) {
    if ( (typeof row?.id !== "string") || !("needs" in row) ) continue;
    const prerequisite = row.needs;
    if ( (prerequisite === null) || (prerequisite === undefined) ) continue;
    if ( typeof prerequisite !== "string" ) {
      problems.push(`row \`${row.id}\`: \`needs\` must be a row id`);
      continue;
    }
    if ( !edges.has(row.id) ) edges.set(row.id, new Set());
    edges.get(row.id).add(prerequisite);
  }

  for ( const [id, prerequisites] of edges ) {
    for ( const prerequisite of prerequisites ) {
      if ( id === prerequisite ) problems.push(`row \`${id}\`: \`needs\` names the row itself`);
      else if ( !known.has(prerequisite) ) {
        problems.push(`row \`${id}\`: \`needs\` names \`${prerequisite}\`, which is not a row in this set`);
      }
    }
  }

  // One report per loop, not one per row in it. The signature joins on a character
  // no row id can contain: joined on `>`, a row id containing `>` collided with a
  // signature and suppressed a real loop.
  // The path is carried by value rather than pushed and popped from a shared set,
  // so this walk calls no removal method on anything. The write-boundary guard in
  // the contract tests scans the source text for document-mutating calls, comments
  // included, and teaching it to ignore a name here would weaken a safety check to
  // fit this code.
  const reportedLoops = new Set();
  const walk = (node, path) => {
    const seenAt = path.indexOf(node);
    if ( seenAt >= 0 ) {
      const loop = path.slice(seenAt);
      if ( loop.length < 2 ) return;
      const signature = [...loop].sort().join("\u0000");
      if ( reportedLoops.has(signature) ) return;
      reportedLoops.add(signature);
      problems.push(`rows \`${loop.join("` -> `")}\` form a prerequisite loop, so none of them can ever be reached`);
      return;
    }
    if ( !edges.has(node) ) return;
    for ( const next of edges.get(node) ) walk(next, [...path, node]);
  };
  for ( const id of edges.keys() ) walk(id, []);
  return problems;
}

/**
 * Run every row.
 *
 * @param {object[]} rows      The check rows.
 * @param {object} scopes      Map of scope name to context object, or null when
 *                             that scope cannot be read right now.
 * @param {object} [options]   Passed through to predicates (e.g. `baseline`).
 * @returns {object[]}         One result per row, in row order.
 */
export function runChecks(rows, scopes, options = {}) {
  // Two passes: a row whose prerequisite row is outstanding is not a gap of its
  // own, it is a step that cannot be taken yet. Reporting it as outstanding puts
  // work in front of a GM that they have no way to do, which is the same mistake
  // as teaching a session before its prerequisite session.
  const first = rows.map(row => evaluateRow(row, scopes, options));
  const outstanding = new Set(first.filter(r => r.status === STATUS.OUTSTANDING).map(r => r.id));
  return first.map(result => {
    if ( result.needs && outstanding.has(result.needs) && (result.status === STATUS.OUTSTANDING) ) {
      return { ...result, status: STATUS.UNAVAILABLE, detail: `waiting on \`${result.needs}\`` };
    }
    return result;
  });
}

/** One row against its scope. Prerequisites are resolved by the caller. */
function evaluateRow(row, scopes, options) {
  const base = {
    id: row.id,
    week: row.week,
    competency: row.competency,
    topic: row.topic,
    scope: row.scope,
    message: row.message,
    done: row.done,
    hint: row.hint,
    needs: row.needs ?? null,
    tour: row.tour ?? null
  };
  // `in` walks the prototype chain, so a row scoped `constructor`, `toString` or
  // `__proto__` resolved to a function off Object.prototype, every path on it
  // missed, and the row reported as a real gap in a GM's report instead of as a
  // broken check. An own-property check is the whole fix.
  if ( !Object.prototype.hasOwnProperty.call(scopes, row.scope) ) {
    return { ...base, status: STATUS.ERROR, detail: `unknown scope \`${row.scope}\`` };
  }
  const context = scopes[row.scope];
  if ( (context === null) || (context === undefined) ) {
    return { ...base, status: STATUS.UNAVAILABLE, detail: `nothing to read for scope \`${row.scope}\`` };
  }
  try {
    const verdict = evaluatePredicate(row.predicate, context, options);
    if ( verdict === UNAVAILABLE ) {
      return { ...base, status: STATUS.UNAVAILABLE, detail: "the field this check reads is not set" };
    }
    return { ...base, status: verdict ? STATUS.PASS : STATUS.OUTSTANDING };
  }
  catch ( err ) {
    return { ...base, status: STATUS.ERROR, detail: err.message };
  }
}

/**
 * Group results for reporting, preserving competency order of first appearance.
 */
export function summarise(results) {
  const byCompetency = new Map();
  for ( const result of results ) {
    if ( !byCompetency.has(result.competency) ) byCompetency.set(result.competency, []);
    byCompetency.get(result.competency).push(result);
  }
  const counts = { pass: 0, outstanding: 0, unavailable: 0, error: 0 };
  for ( const result of results ) counts[result.status] += 1;
  return { counts, byCompetency, total: results.length };
}
