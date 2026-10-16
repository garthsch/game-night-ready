/**
 * Predicate evaluation over the Foundry document model.
 *
 * Pure: takes a plain context object and a predicate row, returns a verdict.
 * Knows nothing about Foundry globals, so it runs under `bun test` unchanged.
 *
 * Every check in data/checks.json is expressed with the operators below.
 * Adding a check means adding a row. Adding an operator is a deliberate,
 * rare change to this file.
 */

/** Marker returned when the thing a predicate needs is not present to be read. */
export const UNAVAILABLE = Symbol("unavailable");

/**
 * Resolve a dot path against a context object, unwrapping Foundry collections.
 * `walls` on a Scene is an EmbeddedCollection: iterable, Map-like, with `.contents`.
 * A path segment that misses returns undefined rather than throwing.
 */
export function resolvePath(context, path) {
  if ( !path ) return context;
  let value = context;
  for ( const segment of path.split(".") ) {
    if ( (value === null) || (value === undefined) ) return undefined;
    value = readSegment(value, segment);
  }
  return value;
}

function readSegment(value, segment) {
  // Foundry documents expose schema fields as own/prototype properties.
  if ( typeof value.get === "function" && !(segment in value) ) {
    const viaGet = value.get(segment);
    if ( viaGet !== undefined ) return viaGet;
  }
  return value[segment];
}

/**
 * Coerce a resolved value to an array of members, or UNAVAILABLE if it is not
 * a collection at all. Handles arrays, Maps, EmbeddedCollections and Sets.
 */
export function toMembers(value) {
  if ( (value === null) || (value === undefined) ) return UNAVAILABLE;
  if ( Array.isArray(value) ) return value;
  if ( Array.isArray(value.contents) ) return value.contents;
  if ( typeof value.values === "function" ) return Array.from(value.values());
  if ( typeof value[Symbol.iterator] === "function" ) return Array.from(value);
  return UNAVAILABLE;
}

const COMPARATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b)
};

/**
 * Evaluate one predicate against a context.
 * @returns {boolean|typeof UNAVAILABLE}
 */
export function evaluatePredicate(predicate, context, options = {}) {
  if ( !predicate || !predicate.op ) throw new Error("predicate requires an op");
  const { op } = predicate;

  // Combinators recurse before any path resolution.
  if ( op === "any_of" ) return combine(predicate, context, options, "any");
  if ( op === "all_of" ) return combine(predicate, context, options, "all");
  if ( op === "not" ) {
    const inner = evaluatePredicate(predicate.of, context, options);
    return (inner === UNAVAILABLE) ? UNAVAILABLE : !inner;
  }

  const value = resolvePath(context, predicate.path);

  switch ( op ) {
    case "exists": return (value !== null) && (value !== undefined);
    case "absent": return (value === null) || (value === undefined);
    case "truthy": return !!value;
    case "falsy": return !value;
    case "eq": case "neq": case "gt": case "gte": case "lt": case "lte": {
      if ( (value === null) || (value === undefined) ) return UNAVAILABLE;
      return COMPARATORS[op](value, predicate.value);
    }
    case "in": {
      if ( !Array.isArray(predicate.value) ) throw new Error("`in` requires an array value");
      return predicate.value.includes(value);
    }
    case "count_gte": case "some": case "every": case "none": {
      const members = filterBaseline(toMembers(value), predicate, options);
      if ( members === UNAVAILABLE ) return UNAVAILABLE;
      return evaluateCollection(op, predicate, members, options);
    }
    default:
      throw new Error(`unknown predicate op: ${op}`);
  }
}

function combine(predicate, context, options, mode) {
  const branches = predicate.of ?? [];
  if ( !branches.length ) throw new Error(`${predicate.op} requires a non-empty \`of\` array`);
  const results = branches.map(b => evaluatePredicate(b, context, options));
  const decided = results.filter(r => r !== UNAVAILABLE);
  if ( mode === "any" ) {
    if ( decided.some(r => r === true) ) return true;
    return decided.length === results.length ? false : UNAVAILABLE;
  }
  if ( decided.some(r => r === false) ) return false;
  return decided.length === results.length ? true : UNAVAILABLE;
}

function evaluateCollection(op, predicate, members, options) {
  if ( op === "count_gte" ) return members.length >= Number(predicate.value ?? 1);
  const where = predicate.where;
  const matches = where
    ? members.filter(m => evaluatePredicate(where, m, options) === true)
    : members;
  if ( op === "some" ) return matches.length >= Number(predicate.min ?? 1);
  if ( op === "none" ) return matches.length === 0;
  return matches.length === members.length; // every
}

/**
 * Drop members that arrived with an imported Adventure, so a re-run reports
 * what the learner added rather than what shipped (ISC-28).
 */
function filterBaseline(members, predicate, options) {
  if ( members === UNAVAILABLE ) return UNAVAILABLE;
  if ( !predicate.excludeBaseline ) return members;
  const baseline = options.baseline;
  if ( !baseline || !baseline.size ) return members;
  return members.filter(m => !baseline.has(m?.id ?? m?._id));
}
