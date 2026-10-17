import { afterEach, describe, expect, test } from "bun:test";
import { findStepIndex, resolveTourTarget, SHIPPED_TOURS, startTourAt, validateTourTargets } from "../../scripts/tours.mjs";
import { validateChecks } from "../../scripts/evaluator.mjs";
import checks from "../../data/checks.json";

/**
 * Foundry is the external dependency here, so it is shimmed rather than the
 * module under test: a fake `game.tours` holding fake tours, and a localizer
 * that returns the key it was given.
 */
function foundry(tours: Record<string, any>, { localize = (k: string) => `[${k}]`, progress = {} as any } = {}) {
  const warnings: string[] = [];
  const store: Record<string, any> = { "core.tourProgress": progress };
  const settings = {
    get: (ns: string, key: string) => store[`${ns}.${key}`],
    set: async (ns: string, key: string, value: any) => { store[`${ns}.${key}`] = value; }
  };
  (globalThis as any).game = { tours: new Map(Object.entries(tours)), i18n: { localize }, settings };
  (globalThis as any).__store = store;
  (globalThis as any).ui = { notifications: { warn: (m: string) => warnings.push(m) } };
  const realWarn = console.warn;
  console.warn = () => {};
  return { warnings, restore: () => { console.warn = realWarn; } };
}

function tour(steps: any[], { canStart = true, progress = async () => {}, title = "Sidebar" } = {}) {
  return { steps, canStart, progress, title };
}

afterEach(() => {
  delete (globalThis as any).game;
  delete (globalThis as any).ui;
});

describe("findStepIndex", () => {
  const steps = [{ id: "overview" }, { id: "tokens" }, { id: "walls" }];
  test("finds a step by id", () => {
    expect(findStepIndex(steps, "walls")).toBe(2);
  });
  test("a step the tour no longer has is -1, never 0", () => {
    // Index arithmetic would quietly send a GM to the first step instead.
    expect(findStepIndex(steps, "gridConfiguration")).toBe(-1);
  });
  test("a tour with no steps is -1", () => {
    expect(findStepIndex(undefined as any, "walls")).toBe(-1);
  });
});

