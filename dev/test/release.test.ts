import { describe, expect, test } from "bun:test";
import { buildArchive, gate, pairingGate, shipList, type Archive } from "../release.ts";
import manifest from "../../module.json";

/**
 * Tests for the release gate.
 *
 * The gate's whole job is to fail, so most of these hand it a broken archive and
 * check that it says so. The archive is built in memory rather than on disk,
 * because what Foundry installs is the archive and nothing else.
 *
 * The first negative control is the fault v0.3.0's notes claim v0.2.0 shipped:
 * a `report.mjs` that imports `./tours.mjs` with `tours.mjs` absent. v0.2.0's own
 * `report.mjs` imported no such thing, so that release was sound and the claim is
 * wrong, but the fault it describes is real and reachable, and this is the test
 * that would catch it.
 */

const encode = (text: string) => new TextEncoder().encode(text);

/** A minimal archive that satisfies every gate, as a base to break one way at a time. */
function soundArchive(): Archive {
  return {
    "module.json": encode(JSON.stringify({
      id: manifest.id,
      version: manifest.version,
      compatibility: { minimum: "14", verified: "14.365" },
      esmodules: ["scripts/module.mjs"],
      styles: ["styles/game-night-ready.css"],
      languages: [{ lang: "en", name: "English", path: "lang/en.json" }],
      license: "LICENSE"
    })),
    "scripts/module.mjs": encode(`import { runChecks } from "./evaluator.mjs";\n`
      + `const url = foundry.utils.getRoute(\`modules/\${MODULE_ID}/data/checks.json\`);\n`),
    "scripts/evaluator.mjs": encode(`export function runChecks() {}\n`),
    "styles/game-night-ready.css": encode(".gnr {}\n"),
    "lang/en.json": encode("{}\n"),
    "data/checks.json": encode("[]\n"),
    "LICENSE": encode("MIT\n"),
    "README.md": encode("# Game Night Ready\n")
  };
}

function faultsOf(files: Archive, id: string, strict = true) {
  return gate(files, manifest, strict).find(g => g.id === id)!.faults;
}

function failedGates(files: Archive, strict = true) {
  return gate(files, manifest, strict).filter(g => g.faults.length).map(g => g.id);
}

describe("a sound archive passes", () => {
  test("every gate passes on a complete archive", () => {
    expect(failedGates(soundArchive())).toEqual([]);
  });
});

describe("an import that is not in the archive is caught", () => {
  test("the missing-tours shape: a shipped file imports a file that was left out", () => {
    const files = soundArchive();
    files["scripts/report.mjs"] = encode(`import { startTourAt } from "./tours.mjs";\n`);
    files["scripts/module.mjs"] = encode(`import "./report.mjs";\n`);
    const faults = faultsOf(files, "G2");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("tours.mjs");
    expect(failedGates(files)).toContain("G2");
  });

  test("a second-hop import is followed, not just the first", () => {
    const files = soundArchive();
    files["scripts/evaluator.mjs"] = encode(`import { x } from "./tours.mjs";\n`);
    expect(faultsOf(files, "G2")[0]).toContain("tours.mjs");
  });

  test("a dynamic import counts the same as a static one", () => {
    const files = soundArchive();
    files["scripts/evaluator.mjs"] = encode(`await import("./late.mjs");\n`);
    expect(faultsOf(files, "G2")[0]).toContain("late.mjs");
  });
});

describe("a runtime route that is not in the archive is caught", () => {
  test("the class the manifest cannot see: a data file fetched at runtime", () => {
    // `data/checks.json` is named nowhere in module.json. An archive without it
    // installs cleanly and then has no checks to run.
    const files = soundArchive();
    delete files["data/checks.json"];
    const faults = faultsOf(files, "G3");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("data/checks.json");
  });
});

describe("the manifest's own declarations are checked", () => {
  test("a declared style sheet that was left out is caught", () => {
    const files = soundArchive();
    delete files["styles/game-night-ready.css"];
    expect(faultsOf(files, "G1")[0]).toContain("styles/game-night-ready.css");
  });

  test("a declared language file that was left out is caught", () => {
    const files = soundArchive();
    delete files["lang/en.json"];
    expect(faultsOf(files, "G1")[0]).toContain("lang/en.json");
  });

  test("an archive with no manifest at all cannot install", () => {
    const files = soundArchive();
    delete files["module.json"];
    expect(faultsOf(files, "G4")[0]).toContain("no module.json");
  });

  test("a build whose archive declares a different version is caught", () => {
    const files = soundArchive();
    files["module.json"] = encode(JSON.stringify({
      id: manifest.id, version: "0.0.1", compatibility: { minimum: "14", verified: "14.365" }
    }));
    expect(faultsOf(files, "G4").join(" ")).toContain("0.0.1");
  });

  test("but verifying a published archive does not judge it against today's version", () => {
    // Why `verify` runs with the version comparison off: an older release is a
    // correct archive that declares an older number, and reporting that as a fault
    // is how a sound release gets called broken.
    const files = soundArchive();
    files["module.json"] = encode(JSON.stringify({
      id: manifest.id, version: "0.2.0", compatibility: { minimum: "14", verified: "14.365" }
    }));
    expect(faultsOf(files, "G4", false)).toEqual([]);
  });

  test("an unverified compatibility is caught either way", () => {
    const files = soundArchive();
    files["module.json"] = encode(JSON.stringify({
      id: manifest.id, version: manifest.version, compatibility: { minimum: "14" }
    }));
    expect(faultsOf(files, "G4", false).join(" ")).toContain("compatibility.verified");
  });
});

