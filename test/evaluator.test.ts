import { describe, expect, test } from "bun:test";
import { REQUIRED_FIELDS, runChecks, STATUS, summarise, validateChecks } from "../scripts/evaluator.mjs";
import checks from "../data/checks.json";

function collection(members: any[]) {
  const map = new Map(members.map((m, i) => [m.id ?? String(i), m]));
  return Object.assign(map, { get contents() { return members; } });
}

describe("validateChecks — the shipped rows (ISC-24)", () => {
  test("every shipped row carries all seven required fields", () => {
    expect(validateChecks(checks)).toEqual([]);
  });
  test("there are exactly seven required fields", () => {
    expect(REQUIRED_FIELDS).toEqual(["id", "week", "competency", "scope", "predicate", "message", "hint"]);
  });
  test("every shipped row names a rubric competency", () => {
    for ( const row of checks ) expect(typeof row.competency).toBe("string");
  });
  test("every shipped row uses a scope the evaluator resolves", () => {
    for ( const row of checks ) expect(["scene", "world", "user"]).toContain(row.scope);
  });
  test("the canvas family covers grid, walls, lights and token vision (ISC-25)", () => {
    const ids = checks.filter(r => r.competency === "Canvas and spatial calibration").map(r => r.id);
    expect(ids).toContain("canvas.grid.calibrated");
    expect(ids).toContain("canvas.walls.present");
    expect(ids).toContain("canvas.lights.placed");
    expect(ids).toContain("canvas.vision.token-sight");
  });
});

describe("validateChecks — rejection", () => {
  test("a missing field is reported with the row id", () => {
    const problems = validateChecks([{ id: "x", week: 1, competency: "c", scope: "scene", predicate: { op: "truthy" } }]);
    expect(problems).toContain("x: missing required field `message`");
    expect(problems).toContain("x: missing required field `hint`");
  });
  test("a blank string counts as missing", () => {
    const problems = validateChecks([
      { id: "x", week: 1, competency: "  ", scope: "scene", predicate: { op: "truthy" }, message: "m", hint: "h" }
    ]);
    expect(problems).toContain("x: missing required field `competency`");
  });
  test("a duplicate id is reported", () => {
    const row = { id: "dupe", week: 1, competency: "c", scope: "scene", predicate: { op: "truthy", path: "a" }, message: "m", hint: "h" };
    expect(validateChecks([row, { ...row }])).toContain("dupe: duplicate id");
  });
  test("a predicate with no op is reported", () => {
    const problems = validateChecks([
      { id: "x", week: 1, competency: "c", scope: "scene", predicate: {}, message: "m", hint: "h" }
    ]);
    expect(problems).toContain("x: predicate has no `op`");
  });
});

describe("runChecks against a seeded scene", () => {
  // A scene with known gaps: default grid, walls but no doors, no lights,
  // token vision off at the scene level, one token with no sight.
  const bareScene = {
    name: "Seeded Gaps",
    id: "scene1",
    grid: { size: 100, type: 1 },
    tokenVision: false,
    environment: { globalLight: { enabled: true } },
    levels: collection([{ id: "l1", background: { src: "maps/keep.webp" } }]),
    walls: collection([{ id: "w1", door: 0, sight: 1 }]),
    lights: collection([]),
    tokens: collection([{ id: "t1", sight: { enabled: false }, light: { dim: 0, bright: 0 }, actorId: null }]),
    notes: collection([])
  };
  const world = {
    activeModuleCount: 2,
    journal: [],
    players: [{ id: "u1", characterId: null }]
  };
  const results = runChecks(checks, { scene: bareScene, world, user: { id: "gm" } });

  test("every row produced exactly one result", () => {
    expect(results).toHaveLength(checks.length);
  });

  test("each seeded gap is reported outstanding", () => {
    const outstanding = results.filter(r => r.status === STATUS.OUTSTANDING).map(r => r.id);
    for ( const id of [
      "canvas.grid.calibrated",
      "canvas.walls.doors",
      "canvas.lights.placed",
      "canvas.vision.scene-enabled",
      "canvas.vision.token-sight",
      "canvas.lighting.not-blanket",
      "automation.tokens.actor-linked",
      "prep.notes.placed",
      "prep.journal.present",
      "admin.gm.has-character"
    ] ) {
      expect(outstanding).toContain(id);
    }
  });

  test("what is actually present is not reported outstanding", () => {
    const byId = new Map(results.map(r => [r.id, r]));
    expect(byId.get("canvas.background.present")!.status).toBe(STATUS.PASS);
    expect(byId.get("canvas.walls.present")!.status).toBe(STATUS.PASS);
    expect(byId.get("canvas.walls.sight-blocking")!.status).toBe(STATUS.PASS);
    expect(byId.get("vanilla.modules.restrained")!.status).toBe(STATUS.PASS);
  });

  test("no row errored", () => {
    expect(results.filter(r => r.status === STATUS.ERROR)).toEqual([]);
  });

  test("results carry the message and hint for display", () => {
    const row = results.find(r => r.id === "canvas.lights.placed")!;
    expect(row.message).toMatch(/no light anywhere/i);
    expect(row.hint).toMatch(/ambient light/i);
  });
});