describe("validateTourTargets", () => {
  test("the shipped rows are well-formed", () => {
    expect(validateTourTargets(checks)).toEqual([]);
  });
  test("a row with no tour is not a problem", () => {
    expect(validateTourTargets([{ id: "r" }])).toEqual([]);
  });
  test("a tour Foundry does not ship is a problem", () => {
    const problems = validateTourTargets([{ id: "r", tour: { id: "someModule.tour", step: "x" } }]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("is not a tour Foundry ships");
  });
  test("a missing step id is a problem", () => {
    const problems = validateTourTargets([{ id: "r", tour: { id: "core.sidebar" } }]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("`tour.step`");
  });
  test("a tour field that is not an object is a problem", () => {
    expect(validateTourTargets([{ id: "r", tour: "core.sidebar" }]).length).toBe(1);
  });
});

describe("validateChecks carries the tour rules", () => {
  // Without this the validation above could be unwired and every other test
  // would still pass, which is the shape of a vacuous suite.
  test("a malformed tour target fails the row set that ships it", () => {
    const row = { ...(checks as any[])[0], id: "broken", tour: { id: "notATour", step: "x" } };
    const problems = validateChecks([row]);
    expect(problems.some(p => p.includes("is not a tour Foundry ships"))).toBe(true);
  });
  test("the shipped row set passes whole", () => {
    expect(validateChecks(checks)).toEqual([]);
  });
});

describe("the shipped rows", () => {
  test("every target names one of the eight tours Foundry registers", () => {
    for ( const row of checks.filter((r: any) => r.tour) ) {
      expect(SHIPPED_TOURS).toContain((row as any).tour.id);
    }
  });
  // The step order of each shipped tour we point into, copied from
  // `public/tours/*.json` in the Foundry v14.365 install. Pinned here because the
  // suite must run without a Foundry install present. Re-check on a core upgrade.
  const SHIPPED_STEPS: Record<string, string[]> = {
    "core.sidebar": ["sidebar", "chatLog", "combatTracker", "scenes", "actorDirectory", "actionButtons",
      "itemDirectory", "journalEntry", "rollableTables", "cardStacks", "playlists", "compendiumPacks", "settings"],
    "core.canvasControls": ["overview", "tokens", "tile", "drawings", "walls", "lighting", "sounds",
      "notes", "furtherReading"]
  };

  test("every target names a step that tour actually has", () => {
    for ( const row of checks.filter((r: any) => r.tour) ) {
      const steps = SHIPPED_STEPS[(row as any).tour.id];
      expect(steps).toBeDefined();
      expect(steps).toContain((row as any).tour.step);
    }
  });

  test("no row points at the last step of a tour", () => {
    // Found by pressing it in a real client: landing on the final step renders the
    // tour's Next control as a finish-check, so one click completes a tour the GM
    // never walked and Foundry then offers its `suggestedNextTours` prompt. The
    // three week-1 rows pointed at core.sidebar/settings, step 13 of 13.
    for ( const row of checks.filter((r: any) => r.tour) ) {
      const steps = SHIPPED_STEPS[(row as any).tour.id];
      expect(steps[steps.length - 1]).not.toBe((row as any).tour.step);
    }
  });

  test("the rows with no tour are the seven no shipped step suits", () => {
    // Two different reasons, both narrow. Four are set in Scene Configuration and
    // no shipped step HIGHLIGHTS that dialog; `core.sidebar/scenes` does reach the
    // Scenes directory it is opened from, so pointing them there stays a product
    // decision rather than an impossibility. The other three want the sidebar's
    // Settings tab, whose only shipped step is the last step of its tour.
    const uncovered = checks.filter((r: any) => !r.tour).map((r: any) => r.id);
    expect(uncovered.sort()).toEqual([
      "admin.gm.has-character",
      "admin.players.exist",
      "canvas.background.present",
      "canvas.grid.calibrated",
      "canvas.lighting.not-blanket",
      "canvas.vision.scene-enabled",
      "vanilla.modules.restrained"
    ]);
  });
});

describe("resolveTourTarget", () => {
  test("an untranslated step title falls back to the step id, not the raw key", () => {
    const { restore } = foundry(
      { "core.canvasControls": tour([{ id: "walls", title: "CANVASCONTROLS.WallsTitle" }]) },
      { localize: (k: string) => k }
    );
    expect(resolveTourTarget({ id: "core.canvasControls", step: "walls" })?.label).toBe("walls");
    restore();
  });
  test("resolves the step index and the step's own title", () => {
    const { restore } = foundry({ "core.canvasControls": tour([{ id: "overview" }, { id: "walls", title: "CANVASCONTROLS.WallsTitle" }]) });
    const resolved = resolveTourTarget({ id: "core.canvasControls", step: "walls" });
    expect(resolved?.stepIndex).toBe(1);
    expect(resolved?.label).toBe("[CANVASCONTROLS.WallsTitle]");
    restore();
  });
  test("a tour that is not registered resolves to nothing", () => {
    const { restore } = foundry({});
    expect(resolveTourTarget({ id: "core.canvasControls", step: "walls" })).toBe(null);
    restore();
  });
  test("a step renamed upstream resolves to nothing rather than the wrong step", () => {
    const { restore } = foundry({ "core.canvasControls": tour([{ id: "overview" }]) });
    expect(resolveTourTarget({ id: "core.canvasControls", step: "walls" })).toBe(null);
    restore();
  });
  test("a tour that cannot start right now offers nothing", () => {
    // CanvasTour.canStart is !!canvas.scene, which is the prerequisite the rows
    // already declare, so this is a precondition rather than breakage.
    const { restore } = foundry({ "core.canvasControls": tour([{ id: "walls" }], { canStart: false }) });
    expect(resolveTourTarget({ id: "core.canvasControls", step: "walls" })).toBe(null);
    restore();
  });
  test("a row with no tour field resolves to nothing", () => {
    const { restore } = foundry({});
    expect(resolveTourTarget(null as any)).toBe(null);
    restore();
  });
});

describe("startTourAt", () => {
  test("starts the tour on the step the row names", async () => {
    const visited: number[] = [];
    const { restore } = foundry({
      "core.sidebar": tour([{ id: "sidebar" }, { id: "scenes" }], { progress: async (i: number) => { visited.push(i); } })
    });
    expect((await startTourAt({ id: "core.sidebar", step: "scenes" }))?.stepIndex).toBe(1);
    expect(visited).toEqual([1]);
    restore();
  });
  test("the GM's own saved tour progress is left exactly as it was", async () => {
    // Tour#progress persists the step it lands on. core.sidebar is resumable and
    // its settings step is its last, so without the restore Foundry's own tour
    // would resume on step 13 of 13 for a GM who walked none of it.
    const before = { core: { sidebar: 3, welcome: -1 } };
    const { restore } = foundry(
      { "core.sidebar": tour([{ id: "sidebar" }, { id: "settings" }], {
          progress: async () => { (globalThis as any).__store["core.tourProgress"] = { core: { sidebar: 1 } }; } }) },
      { progress: structuredClone(before) }
    );
    await startTourAt({ id: "core.sidebar", step: "settings" });
    expect((globalThis as any).__store["core.tourProgress"]).toEqual(before);
    restore();
  });
  // progress() throws for three unrelated reasons. The GM-facing message must not
  // claim which one fired: the earlier version named "a tour is already running"
  // for all of them, and the fixture happened to throw that cause, so the test
  // agreed with the message by construction instead of testing it.
  for ( const [label, cause] of [
    ["another tour is active", "You cannot begin the Sidebar Tour because the Welcome Tour is already in progress"],
    ["the step's selector matched nothing", "The expected targetElement #sidebar-tabs does not exist"],
    ["the index is out of range", "Step index 99 is not valid for Tour sidebar with 13 steps."]
  ] as const ) {
    test(`a throw because ${label} is reported without asserting a cause`, async () => {
      const { warnings, restore } = foundry({
        "core.sidebar": tour([{ id: "scenes" }], { progress: async () => { throw new Error(cause); } })
      });
      expect(await startTourAt({ id: "core.sidebar", step: "scenes" })).toBe(null);
      expect(warnings.length).toBe(1);
      // One message, identical for every cause, and it never says a tour IS open.
      expect(warnings[0]).toBe("Foundry would not open that step of the Sidebar tour."
        + " If another tour is open, close it and try again. The report text still says what to do.");
      restore();
    });
  }
  test("an unresolvable target starts nothing and reports nothing to the GM", async () => {
    const { warnings, restore } = foundry({});
    expect(await startTourAt({ id: "core.sidebar", step: "scenes" })).toBe(null);
    expect(warnings).toEqual([]);
    restore();
  });
});