describe("nothing private or local reaches the archive", () => {
  test("dev material would be refused", () => {
    const files = soundArchive();
    files["dev/test/release.test.ts"] = encode("// tests\n");
    files["node_modules/fflate/index.js"] = encode("// dep\n");
    expect(faultsOf(files, "G5")).toHaveLength(2);
  });

  test("a local filesystem path in any shipped file would be refused", () => {
    for ( const leak of ["/home/someone/Projects/x", "C:\\Users\\someone\\x", "/Users/someone/x"] ) {
      const files = soundArchive();
      files["README.md"] = encode(`built from ${leak}\n`);
      expect(faultsOf(files, "G6")).toHaveLength(1);
    }
  });
});

describe("the module as it stands today ships complete", () => {
  test("the derived ship list names only files that exist", () => {
    const { missing } = shipList(manifest);
    expect(missing).toEqual([]);
  });

  test("every gate passes on an archive built from the real tree", () => {
    // The regression this leaves behind: a file added to the module and reachable
    // only through an import or a runtime route fails here before it fails for an
    // installer.
    const { paths } = shipList(manifest);
    expect(failedGates(buildArchive(paths))).toEqual([]);
  });

  test("the ship list carries the files the manifest cannot name", () => {
    const { paths } = shipList(manifest);
    expect(paths).toContain("data/checks.json");
    expect(paths).toContain("scripts/tours.mjs");
  });
});

describe("the forms the first version of this gate could not see", () => {
  // Every case here passed all six original gates. They are grouped because they
  // share one cause: the gate derived from two import spellings and checked only
  // that files were present.

  test("a bare side-effect import is an import", () => {
    // `import "./x.mjs";` matched neither original regex, so the file was neither
    // derived into the ship list nor checked. The old negative control used the
    // `from` spelling, so it proved the half that already worked.
    const files = soundArchive();
    files["scripts/module.mjs"] = encode(`import "./polyfill.mjs";\n`);
    expect(faultsOf(files, "G2")[0]).toContain("polyfill.mjs");
  });

  test("a shipped script that does not parse is caught", () => {
    const files = soundArchive();
    files["scripts/module.mjs"] = encode(`export function run( {\n`);
    expect(faultsOf(files, "G8")[0]).toContain("not valid JavaScript");
  });

  test("a shipped JSON file that does not parse is caught", () => {
    const files = soundArchive();
    files["data/checks.json"] = encode(`[ {"id": "a",, ]\n`);
    expect(faultsOf(files, "G8")[0]).toContain("not valid JSON");
  });

  test("rows the module fetches at runtime are run through its own validator", () => {
    // The sibling commit taught `validateChecks` to refuse a prerequisite loop.
    // Without this gate that was true of a test and not of a release, because the
    // rows are data and shipped unexamined.
    const files = soundArchive();
    files["data/checks.json"] = encode(JSON.stringify([
      { id: "a", week: 1, competency: "c", topic: "t", scope: "scene", predicate: { op: "truthy", path: "x" }, message: "m", done: "d", hint: "h", needs: "b" },
      { id: "b", week: 1, competency: "c", topic: "t", scope: "scene", predicate: { op: "truthy", path: "x" }, message: "m", done: "d", hint: "h", needs: "a" }
    ]));
    expect(faultsOf(files, "G9")[0]).toContain("prerequisite loop");
  });

  test("a file a stylesheet references is checked", () => {
    const files = soundArchive();
    files["styles/game-night-ready.css"] = encode(
      `@font-face{src:url(fonts/rune.woff2)}\n.gnr{background:url("img/logo.png")}\n`);
    const faults = faultsOf(files, "G7");
    expect(faults).toHaveLength(2);
    expect(faults.join(" ")).toContain("rune.woff2");
  });

  test("a remote or inline stylesheet reference is not ours to ship", () => {
    const files = soundArchive();
    files["styles/game-night-ready.css"] = encode(
      `@font-face{src:url(https://fonts.example/x.woff2)}\n.gnr{background:url(data:image/gif;base64,AA)}\n`);
    expect(faultsOf(files, "G7")).toEqual([]);
  });

  test("the two manifest keys that also carry paths are checked", () => {
    const files = soundArchive();
    files["module.json"] = encode(JSON.stringify({
      id: manifest.id,
      version: manifest.version,
      compatibility: { minimum: "14", verified: "14.365" },
      esmodules: ["scripts/module.mjs"],
      scripts: ["scripts/legacy.js"],
      packs: [{ name: "gear", path: "packs/gear", type: "Item" }]
    }));
    const faults = faultsOf(files, "G1").join(" ");
    expect(faults).toContain("scripts/legacy.js");
    expect(faults).toContain("packs/gear");
  });
});

