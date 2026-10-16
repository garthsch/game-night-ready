/**
 * Report rendering. Builds HTML from evaluator results; opens a DialogV2.
 *
 * The report always states what the module does not assess, and where
 * its view is partial, so a clean run never reads as "this session is ready".
 */

import { STATUS, summarise } from "./evaluator.mjs";

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
 * @param {object[]} results
 * @param {object} context  { sceneName, worldTitle, baselineCount }
 * @returns {string} HTML
 */
export function buildReportHtml(results, context = {}) {
  const { counts, byCompetency } = summarise(results);
  const sceneName = context.sceneName ?? "no scene";
  const parts = [];

  parts.push(`<div class="game-night-ready">`);
  const { label, state } = verdict(counts);
  parts.push(`<p class="gnr-verdict gnr-verdict-${state}">${label}</p>`);
  parts.push(`<p class="gnr-headline">${counts.outstanding} outstanding, ${counts.pass} done`
    + `${counts.unavailable ? `, ${counts.unavailable} unreadable` : ""}`
    + `${counts.error ? `, ${counts.error} broken` : ""}.</p>`);
  parts.push(`<p class="gnr-subject">Scene: <strong>${escapeHtml(sceneName)}</strong>`
    + `${context.worldTitle ? ` &middot; World: <strong>${escapeHtml(context.worldTitle)}</strong>` : ""}</p>`);

  if ( context.baselineCount ) {
    parts.push(`<p class="gnr-baseline">Ignoring ${context.baselineCount} document(s) that arrived with the`
      + ` imported adventure, so this reports what you added.</p>`);
  }

  // Outstanding first, within each competency, because that is what the GM came for.
  for ( const [competency, rows] of byCompetency ) {
    const ordered = [...rows].sort((a, b) => rank(a.status) - rank(b.status) || a.week - b.week);
    parts.push(`<h3 class="gnr-competency">${escapeHtml(competency)}</h3><ul class="gnr-rows">`);
    for ( const row of ordered ) {
      parts.push(`<li class="gnr-row gnr-${row.status}">`);
      parts.push(`<span class="gnr-status">${STATUS_LABEL[row.status]}</span> `);
      parts.push(`<span class="gnr-week">week ${escapeHtml(row.week)}</span> `);
      parts.push(`<span class="gnr-message">${escapeHtml(row.message)}</span>`);
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

function rank(status) {
  return { [STATUS.OUTSTANDING]: 0, [STATUS.ERROR]: 1, [STATUS.UNAVAILABLE]: 2, [STATUS.PASS]: 3 }[status] ?? 9;
}

/** Open the report. Separated from building so the HTML is testable headless. */
export async function showReport(results, context = {}) {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.prompt({
    window: { title: "Game Night Ready", icon: "fa-solid fa-clipboard-check" },
    position: { width: 620 },
    content: buildReportHtml(results, context),
    ok: { label: "Close" },
    rejectClose: false
  });
}
