import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks, STATUS } from "../scripts/evaluator.mjs";
import { buildReportHtml, HUMAN_ASSESSED } from "../scripts/report.mjs";
import checks from "../data/checks.json";

const ROOT = join(import.meta.dir, "..");
const SOURCES = readdirSync(join(ROOT, "scripts"))
  .filter(f => f.endsWith(".mjs"))
  .map(f => ({ file: f, text: readFileSync(join(ROOT, "scripts", f), "utf8") }));

describe("no check reads a DOM selector", () => {
  // Selector and DOM-traversal APIs. A check must resolve through the document
  // model, which is typed and versioned; markup is neither.
  const BANNED = [
    "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName",
    "getElementsByTagName", "closest(", "nth-child", "document.body", "$(", "jQuery",
    ".innerText", "XPath", "evaluateXPath"
  ];
  for ( const { file, text } of SOURCES ) {
    test(`${file} contains no selector API`, () => {
      const found = BANNED.filter(needle => text.includes(needle));
      expect(found).toEqual([]);
    });
  }
  test("no check row expresses a predicate as a selector string", () => {
    const serialised = JSON.stringify(checks);
    for ( const needle of ["querySelector", "nth-child", "#", "document."] ) {
      expect(serialised.includes(needle)).toBe(false);
    }
  });
  test("every row's predicate resolves through named document fields only", () => {
    const paths: string[] = [];
    const walk = (p: any) => {
      if ( !p || typeof p !== "object" ) return;
      if ( typeof p.path === "string" ) paths.push(p.path);
      if ( p.where ) walk(p.where);
      if ( p.of ) (Array.isArray(p.of) ? p.of : [p.of]).forEach(walk);
    };
    checks.forEach(r => walk(r.predicate));
    expect(paths.length).toBeGreaterThan(0);
    for ( const path of paths ) {
      // Dot-separated identifiers, nothing else: no CSS, no indexing, no calls.
      expect(path).toMatch(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
    }
  });
});

describe("a new check is a row, not a code path", () => {
  test("a row invented here runs with no change to any source file", () => {
    // This row does not exist in data/checks.json. It exercises an operator
    // combination no shipped row uses. If it runs, the evaluator is generic.
    const novel = {
      id: "invented.regions.used",
      week: 6,
      competency: "Canvas and spatial calibration",
      scope: "scene",
      predicate: {
        op: "all_of",
        of: [
          { op: "count_gte", path: "regions", value: 1 },
          { op: "none", path: "regions", where: { op: "absent", path: "name" } }
        ]
      },
      message: "No scene region is defined.",
      hint: "Use the Regions tool."
    };
    const scene = { regions: [{ id: "r1", name: "Upper floor" }] };
    const [result] = runChecks([novel], { scene });
    expect(result.status).toBe(STATUS.PASS);

    const failing = runChecks([novel], { scene: { regions: [] } });
    expect(failing[0].status).toBe(STATUS.OUTSTANDING);
  });

  test("the operator set is closed, so adding one is a deliberate change here too", () => {
    const text = SOURCES.find(s => s.file === "predicate.mjs")!.text;
    const ops = [...text.matchAll(/case "([a-z_]+)":/g)].map(m => m[1]);
    const combinators = ["any_of", "all_of", "not"];
    expect([...new Set(ops)].concat(combinators).sort()).toEqual([
      "absent", "all_of", "any_of", "count_gte", "eq", "every", "exists", "falsy",
      "gt", "gte", "in", "lt", "lte", "neq", "none", "not", "some", "truthy"
    ]);
  });
});

describe("no AI dependency, and no adventure named", () => {
  const allText = [
    ...SOURCES.map(s => s.text),
    readFileSync(join(ROOT, "module.json"), "utf8"),
    JSON.stringify(checks)
  ].join("\n").toLowerCase();

  test("no AI service, model or API appears anywhere in the module", () => {
    for ( const needle of ["openai", "anthropic", "claude", "gpt-", "gemini", "llm", "api_key", "apikey"] ) {
      expect(allText.includes(needle)).toBe(false);
    }
  });
  test("no published adventure is named", () => {
    for ( const needle of ["scarlet minotaur", "lost citadel", "baileywiki", "curse of strahd", "arcane library"] ) {
      expect(allText.includes(needle)).toBe(false);
    }
  });
  test("no network call leaves the Foundry server", () => {
    for ( const { file, text } of SOURCES ) {
      const fetches = [...text.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]);
      for ( const arg of fetches ) {
        expect(arg.includes("http://") || arg.includes("https://")).toBe(false);
      }
    }
  });
});

