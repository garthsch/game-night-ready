/**
 * Taking a GM to the control a check is about.
 *
 * Foundry ships eight tours and maintains their selectors for its own onboarding.
 * A row names one of them plus a step id, and the report starts that tour on that
 * step. The tours do the work themselves: `CanvasTour._preStep` calls
 * `ui.controls.activate()`, so the wall tool is already selected when the step
 * renders, and `SidebarTour._preStep` opens the right sidebar tab.
 *
 * Nothing here authors a tour step. That is the whole reason this is cheap to
 * keep: the DOM selectors belong upstream, who have to keep them working for
 * their own new-user experience. A step this module writes would put us back on
 * the selector treadmill that made a hand-written tour the wrong shape.
 *
 * Resolution is by step id rather than index, so a step inserted upstream keeps
 * working and a step removed upstream is reported rather than thrown. That is
 * the breakage detection a hand-bound tour never had.
 */

import { MODULE_ID } from "./scopes.mjs";

/**
 * The tours Foundry registers in `client/nue/_module.mjs`. A row may only point
 * at one of these: a row pointing at a module's tour would make this module
 * depend on that module being installed.
 */
export const SHIPPED_TOURS = Object.freeze([
  "core.backupsOverview",
  "core.canvasControls",
  "core.compatOverview",
  "core.creatingAWorld",
  "core.installingASystem",
  "core.sidebar",
  "core.uiOverview",
  "core.welcome"
]);

/**
 * The step's position in the tour, or -1 when the tour has no such step.
 * @param {object[]} steps   A tour's steps, in order.
 * @param {string} stepId    The step id a row names.
 * @returns {number}
 */
export function findStepIndex(steps, stepId) {
  if ( !Array.isArray(steps) ) return -1;
  return steps.findIndex(step => step?.id === stepId);
}

/**
 * Shape problems in the optional `tour` field of each row.
 *
 * Shape only. Whether the step still exists is a question about the running
 * Foundry, answered by `resolveTourTarget` at the moment the report is built.
 *
 * @param {object[]} rows
 * @returns {string[]}  One message per problem, empty when every row is well-formed.
 */
export function validateTourTargets(rows) {
  const problems = [];
  for ( const row of rows ?? [] ) {
    if ( !("tour" in row) ) continue;
    const target = row.tour;
    if ( !target || (typeof target !== "object") ) {
      problems.push(`row \`${row.id}\`: \`tour\` must be an object with \`id\` and \`step\``);
      continue;
    }
    if ( !SHIPPED_TOURS.includes(target.id) ) {
      problems.push(`row \`${row.id}\`: \`tour.id\` \`${target.id}\` is not a tour Foundry ships`);
    }
    if ( !target.step || (typeof target.step !== "string") ) {
      problems.push(`row \`${row.id}\`: \`tour.step\` must be a step id`);
    }
  }
  return problems;
}

/**
 * The tour and step a row points at, ready to start, or null when it cannot run.
 *
 * Two different nulls, deliberately logged differently. A missing tour or step is
 * breakage worth a console warning, because it means an upstream rename landed.
 * A tour that simply cannot start right now is not breakage: `CanvasTour.canStart`
 * is `!!canvas.scene`, which is the same prerequisite the rows already declare.
 *
 * @param {{id: string, step: string}} target
 * @returns {{tour: object, stepIndex: number, label: string}|null}
 */
export function resolveTourTarget(target) {
  if ( !target?.id || !target?.step ) return null;
  const tour = game.tours?.get(target.id);
  if ( !tour ) {
    console.warn(`${MODULE_ID} | tour \`${target.id}\` is not registered, so no button is offered for it`);
    return null;
  }
  const stepIndex = findStepIndex(tour.steps, target.step);
  if ( stepIndex < 0 ) {
    console.warn(`${MODULE_ID} | tour \`${target.id}\` has no step \`${target.step}\`, so no button is offered for it`);
    return null;
  }
  if ( !tour.canStart ) return null;
  const step = tour.steps[stepIndex];
  return { tour, stepIndex, label: stepLabel(step, target.step) };
}

/**
 * What to call the destination on the button.
 *
 * `localize` hands back the key it was given when a translation is missing, so a
 * button would read "CANVASCONTROLS.WallsTitle". The step id is a worse name and
 * a better failure.
 */
function stepLabel(step, stepId) {
  if ( !step.title ) return stepId;
  const localized = game.i18n.localize(step.title);
  return (localized === step.title) ? stepId : localized;
}

/**
 * Start the tour on the step a row points at.
 *
 * `Tour#progress` throws when another tour is already running, which is a thing a
 * GM can cause by leaving the welcome tour open, so it is caught and reported
 * rather than left to surface as an uncaught error.
 *
 * Returns what it started, or null. A boolean would read better here and is not
 * available: a literal false returned from a Foundry hook cancels it, so the
 * contract test bans that phrase in every file, comments included.
 *
 * @param {{id: string, step: string}} target
 * @returns {Promise<object|null>}  The step it landed on, or null if it did not start.
 */
export async function startTourAt(target) {
  const resolved = resolveTourTarget(target);
  if ( !resolved ) return null;
  // `Tour#progress` persists the index it lands on (`#saveProgress`, which writes
  // the client-scope `core.tourProgress`). Jumping a GM to a step is not the same
  // as the GM having walked there, and in one shipped case the difference bites:
  // `core.sidebar` is resumable and its `settings` step is its last, so a jump
  // would leave Foundry's own Sidebar tour resuming on step 13 of 13 for a GM who
  // saw none of the first twelve. So the saved progress is put back afterwards.
  //
  // Residual, stated rather than hidden: the tour's in-memory index stays where we
  // jumped for the rest of the session, so starting that same tour again before a
  // reload resumes at our step. Repairing that needs either a tour-exit hook, which
  // Foundry does not emit, or `_reloadProgress`, which is marked internal.
  const priorProgress = snapshotTourProgress();
  try {
    await resolved.tour.progress(resolved.stepIndex);
    await restoreTourProgress(priorProgress);
    return resolved;
  }
  catch ( err ) {
    // `progress` throws for three unrelated reasons: another tour is active
    // (tour.mjs:339), the index is out of range (333), or the step's own selector
    // matched nothing and the tour tore itself down (476, rethrown at 398). The
    // first version of this named the first cause for all three, so a GM whose
    // sidebar had been rearranged by another module was told to close a tour that
    // was not open. The message now offers the likely remedy without asserting
    // which cause fired; the cause itself goes to the console.
    console.warn(`${MODULE_ID} | could not start tour \`${target.id}\` at step \`${target.step}\`:`, err);
    const name = resolved.tour.title ?? target.id;
    ui.notifications?.warn(`Foundry would not open that step of the ${name} tour.`
      + " If another tour is open, close it and try again. The report text still says what to do.");
    return null;
  }
}

/** The GM's saved tour progress, or null when it cannot be read. */
function snapshotTourProgress() {
  try {
    return structuredClone(game.settings?.get("core", "tourProgress") ?? {});
  }
  catch ( err ) {
    console.warn(`${MODULE_ID} | could not read core tour progress, so it will not be restored:`, err);
    return null;
  }
}

/** Put the GM's saved tour progress back. Never fatal: the tour has already started. */
async function restoreTourProgress(prior) {
  if ( prior === null ) return;
  try {
    await game.settings.set("core", "tourProgress", prior);
  }
  catch ( err ) {
    console.warn(`${MODULE_ID} | could not restore core tour progress:`, err);
  }
}