describe("a route the gate cannot resolve is said out loud", () => {
  // Silence was the old behaviour, and in one shape it was worse than silence: a
  // route built from a template prefix produced a fault naming a directory as
  // though it were the missing file.

  test("a concatenated route is reported as uncheckable", () => {
    const files = soundArchive();
    files["scripts/module.mjs"] = encode(`const u = getRoute("modules/" + MODULE_ID + "/data/checks.json");\n`);
    expect(faultsOf(files, "G3").join(" ")).toContain("cannot be checked from here");
  });

  test("an interpolated tail is reported as uncheckable", () => {
    const files = soundArchive();
    files["scripts/module.mjs"] = encode(
      "const u = getRoute(`modules/${MODULE_ID}/${dir}/checks.json`);\n");
    expect(faultsOf(files, "G3").join(" ")).toContain("cannot be checked from here");
  });

  test("a directory prefix is never reported as a missing file", () => {
    const files = soundArchive();
    files["scripts/module.mjs"] = encode(
      "const P = `modules/${MODULE_ID}/templates/`;\nrenderTemplate(P + \"report.hbs\");\n");
    const faults = faultsOf(files, "G3").join(" ");
    expect(faults).toContain("cannot be checked from here");
    expect(faults).not.toContain('fetches "templates/"');
  });

  test("a fully literal route still resolves", () => {
    const files = soundArchive();
    expect(faultsOf(files, "G3")).toEqual([]);
  });
});

describe("the leak tripwire covers the shapes that would plausibly occur", () => {
  const SHAPES = [
    "built on /home/someone",
    "~/Projects/game-night-ready",
    "\\\\wsl$\\Ubuntu\\home\\someone\\x",
    "/root/secrets",
    "someone@example.com",
    "/Users/someone2/x",
    "C:\\Users\\someone\\x",
    "$HOME/.config"
  ];
  test.each(SHAPES)("caught: %s", shape => {
    const files = soundArchive();
    files["README.md"] = encode(`# Game Night Ready\n${shape}\n`);
    expect(faultsOf(files, "G6").length).toBeGreaterThan(0);
  });

  test("the module as it stands trips none of them", () => {
    const { paths } = shipList(manifest);
    expect(faultsOf(buildArchive(paths), "G6")).toEqual([]);
  });
});

describe("G10, the manifest-to-archive pairing Foundry resolves", () => {
  const served = (over: Record<string, unknown> = {}) =>
    ({ id: manifest.id, version: "0.3.0", download: "https://example.invalid/module.zip", ...over });
  const inner = (over: Record<string, unknown> = {}) =>
    ({ id: manifest.id, version: "0.3.0", ...over });

  test("a manifest and the archive it names agreeing on id and version passes", () => {
    expect(pairingGate(served(), inner()).faults).toEqual([]);
  });

  // The F14 class: the manifest a pinned tag serves resolves to the newest zip,
  // because every release's download points at releases/latest. Nine gates over
  // the archive alone cannot see it, since the archive is internally sound.
  test("a served manifest pointing at an archive of another version is reported", () => {
    const faults = pairingGate(served({ version: "0.2.0" }), inner({ version: "0.3.0" })).faults;
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.join(" ")).toContain("0.2.0");
    expect(faults.join(" ")).toContain("0.3.0");
  });

  test("a served manifest naming another module's archive is reported", () => {
    expect(pairingGate(served(), inner({ id: "some-other-module" })).faults.length).toBeGreaterThan(0);
  });

  test("a served manifest with no download URL is reported", () => {
    expect(pairingGate(served({ download: undefined }), inner()).faults.join(" ")).toContain("no download URL");
  });

  test("an archive with no readable manifest is reported", () => {
    expect(pairingGate(served(), null).faults.join(" ")).toContain("no readable module.json");
  });

  test("a served manifest with no version is reported", () => {
    expect(pairingGate(served({ version: undefined }), inner()).faults.join(" ")).toContain("no version");
  });

  test("an archive manifest with no version is reported", () => {
    expect(pairingGate(served(), inner({ version: undefined })).faults.join(" ")).toContain("declares no version");
  });
});