describe("the module cannot gate or mutate anything", () => {
  const entry = SOURCES.find(s => s.file === "module.mjs")!.text;

  test("every lang key the code references exists in en.json", () => {
    const lang = JSON.parse(readFileSync(join(ROOT, "lang/en.json"), "utf8"));
    const referenced = SOURCES.flatMap(s =>
      [...s.text.matchAll(/"(GAME_NIGHT_READY\.[A-Za-z]+)"/g)].map(m => m[1]));
    expect(referenced.length).toBeGreaterThan(0);
    // Flat keys with literal dots, so compare against the key list: toHaveProperty
    // would read the dot as a nested path and report every key missing.
    for ( const key of new Set(referenced) ) expect(Object.keys(lang)).toContain(key);
  });

  test("the button is injected into groups that own real tools, never a standalone group", () => {
    // v14: activeTool resolution filters out button and toggle tools, and a
    // tool's onChange fires only on a tool change. A group whose only tool is
    // a button resolves no active tool, renders, and does nothing on click.
    expect(entry).toContain('const BUTTON_IN = ["tokens", "walls", "lighting"]');
    expect(entry).not.toContain("controls[MODULE_ID] =");
    expect(entry).toContain("group.tools.gameNightReady");
    expect(entry).toContain("button: true");
  });

  test("the button covers the layers where scene preparation happens", () => {
    const match = entry.match(/const BUTTON_IN = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    for ( const layer of ["tokens", "walls", "lighting"] ) {
      expect(match![1]).toContain(layer);
    }
  });

  test("the keybinding is GM-restricted, like the button", () => {
    expect(entry).toContain("game.keybindings.register");
    expect(entry).toContain("restricted: true");
  });

  test("no cancellable pre* hook is registered", () => {
    const hooks = [...entry.matchAll(/Hooks\.(?:on|once)\("([A-Za-z]+)"/g)].map(m => m[1]);
    expect(hooks.length).toBeGreaterThan(0);
    for ( const hook of hooks ) expect(hook.startsWith("pre")).toBe(false);
  });

  test("no hook callback returns false, which is how a Foundry hook cancels", () => {
    for ( const { file, text } of SOURCES ) {
      if ( file === "predicate.mjs" ) continue; // pure logic, not a hook callback
      expect(text.includes("return false")).toBe(false);
    }
  });

  test("the only document write anywhere is the module's own setting", () => {
    // Capture the receiver, not just the method name: `cache.delete(id)` on a
    // local Map is not a document write, and a bare method-name grep cannot
    // tell the two apart. Receivers allowed here are local data structures.
    const LOCAL = ["cache"];
    const writes = SOURCES.flatMap(s =>
      [...s.text.matchAll(/([A-Za-z_$][\w$]*)\.(update|create|delete|createEmbeddedDocuments|updateEmbeddedDocuments|deleteEmbeddedDocuments)\(/g)]
        .filter(m => !LOCAL.includes(m[1]))
        .map(m => `${s.file}: ${m[1]}.${m[2]}()`));
    expect(writes).toEqual([]);
    expect(entry).toContain("game.settings.set(MODULE_ID, SETTINGS.BASELINE");
  });

  test("every watched-document listener is a plain read-only hook", () => {
    const state = SOURCES.find(s => s.file === "state.mjs")!.text;
    // The refresh listeners are generated from this list, so a `pre` prefix
    // could never reach them, but assert the list itself stays document names.
    const match = state.match(/WATCHED_DOCUMENTS = \[([^\]]*)\]/s);
    expect(match).not.toBeNull();
    for ( const name of match![1].split(",").map(s => s.trim().replace(/"/g, "")).filter(Boolean) ) {
      expect(name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(name.startsWith("pre")).toBe(false);
    }
    expect(entry).toContain('for ( const op of ["create", "update", "delete"] )');
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
  test("declares minimum core 14", () => {
    expect(manifest.compatibility.minimum).toBe("14");
  });
  test("declares a verified patch version", () => {
    expect(manifest.compatibility.verified).toMatch(/^14\.\d+$/);
  });
  test("requires nothing: no relationships block at all", () => {
    expect(manifest.relationships).toBeUndefined();
  });
  test("carries the three URLs Foundry needs to install and update", () => {
    expect(manifest.url).toBe("https://github.com/garthsch/game-night-ready");
    expect(manifest.manifest).toMatch(/\/releases\/latest\/download\/module\.json$/);
    expect(manifest.download).toMatch(/\/releases\/latest\/download\/module\.zip$/);
  });

  test("registers via an esmodule, since there is no tours field in v14", () => {
    expect(manifest.esmodules).toEqual(["scripts/module.mjs"]);
    expect(manifest.tours).toBeUndefined();
  });
  test("every file the manifest names exists", () => {
    const named = [
      ...manifest.esmodules,
      ...manifest.styles,
      ...manifest.languages.map((l: any) => l.path)
    ];
    for ( const path of named ) {
      expect(() => readFileSync(join(ROOT, path), "utf8")).not.toThrow();
    }
  });
});

describe("the report says what it does not assess", () => {
  const results = runChecks(checks, { scene: null, world: null, user: null });
  const html = buildReportHtml(results, { sceneName: "Keep, upper floor" });

  test("facilitation is reported as human-assessed", () => {
    expect(HUMAN_ASSESSED.some(h => /facilitation/i.test(h.name))).toBe(true);
    expect(html).toContain("Facilitation and troubleshooting");
    expect(html.toLowerCase()).toContain("not machine-assessable");
  });
  test("server reachability is declared invisible from inside the client", () => {
    expect(html.toLowerCase()).toMatch(/not visible from here/);
  });
  test("the report distinguishes completeness from correctness", () => {
    expect(html.toLowerCase()).toContain("completeness, not whether your choices were right");
  });
  test("the report names the scene it read", () => {
    expect(html).toContain("Keep, upper floor");
  });
  test("row content is escaped, so a world or scene name cannot inject markup", () => {
    const injected = buildReportHtml(results, { sceneName: '<img src=x onerror="alert(1)">' });
    expect(injected).not.toContain("<img");
    expect(injected).toContain("&lt;img");
  });
});

describe("the verdict headline is the name, and it is a claim", () => {
  const { verdict } = require("../scripts/report.mjs");

  test("all passing, all readable: the module says the name", () => {
    expect(verdict({ pass: 14, outstanding: 0, unavailable: 0, error: 0 }))
      .toEqual({ state: "ready", label: "Game Night Ready." });
  });

  test("anything outstanding: not ready, with the count", () => {
    const { state, label } = verdict({ pass: 4, outstanding: 10, unavailable: 0, error: 0 });
    expect(state).toBe("not-ready");
    expect(label).toContain("10 outstanding");
  });

  test("nothing outstanding but something unreadable: never claims ready", () => {
    const { state, label } = verdict({ pass: 13, outstanding: 0, unavailable: 1, error: 0 });
    expect(state).toBe("unknown");
    expect(label).not.toContain("Game Night Ready");
    expect(label).toContain("1 check could not be read");
  });

  test("outstanding AND unreadable together: reports both, never just the gap count", () => {
    // Found live: with no scene open, 11 scene checks are unreadable while two
    // world checks are genuinely outstanding. Reporting "2 outstanding" alone
    // implies the module looked at everything and found exactly two.
    const { state, label } = verdict({ pass: 0, outstanding: 2, unavailable: 11, error: 0 });
    expect(state).toBe("not-ready");
    expect(label).toContain("2 outstanding");
    expect(label).toContain("11 checks could not be read");
    expect(label).toContain("not the whole picture");
  });

  test("a clean read needs no caveat clause", () => {
    expect(verdict({ pass: 4, outstanding: 10, unavailable: 0, error: 0 }).label)
      .toBe("Not game night ready yet: 10 outstanding.");
  });

  test("a broken check also blocks the ready claim, and counts with the unreadable", () => {
    const { state, label } = verdict({ pass: 12, outstanding: 0, unavailable: 1, error: 1 });
    expect(state).toBe("unknown");
    expect(label).toContain("2 checks could not be read");
  });

  test("the rendered report carries the verdict above the counts", () => {
    const ready = buildReportHtml(
      [{ id: "a", week: 1, competency: "X", scope: "scene", status: "pass", message: "m", hint: "h" }],
      { sceneName: "Keep" }
    );
    expect(ready).toContain("gnr-verdict-ready");
    expect(ready.indexOf("gnr-verdict")).toBeLessThan(ready.indexOf("gnr-headline"));
  });

  test("a no-scene run reports can't-tell, not ready", () => {
    const results = runChecks(checks, { scene: null, world: null, user: null });
    const html = buildReportHtml(results, {});
    expect(html).toContain("gnr-verdict-unknown");
    expect(html).not.toContain("gnr-verdict-ready");
  });
});

describe("report ordering and labels, found by looking at the real dialog", () => {
  test("no week number reaches the rendered report", () => {
    const results = runChecks(checks, {
      scene: { id: "s", name: "S", grid: { size: 100, type: 1 }, tokenVision: true,
        environment: { globalLight: { enabled: false } },
        levels: [], walls: [], lights: [], tokens: [], notes: [] },
      world: { activeModuleCount: 0, journal: [], players: [] },
      user: null
    });
    const html = buildReportHtml(results, { sceneName: "S" });
    expect(html).not.toContain("gnr-week");
    expect(html.toLowerCase()).not.toMatch(/>week \d/);
    // Still in the data, because the course view needs it.
    expect(checks.every(r => typeof r.week === "number")).toBe(true);
  });

  test("groups with outstanding work sort above finished ones", () => {
    // The live report put a week-1 Vanilla-first row below week-5 rows purely
    // because its competency appeared later in checks.json.
    const results = [
      { id: "a", competency: "Finished", status: "pass", week: 1, message: "m", hint: "h" },
      { id: "b", competency: "Has work", status: "outstanding", week: 9, message: "m", hint: "h" },
      { id: "c", competency: "Has work", status: "outstanding", week: 9, message: "m", hint: "h" }
    ];
    const html = buildReportHtml(results as any, {});
    expect(html.indexOf("Has work")).toBeLessThan(html.indexOf("Finished"));
  });

  test("the verdict is pinned inside a bounded scroll container", () => {
    // Measured live: unbounded, the dialog rendered 1926px tall at y=-215, so
    // the verdict was off the top of the screen. Sticky alone cannot fix that;
    // it needs a scrolling ancestor.
    const css = readFileSync(join(ROOT, "styles/game-night-ready.css"), "utf8");
    expect(css).toMatch(/\.gnr-verdict\s*\{[^}]*position: sticky/s);
    expect(css).toMatch(/\.game-night-ready\s*\{[^}]*max-height/s);
    expect(css).toMatch(/\.game-night-ready\s*\{[^}]*overflow-y: auto/s);
  });
});
