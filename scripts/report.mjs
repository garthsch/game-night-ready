/**
 * Report rendering. Builds HTML from evaluator results; opens a DialogV2.
 *
 * The report always states what the module does not assess, and where
 * its view is partial, so a clean run never reads as "this session is ready".
 */

import { STATUS, summarise } from "./evaluator.mjs";
import { resolveTourTarget, startTourAt } from "./tours.mjs";

/**
 * How long to wait for the report's own close event before starting a tour anyway.
 *
 * Above `ApplicationV2#close`'s own ceiling: it awaits the closing transition for
 * up to 1000ms (application.mjs:1016) and only emits "close" after tearing the
 * element out of the DOM, so a shorter timeout here would pre-empt a close that
 * was merely animating. This is a safety net for an event that never arrives, and
 * it should never be the thing that fires.
 */
const CLOSE_TIMEOUT_MS = 1500;

/** Competencies the machine cannot assess, stated in the product itself. */
export const HUMAN_ASSESSED = [
  {
    name: "Facilitation and troubleshooting",
    note: "Not machine-assessable. Whether you can hold a table's attention, and whether you can diagnose a problem live without the session stalling, is judged by running a game in front of people."
  },
  {
    name: "Server administration",
    note: "Partly assessable. Users, roles and character assignment are visible from inside the world. Whether your players can actually reach the server is not visible from here, and has to be tested by someone connecting."
  }
];

