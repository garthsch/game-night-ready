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
import { countsFor, invalidate, WATCHED_DOCUMENTS } from "./state.mjs";
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

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "run", {
    name: "GAME_NIGHT_READY.KeybindingName",
    hint: "GAME_NIGHT_READY.KeybindingHint",
    editable: [{ key: "KeyG", modifiers: ["Control", "Shift"] }],
    restricted: true,
    onDown: () => { run(); return true; }
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
  // Scene controls are built before this await resolves, so the first render
  // saw zero checks and no count. Rebuild them now that the rows are in.
  refresh();
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
    baselineCount: baseline.size,
    onFoundryDefaultScene: scopes.onFoundryDefaultScene
  });
  return results;
}

/* -------------------------------------------- */
/*  The button                                  */
/* -------------------------------------------- */

/**
 * Where the button lives.
 *
 * Not its own control group, though that was the first attempt. Verified in the
 * v14 source: `activeTool` resolution filters out button and toggle tools
 * (`SceneControls##prepareControls`), so a group whose only tool is a button
 * resolves no active tool, and `##postActivate` fires a tool's `onChange` only
 * `if (toolChange && this.tool)`. A button-only group therefore renders and
 * does nothing when clicked.
 *
 * So the button is injected into the groups that already own real tools, and
 * into the three where this work actually happens: placing tokens, tracing
 * walls, placing lights. That keeps it one click away on every layer a GM is on
 * while preparing a scene, without an inert companion tool to make a standalone
 * group fire.
 *
 * The keybinding below is the entry point that works from anywhere, including
 * with no scene open.
 */
const BUTTON_IN = ["tokens", "walls", "lighting"];

Hooks.on("getSceneControlButtons", controls => {
  const counts = currentCounts();
  const outstanding = counts?.outstanding ?? 0;
  const title = outstanding
    ? game.i18n.format("GAME_NIGHT_READY.ButtonTitleCount", { count: outstanding })
    : "GAME_NIGHT_READY.ButtonTitle";

  for ( const groupName of BUTTON_IN ) {
    const group = controls[groupName];
    if ( !group ) continue;
    group.tools ??= {};
    group.tools.gameNightReady = {
      name: "gameNightReady",
      title,
      // Duotone when there is something to say, plain when there is not. This is
      // core's own idiom for a state-carrying control: see
      // SceneControls#_updateNotesIcon, which toggles the Notes icon the same way.
      icon: outstanding
        ? "fa-duotone fa-clipboard-check gnr-has-outstanding"
        : "fa-solid fa-clipboard-check",
      order: Object.keys(group.tools).length,
      button: true,
      visible: game.user.isGM,
      onChange: () => run()
    };
  }
});

/** Counts for the scene being viewed, or null when there is nothing to read. */
function currentCounts() {
  if ( !game?.ready || !CHECKS.length ) return null;
  const scopes = collectScopes();
  if ( !scopes.scene ) return null;
  return countsFor(scopes.scene, CHECKS, scopes, { baseline: baselineIdsFor(scopes.scene) });
}

/**
 * Recompute and re-badge after a document the checks read changes.
 *
 * Debounced because tracing walls emits one create per segment, and every
 * listener here is read-only: none is a `pre*` hook and none returns false.
 */
const refresh = foundry.utils.debounce(() => {
  invalidate();
  ui.controls?.render({ reset: true });
}, 500);

Hooks.once("ready", () => {
  for ( const documentName of WATCHED_DOCUMENTS ) {
    for ( const op of ["create", "update", "delete"] ) {
      Hooks.on(`${op}${documentName}`, refresh);
    }
  }
  Hooks.on("canvasReady", refresh);
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
