/**
 * Passive per-scene state, so the button can show a count without being pressed.
 *
 * Cached per scene id and recomputed when a document the checks read changes.
 * No DOM access: the count is written into the tool's own data fields and the
 * controls are re-rendered with `reset: true`, which is the only way the
 * getSceneControlButtons hook runs again (SceneControls#_configureRenderOptions
 * rebuilds the control record only on `options.reset` or first render).
 */

import { runChecks, summarise } from "./evaluator.mjs";

/** Document types whose changes can alter a check result. */
export const WATCHED_DOCUMENTS = [
  "Scene", "Level", "Wall", "AmbientLight", "Token", "Note", "JournalEntry", "User"
];

const cache = new Map();

/** Drop a scene's cached counts, or all of them. */
export function invalidate(sceneId = null) {
  if ( sceneId ) cache.delete(sceneId);
  else cache.clear();
}

/**
 * Counts for a scene, computed once and reused until something invalidates it.
 * Returns null when there is nothing to read, which the caller shows as no badge.
 */
export function countsFor(scene, checks, scopes, options = {}) {
  if ( !scene?.id ) return null;
  if ( cache.has(scene.id) ) return cache.get(scene.id);
  const counts = summarise(runChecks(checks, scopes, options)).counts;
  cache.set(scene.id, counts);
  return counts;
}

/** Cache size, for tests. */
export function cached() {
  return cache.size;
}