describe("runChecks on a finished scene", () => {
  const goodScene = {
    name: "Finished",
    id: "scene2",
    grid: { size: 140, type: 1 },
    tokenVision: true,
    environment: { globalLight: { enabled: false } },
    levels: collection([{ id: "l1", background: { src: "maps/keep.webp" } }]),
    walls: collection([{ id: "w1", door: 0, sight: 1 }, { id: "w2", door: 1, sight: 1 }]),
    lights: collection([{ id: "al1" }]),
    tokens: collection([{ id: "t1", sight: { enabled: true }, light: { dim: 0, bright: 0 }, actorId: "a1" }]),
    notes: collection([{ id: "n1", entryId: "j1" }])
  };
  const world = { activeModuleCount: 1, journal: [{ id: "j1" }], players: [{ id: "u1", characterId: "a1" }] };

  test("nothing is outstanding", () => {
    const results = runChecks(checks, { scene: goodScene, world, user: { id: "gm" } });
    expect(results.filter(r => r.status !== STATUS.PASS)).toEqual([]);
  });
});

describe("runChecks never gates (ISC-30)", () => {
  test("no viewed scene yields unavailable, not failure", () => {
    const results = runChecks(checks, { scene: null, world: null, user: null });
    expect(results.every(r => r.status === STATUS.UNAVAILABLE)).toBe(true);
    expect(results.filter(r => r.status === STATUS.OUTSTANDING)).toEqual([]);
  });
  test("an unknown scope is an error on that row only", () => {
    const rows = [
      { id: "bad", week: 1, competency: "c", scope: "nowhere", predicate: { op: "truthy", path: "a" }, message: "m", hint: "h" },
      { id: "good", week: 1, competency: "c", scope: "scene", predicate: { op: "truthy", path: "a" }, message: "m", hint: "h" }
    ];
    const results = runChecks(rows, { scene: { a: true } });
    expect(results[0].status).toBe(STATUS.ERROR);
    expect(results[1].status).toBe(STATUS.PASS);
  });
  test("a broken predicate is contained to its own row", () => {
    const rows = [
      { id: "boom", week: 1, competency: "c", scope: "scene", predicate: { op: "nonsense" }, message: "m", hint: "h" },
      { id: "fine", week: 1, competency: "c", scope: "scene", predicate: { op: "truthy", path: "a" }, message: "m", hint: "h" }
    ];
    const results = runChecks(rows, { scene: { a: true } });
    expect(results[0].status).toBe(STATUS.ERROR);
    expect(results[0].detail).toMatch(/unknown predicate op/);
    expect(results[1].status).toBe(STATUS.PASS);
  });
});

describe("summarise", () => {
  test("counts by status and groups by competency", () => {
    const results = [
      { id: "a", competency: "X", status: STATUS.PASS, week: 1 },
      { id: "b", competency: "X", status: STATUS.OUTSTANDING, week: 2 },
      { id: "c", competency: "Y", status: STATUS.UNAVAILABLE, week: 1 }
    ];
    const { counts, byCompetency, total } = summarise(results as any);
    expect(counts).toEqual({ pass: 1, outstanding: 1, unavailable: 1, error: 0 });
    expect([...byCompetency.keys()]).toEqual(["X", "Y"]);
    expect(total).toBe(3);
  });
});