const STATUS_LABEL = {
  [STATUS.PASS]: "done",
  [STATUS.OUTSTANDING]: "outstanding",
  [STATUS.UNAVAILABLE]: "could not read",
  [STATUS.ERROR]: "check broken"
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/**
 * The headline verdict. Deliberately three-valued, not two.
 *
 * "Game Night Ready" is a claim, so it is only made when every check could be
 * read and every one passed. A check that could not read the field it needs
 * might be hiding a gap, so the honest answer there is that we cannot tell --
 * reporting ready on an incomplete read is the one failure that would make the
 * name a lie.
 */
export function verdict(counts) {
  const unread = counts.unavailable + counts.error;
  const unreadClause = unread
    ? ` ${unread} check${unread === 1 ? "" : "s"} could not be read, so this is not the whole picture.`
    : "";
  if ( counts.outstanding > 0 ) {
    // Both facts, never just the louder one: a real gap was found, and the
    // reading was incomplete. Reporting only the gap count would imply the
    // module looked at everything and found exactly that much.
    return {
      state: "not-ready",
      label: `Not game night ready yet: ${counts.outstanding} outstanding.${unreadClause}`
    };
  }
  if ( unread > 0 ) {
    return { state: "unknown", label: `Can't tell yet: ${unread} check${unread === 1 ? "" : "s"} could not be read.` };
  }
  return { state: "ready", label: "Game Night Ready." };
}

/**
 * The one thing to do next.
 *
 * The rows carry the course week they belong to, so week order is already the
 * path from a fresh world to a running game. The earliest outstanding row is
 * therefore the next step, and its hint is the instruction for it.
 *
 * @param {object[]} results
 * @returns {object|null} The result to lead with, or null when nothing is outstanding.
 */
export function nextAction(results) {
  // A row waiting on its prerequisite is already reported unavailable by the
  // evaluator, so everything still outstanding is something the GM can act on
  // now. Among those, the earliest course week is the next step.
  const outstanding = results.filter(r => r.status === STATUS.OUTSTANDING);
  if ( !outstanding.length ) return null;
  // Stable: ties inside a week fall back to row order, which is the order the
  // rows are written in, which is the order the course teaches them.
  return outstanding.reduce((best, row) => (row.week < best.week) ? row : best, outstanding[0]);
}

/**
 * @param {object[]} results
 * @param {object} context  { sceneName, worldTitle, baselineCount }
 * @returns {string} HTML
 */
export function buildReportHtml(results, context = {}) {
  const { counts, byCompetency } = summarise(results);
  const sceneName = context.onFoundryDefaultScene
    ? "Foundry's own starting scene, so nothing scene-specific could be read"
    : (context.sceneName ?? "no scene");
  const parts = [];

  parts.push(`<div class="game-night-ready">`);
  const { label, state } = verdict(counts);
  parts.push(`<p class="gnr-verdict gnr-verdict-${state}">${label}</p>`);
  parts.push(`<p class="gnr-headline">${counts.outstanding} outstanding, ${counts.pass} done`
    + `${counts.unavailable ? `, ${counts.unavailable} unreadable` : ""}`
    + `${counts.error ? `, ${counts.error} broken` : ""}.</p>`);
  parts.push(`<p class="gnr-subject">Scene: <strong>${escapeHtml(sceneName)}</strong>`
    + `${context.worldTitle ? ` &middot; World: <strong>${escapeHtml(context.worldTitle)}</strong>` : ""}</p>`);

  const next = nextAction(results);
  if ( next ) {
    // The hint names a control; it does not say where the control is. Where a
    // shipped tour covers it, the button below is the answer to "where", and
    // saying so in the block is what connects the two.
    const tourLine = context.tourLabel
      ? `<p class="gnr-next-tour">Press <strong>Show me: ${escapeHtml(context.tourLabel)}</strong>`
        + ` below and Foundry will open it for you.</p>`
      : "";
    parts.push(`<div class="gnr-next"><p class="gnr-next-label">Do this next</p>`
      + `<p class="gnr-next-what">${escapeHtml(next.message)}</p>`
      + `<p class="gnr-next-how">${escapeHtml(next.hint)}</p>${tourLine}</div>`);
  }

  if ( context.baselineCount ) {
    parts.push(`<p class="gnr-baseline">Ignoring ${context.baselineCount} document(s) that arrived with the`
      + ` imported adventure, so this reports what you added.</p>`);
  }

  // Groups run in course order, earliest week first, so the report reads as the
  // path from a fresh world to a running game rather than as a ranked audit.
  const groups = [...byCompetency].sort((a, b) => earliestWeek(a[1]) - earliestWeek(b[1]));
  for ( const [competency, rows] of groups ) {
    const ordered = [...rows].sort((a, b) => rank(a.status) - rank(b.status));
    parts.push(`<h3 class="gnr-competency">${escapeHtml(competency)}</h3><ul class="gnr-rows">`);
    for ( const row of ordered ) {
      parts.push(`<li class="gnr-row gnr-${row.status}">`);
      parts.push(`<span class="gnr-status">${STATUS_LABEL[row.status]}</span> `);
      // Each status gets a sentence it can support. A passing row states what was
      // found; a row that could not be read names its subject and nothing more,
      // since printing the failure sentence there asserts a finding never made.
      const sentence = (row.status === STATUS.PASS) ? row.done
        : (row.status === STATUS.OUTSTANDING) ? row.message
        : row.topic;
      parts.push(`<span class="gnr-message">${escapeHtml(sentence)}</span>`);
      if ( row.status === STATUS.OUTSTANDING ) {
        parts.push(`<div class="gnr-hint">${escapeHtml(row.hint)}</div>`);
      }
      if ( row.detail ) parts.push(`<div class="gnr-detail">${escapeHtml(row.detail)}</div>`);
      parts.push(`</li>`);
    }
    parts.push(`</ul>`);
  }

  parts.push(`<h3 class="gnr-competency">Not assessed here</h3><ul class="gnr-rows">`);
  for ( const item of HUMAN_ASSESSED ) {
    parts.push(`<li class="gnr-row gnr-human"><span class="gnr-status">human</span> `
      + `<span class="gnr-message">${escapeHtml(item.name)}</span>`
      + `<div class="gnr-hint">${escapeHtml(item.note)}</div></li>`);
  }
  parts.push(`</ul>`);

  parts.push(`<p class="gnr-footer">This reports completeness, not whether your choices were right.`
    + ` A wall in the wrong place passes. Whether the room is worth walking into is yours to judge.</p>`);
  parts.push(`</div>`);
  return parts.join("");
}

/** The course week a group starts at. */
function earliestWeek(rows) {
  return rows.reduce((lowest, row) => Math.min(lowest, row.week), Infinity);
}

function rank(status) {
  return { [STATUS.OUTSTANDING]: 0, [STATUS.ERROR]: 1, [STATUS.UNAVAILABLE]: 2, [STATUS.PASS]: 3 }[status] ?? 9;
}

/**
 * The dialog's buttons. Separated from opening it for the same reason the HTML is:
 * whether a button is offered at all is a decision worth testing, and a decision
 * made inside `showReport` cannot be reached without a live DialogV2.
 *
 * @param {{label: string}|null} target  A resolved tour step, or null.
 * @returns {object[]}
 */
export function reportButtons(target) {
  const buttons = [];
  if ( target ) {
    buttons.push({ action: "tour", label: `Show me: ${target.label}`, icon: "fa-solid fa-person-hiking" });
  }
  buttons.push({ action: "close", label: "Close", default: true });
  return buttons;
}

/** Open the report. Separated from building so the HTML is testable headless. */
export async function showReport(results, context = {}) {
  const { DialogV2 } = foundry.applications.api;
  const next = nextAction(results);
  // Resolved before the dialog opens, because a button offering to take you
  // somewhere has to be able to. `CanvasTour.canStart` is `!!canvas.scene`, so on
  // a world with no scene of its own the canvas tours decline and no button appears.
  const target = next?.tour ? resolveTourTarget(next.tour) : null;

  // The dialog's own close event, taken as a promise. `DialogV2.wait` resolves
  // from `_onSubmit` at dialog.mjs:274 and only calls `close()` at line 277, so
  // the pressed-button value arrives BEFORE the report has gone. Starting the
  // tour on it directly would render the step while this dialog is still on
  // screen, over the control the step is pointing at. The close event is emitted
  // after `_tearDown` removes the element (application.mjs:1018-1033), so waiting
  // on it means the report is genuinely out of the way.
  let reportClosed;
  const closed = new Promise(resolve => { reportClosed = resolve; });

  const choice = await DialogV2.wait({
    window: { title: "Game Night Ready", icon: "fa-solid fa-clipboard-check" },
    position: { width: 620 },
    content: buildReportHtml(results, { ...context, tourLabel: target?.label ?? null }),
    buttons: reportButtons(target),
    close: () => reportClosed(),
    rejectClose: false
  });

  if ( choice === "tour" ) {
    // Raced against a timeout so a close event that never arrives cannot leave
    // the press doing nothing at all; late is better than never here.
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
    // Resolved a second time on purpose. The world can move while the report is
    // open: close the scene and `canStart` goes false, so the button that was
    // honest when it rendered is not any more. Pressing it then has to say so,
    // because a dialog that closes and does nothing reads as a broken module.
    if ( resolveTourTarget(next.tour) ) await startTourAt(next.tour);
    else ui.notifications?.warn("Foundry cannot open that tour from here now. The report text still says what to do.");
  }
  return choice;
}
