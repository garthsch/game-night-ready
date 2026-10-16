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

describe("ISC-26 — no check reads a DOM selector", () => {
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

describe("ISC-23 — a new check is a row, not a code path", () => {
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

describe("ISC-27 — tier one carries no AI dependency and names no adventure", () => {
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

describe("ISC-30 — the module cannot gate or mutate anything", () => {
  const entry = SOURCES.find(s => s.file === "module.mjs")!.text;

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

  test("the only write anywhere is the module's own setting", () => {
    const writes = SOURCES.flatMap(s =>
      [...s.text.matchAll(/\.(update|create|delete|createEmbeddedDocuments|updateEmbeddedDocuments|deleteEmbeddedDocuments)\(/g)]
        .map(m => `${s.file}:${m[1]}`));
    expect(writes).toEqual([]);
    expect(entry).toContain("game.settings.set(MODULE_ID, SETTINGS.BASELINE");
  });
});

describe("ISC-22 — the manifest", () => {
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

describe("ISC-29 — the report says what it does not assess", () => {
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
