import { describe, expect, test } from "bun:test";
import { runChecks, STATUS } from "../scripts/evaluator.mjs";
import checks from "../data/checks.json";

/**
 * Field values taken from a real v14.365 world's LevelDB, not invented: the
 * default "Foundry Virtual Tabletop" scene, which ships gridless with five
 * ambient lights, one Level carrying a background, and nothing else.
 *
 * On disk a Scene stores embedded collections as arrays of ids with the
 * documents under separate `!scenes.<collection>!<sceneId>.<docId>` keys. The
 * client hydrates those into EmbeddedCollections, which is the shape below.
 */
function collection(members: any[]) {
  const map = new Map(members.map(m => [m.id, m]));
  return Object.assign(map, { get contents() { return [...map.values()]; } });
}

const NUE_SCENE = {
  id: "NUEDEFAULTSCENE0",
  name: "Foundry Virtual Tabletop",
  grid: { type: 0, size: 100, style: "solidLines", thickness: 1, alpha: 0.2, distance: 1, units: "" },
  tokenVision: false,
  environment: { globalLight: { enabled: false } },
  levels: collection([{ id: "defaultLevel0000", background: { src: "nue/default-background.webp" } }]),
  lights: collection([
    { id: "d22Cax8HDPMG4F6I", config: { dim: 8.54, bright: 4.27 } },
    { id: "eGuMjw01vEYimWVX", config: { dim: 8.54, bright: 4.27 } },
    { id: "TCET4ZNPkl5oZukY", config: { dim: 8.54, bright: 4.27 } },
    { id: "cOpD0Q4AuCGiKRCb", config: { dim: 8.54, bright: 4.27 } },
    { id: "adhkydxURYamgKKF", config: { dim: 8.54, bright: 4.27 } }
  ]),
  walls: collection([]),
  tokens: collection([]),
  notes: collection([]),
  tiles: collection([{ id: "mMxIUI1fXJmrR1zK" }]),
  regions: collection([]),
  sounds: collection([]),
  drawings: collection([])
};

const WORLD = { activeModuleCount: 10, journal: [], actors: [], players: [] };

describe("the real default scene from a v14.365 world", () => {
  const results = runChecks(checks, { scene: NUE_SCENE, world: WORLD, user: null });
  const byId = new Map(results.map(r => [r.id, r]));

  test("no row errors against real document data", () => {
    expect(results.filter(r => r.status === STATUS.ERROR)).toEqual([]);
  });

  test("a v14 background on a Level is found", () => {
    // The pre-v14 path was scene.background.src; v14 moved it onto Level.
    expect(byId.get("canvas.background.present")!.status).toBe(STATUS.PASS);
  });

  test("gridless counts as a calibration decision, not a gap", () => {
    expect(byId.get("canvas.grid.calibrated")!.status).toBe(STATUS.PASS);
  });

  test("five ambient lights satisfy the lighting check", () => {
    expect(byId.get("canvas.lights.placed")!.status).toBe(STATUS.PASS);
  });

  test("the empty-wall scene reports walls, doors and sight as outstanding", () => {
    for ( const id of ["canvas.walls.present", "canvas.walls.doors", "canvas.walls.sight-blocking"] ) {
      expect(byId.get(id)!.status).toBe(STATUS.OUTSTANDING);
    }
  });

  test("no outstanding message asserts the existence of what the scene lacks", () => {
    // The sight-blocking row originally read "Walls exist but none of them
    // block sight", which is false on a scene with no walls. A message may
    // describe what is missing; it may not assert what is present.
    const wallMessages = results
      .filter(r => r.status === STATUS.OUTSTANDING && r.id.startsWith("canvas.walls."))
      .map(r => r.message.toLowerCase());
    for ( const message of wallMessages ) {
      expect(message).not.toMatch(/walls exist/);
    }
  });

  test("ten active modules trip the vanilla-first row", () => {
    expect(byId.get("vanilla.modules.restrained")!.status).toBe(STATUS.OUTSTANDING);
  });
});
