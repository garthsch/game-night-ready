/**
 * Game Night Ready — entry point.
 *
 * One button. It reads the document model, runs the data rows, and reports what
 * is still outstanding in the scene you are looking at.
 *
 * It never blocks anything: no hook here cancels, gates or modifies a document.
 */

import { runChecks, validateChecks } from "./evaluator.mjs";
import { collectScopes, MODULE_ID } from "./scopes.mjs";
import { showReport } from "./report.mjs";

const SETTINGS = {
  BASELINE: "adventureBaseline"
};

let CHECKS = [];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.BASELINE, {
    name: "Imported adventure baseline",
    hint: "Document ids that arrived with an imported adventure, recorded so a later run reports what you added.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
});

Hooks.once("ready", async () => {
  CHECKS = await loadChecks();
  const problems = validateChecks(CHECKS);
  if ( problems.length ) {
    console.error(`${MODULE_ID} | invalid check rows:\n${problems.join("\n")}`);
    ui.notifications?.error(`Game Night Ready: ${problems.length} invalid check row(s). See the console.`);
  }
  // Callable from a macro or the console, for anyone who prefers not to hunt for a button.
  game.modules.get(MODULE_ID).api = { run, checks: () => CHECKS };
  console.log(`${MODULE_ID} | ready with ${CHECKS.length} checks`);
});

async function loadChecks() {
  try {
    // getRoute keeps this correct behind a routePrefix, where a relative path would 404.
    const url = foundry.utils.getRoute(`modules/${MODULE_ID}/data/checks.json`);
    const response = await fetch(url);
    if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
  catch ( err ) {
    console.error(`${MODULE_ID} | could not load check rows:`, err);
    ui.notifications?.error("Game Night Ready could not load its check rows.");
    return [];
  }
}

/** Run every check against the current world and scene, and show the report. */
export async function run() {
  if ( !CHECKS.length ) {
    ui.notifications?.warn("Game Night Ready has no check rows loaded.");
    return null;
  }
  const scopes = collectScopes();
  const baseline = baselineIdsFor(scopes.scene);
  const results = runChecks(CHECKS, scopes, { baseline });
  await showReport(results, {
    sceneName: scopes.scene?.name ?? null,
    worldTitle: game.world?.title ?? null,
    baselineCount: baseline.size
  });
  return results;
}

/* -------------------------------------------- */
/*  The button                                  */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", controls => {
  const tokens = controls.tokens;
  if ( !tokens ) return;
  tokens.tools ??= {};
  tokens.tools.gameNightReady = {
    name: "gameNightReady",
    title: "GAME_NIGHT_READY.ButtonTitle",
    icon: "fa-solid fa-clipboard-check",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => run()
  };
});

/* -------------------------------------------- */
/*  Per-learner baseline                        */
/* -------------------------------------------- */

/**
 * Record what an imported adventure brought in, so a later run can report what
 * the learner added rather than what shipped.
 */
Hooks.on("importAdventure", (adventure, _options, created) => {
  if ( !game.user.isGM ) return;
  const stored = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.BASELINE)) ?? {};
  for ( const [documentName, documents] of Object.entries(created ?? {}) ) {
    for ( const doc of documents ?? [] ) {
      collectBaselineIds(stored, documentName, doc);
    }
  }
  stored._meta = { adventure: adventure?.name ?? null, recordedAt: new Date().toISOString() };
  game.settings.set(MODULE_ID, SETTINGS.BASELINE, stored);
  console.log(`${MODULE_ID} | recorded adventure baseline for "${adventure?.name}"`);
});

/**
 * A Scene's baseline is keyed by scene id, because that is the granularity the
 * canvas checks read at. World-level documents are keyed under `world`.
 */
function collectBaselineIds(stored, documentName, doc) {
  if ( documentName === "Scene" ) {
    const ids = [];
    for ( const collection of ["walls", "lights", "tokens", "notes", "sounds", "tiles", "regions", "drawings"] ) {
      for ( const embedded of doc[collection] ?? [] ) ids.push(embedded.id);
    }
    stored[doc.id] = Array.from(new Set([...(stored[doc.id] ?? []), ...ids]));
    return;
  }
  stored.world = Array.from(new Set([...(stored.world ?? []), doc.id]));
}

function baselineIdsFor(scene) {
  const stored = game.settings.get(MODULE_ID, SETTINGS.BASELINE) ?? {};
  const ids = [...(stored.world ?? []), ...(scene?.id ? (stored[scene.id] ?? []) : [])];
  return new Set(ids);
}
