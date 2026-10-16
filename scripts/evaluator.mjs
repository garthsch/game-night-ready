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
    if ( row?.id ) {
      if ( seen.has(row.id) ) problems.push(`${label}: duplicate id`);
      seen.add(row.id);
    }
    if ( row?.predicate && !row.predicate.op ) problems.push(`${label}: predicate has no \`op\``);
  });
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
    needs: row.needs ?? null
  };
  if ( !(row.scope in scopes) ) {
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
