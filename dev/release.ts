/**
 * Build the release archive, and refuse to ship an incomplete one.
 *
 * Why this exists. v0.2.0 was published with a `module.zip` of twelve files that
 * did not include `scripts/tours.mjs`, while `scripts/report.mjs` imports it at
 * the top. Anyone installing from the manifest got a module that failed to resolve
 * on load. The check that passed before that release confirmed the manifest and
 * download URLs resolved, which is a fact about GitHub rather than about the
 * archive's contents.
 *
 * So the ship list is derived rather than typed out, and every derivation is then
 * re-checked against the built archive:
 *
 *   - what `module.json` declares: esmodules, styles, language files, licence
 *   - what the shipped code imports, followed transitively through `./x.mjs`
 *   - what the shipped code fetches at runtime through a `modules/<id>/...` route,
 *     which is how `data/checks.json` arrives and is the one input the manifest
 *     never mentions
 *
 * Both halves matter. Deriving the list means a new file is picked up without
 * anyone remembering to add it here; re-checking the built archive means a bug in
 * the derivation is caught before publication rather than by an installer.
 *
 * Usage:
 *   bun dev/release.ts                 build dist/ and gate it
 *   bun dev/release.ts verify <path>   gate an archive already built or published
 *   bun dev/release.ts verify <url>    the same, fetched over the network
 *   bun dev/release.ts --publish       build, gate, then cut the GitHub release
 *
 * Exit codes: 0 every gate passed, 1 a gate failed, 2 the run could not proceed.
 */

import { zipSync, unzipSync } from "fflate";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = join(ROOT, "dist");

/** Files shipped for their own sake, named because nothing references them. */
const ALWAYS = ["module.json", "README.md", "LICENSE"];

/** A path inside the module that must never reach the archive. */
const NEVER = [/^dev\//, /node_modules/, /^\.git/, /^dist\//];

export type Archive = Record<string, Uint8Array>;

/** A gate's verdict. `faults` empty means it passed. */
interface Gate {
  id: string;
  claim: string;
  faults: string[];
}

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, path)));
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Paths `module.json` declares. The manifest is the contract Foundry reads. */
function declaredPaths(manifest: any): string[] {
  const paths: string[] = [];
  for ( const key of ["esmodules", "styles"] ) {
    for ( const entry of manifest[key] ?? [] ) paths.push(entry);
  }
  for ( const language of manifest.languages ?? [] ) {
    if ( language?.path ) paths.push(language.path);
  }
  // `license` and `readme` may be a path or a URL; only a path has to be in the zip.
  for ( const key of ["license", "readme"] ) {
    const value = manifest[key];
    if ( (typeof value === "string") && !value.startsWith("http") ) paths.push(value);
  }
  return paths;
}

/**
 * Every relative import in a source file, as written.
 *
 * Static `from "./x.mjs"` and dynamic `import("./x.mjs")` both count: either one
 * fails the module at load time when its target is missing from the archive.
 */
function relativeImports(source: string): string[] {
  const found = new Set<string>();
  for ( const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g) ) found.add(match[1]);
  for ( const match of source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g) ) found.add(match[1]);
  return [...found];
}

/**
 * Every module-relative route the code fetches at runtime.
 *
 * `foundry.utils.getRoute(`modules/${MODULE_ID}/data/checks.json`)` is the real
 * case: a file the module cannot run without and the manifest never names. Matched
 * on the literal tail so an interpolated module id still resolves.
 */
function runtimeRoutes(source: string, moduleId: string): string[] {
  const found = new Set<string>();
  const patterns = [
    new RegExp(`modules/${moduleId}/([A-Za-z0-9_./-]+)`, "g"),
    /modules\/\$\{[A-Za-z_][A-Za-z0-9_]*\}\/([A-Za-z0-9_./-]+)/g
  ];
  for ( const pattern of patterns ) {
    for ( const match of source.matchAll(pattern) ) found.add(match[1]);
  }
  return [...found];
}

/** Resolve an import as written against the importing file's own directory. */
function resolveFrom(importer: string, specifier: string): string {
  return normalize(join(dirname(importer), specifier)).replace(/\\/g, "/");
}

/**
 * The ship list, derived from the manifest and then from the code it names.
 *
 * Walks imports transitively, so a file reachable only through two hops is still
 * shipped. A missing file is collected rather than thrown on, because the gates
 * report every fault at once instead of the first one.
 */
export function shipList(manifest: any): { paths: string[]; missing: string[] } {
  const wanted = new Set<string>([...ALWAYS, ...declaredPaths(manifest)]);
  const missing: string[] = [];
  const queue = [...wanted];
  const walked = new Set<string>();

  while ( queue.length ) {
    const path = queue.shift()!;
    if ( walked.has(path) ) continue;
    walked.add(path);
    if ( !existsSync(join(ROOT, path)) ) {
      missing.push(path);
      continue;
    }
    if ( !/\.(mjs|js)$/.test(path) ) continue;
    const source = text(read(path));
    for ( const specifier of relativeImports(source) ) {
      const target = resolveFrom(path, specifier);
      wanted.add(target);
      queue.push(target);
    }
    for ( const route of runtimeRoutes(source, manifest.id) ) {
      wanted.add(route);
      queue.push(route);
    }
  }
  return { paths: [...wanted].sort(), missing };
}

/** Build the archive in memory, deterministically: sorted entries, fixed mtime. */
export function buildArchive(paths: string[]): Archive {
  const files: Archive = {};
  for ( const path of paths.slice().sort() ) files[path] = read(path);
  return files;
}

function zip(files: Archive): Uint8Array {
  // A fixed mtime keeps two builds of the same tree byte-identical, so a rebuild
  // that changes the zip means the tree changed. Zip stores a DOS date, whose
  // epoch is 1980, so that is the earliest value it can carry.
  const mtime = Date.UTC(1980, 0, 1);
  const entries: Record<string, [Uint8Array, { mtime: number }]> = {};
  for ( const [path, bytes] of Object.entries(files) ) entries[path] = [bytes, { mtime }];
  return zipSync(entries as any, { level: 9 });
}

/**
 * Every gate, run against an archive rather than against the working tree.
 *
 * The distinction is the whole point: the tree was always complete, and the thing
 * that shipped was not.
 */
export function gate(files: Archive, manifest: any, strictVersion = true): Gate[] {
  const has = (path: string) => Object.prototype.hasOwnProperty.call(files, path);
  const sources = Object.keys(files).filter(path => /\.(mjs|js)$/.test(path));
  const gates: Gate[] = [];

  gates.push({
    id: "G1",
    claim: "every path module.json declares is in the archive",
    faults: declaredPaths(manifest).filter(path => !has(path)).map(path => `declared but absent: ${path}`)
  });

  const importFaults: string[] = [];
  for ( const path of sources ) {
    for ( const specifier of relativeImports(text(files[path])) ) {
      const target = resolveFrom(path, specifier);
      if ( !has(target) ) importFaults.push(`${path} imports "${specifier}", which is not in the archive`);
    }
  }
  gates.push({ id: "G2", claim: "every relative import resolves inside the archive", faults: importFaults });

  const routeFaults: string[] = [];
  for ( const path of sources ) {
    for ( const route of runtimeRoutes(text(files[path]), manifest.id) ) {
      if ( !has(route) ) routeFaults.push(`${path} fetches "${route}" at runtime, which is not in the archive`);
    }
  }
  gates.push({ id: "G3", claim: "every runtime module route resolves inside the archive", faults: routeFaults });

  // Version agreement is a claim about a build, not about an archive. Gating an
  // already-published archive compares it with whatever the tree says today, which
  // is how a correct old release gets reported as wrong; `strictVersion` is off for
  // `verify` so an archive is judged against its own contents.
  const versionFaults: string[] = [];
  if ( !has("module.json") ) versionFaults.push("the archive has no module.json, so Foundry cannot install it");
  else {
    try {
      const inner = JSON.parse(text(files["module.json"]));
      if ( !inner.version ) versionFaults.push("the archive's module.json declares no version");
      if ( strictVersion && (inner.version !== manifest.version) ) {
        versionFaults.push(`archive declares ${inner.version}, this build declares ${manifest.version}`);
      }
      if ( !inner.compatibility?.verified ) versionFaults.push("compatibility.verified is not declared");
    }
    catch ( err: any ) { versionFaults.push(`module.json in the archive is not valid JSON: ${err.message}`); }
  }
  gates.push({
    id: "G4",
    claim: strictVersion
      ? "the archive's manifest matches this build and names a verified build"
      : "the archive's manifest is well-formed and names a verified build",
    faults: versionFaults
  });

  gates.push({
    id: "G5",
    claim: "no dev material is in the archive",
    faults: Object.keys(files).filter(path => NEVER.some(pattern => pattern.test(path)))
      .map(path => `dev material would ship: ${path}`)
  });

  // The repository is public and the archive is the thing strangers download, so
  // this is the last place a local path or a home directory can be caught.
  const leakFaults: string[] = [];
  for ( const [path, bytes] of Object.entries(files) ) {
    const content = text(bytes);
    for ( const pattern of [/\/home\/[a-z]+\//i, /C:\\Users\\/i, /\/Users\/[a-z]+\//i] ) {
      if ( pattern.test(content) ) leakFaults.push(`${path} contains a local filesystem path`);
    }
  }
  gates.push({ id: "G6", claim: "no local path reaches the archive", faults: [...new Set(leakFaults)] });

  return gates;
}

function report(gates: Gate[], label: string): boolean {
  const failed = gates.filter(g => g.faults.length);
  console.log(`\n${label}`);
  for ( const g of gates ) {
    const mark = g.faults.length ? "FAIL" : "pass";
    console.log(`  ${mark}  ${g.id}  ${g.claim}`);
    for ( const fault of g.faults ) console.log(`          ${fault}`);
  }
  console.log(failed.length ? `\n${failed.length} gate(s) failed: nothing is published.` : "\nEvery gate passed.");
  return failed.length === 0;
}

async function loadArchive(source: string): Promise<Archive> {
  if ( /^https?:\/\//.test(source) ) {
    const response = await fetch(source, { redirect: "follow" });
    if ( !response.ok ) throw new Error(`${source} returned ${response.status}`);
    return unzipSync(new Uint8Array(await response.arrayBuffer()));
  }
  return unzipSync(new Uint8Array(readFileSync(source)));
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));

  if ( args[0] === "verify" ) {
    const source = args[1];
    if ( !source ) {
      console.error("verify needs a path or a URL to an archive");
      process.exit(2);
    }
    const files = await loadArchive(source);
    console.log(`${Object.keys(files).length} file(s) in ${source}`);
    process.exit(report(gate(files, manifest, false), `Gates against ${source}`) ? 0 : 1);
  }

  const { paths, missing } = shipList(manifest);
  if ( missing.length ) {
    console.error("the ship list names files that are not in the tree:");
    for ( const path of missing ) console.error(`  ${path}`);
    process.exit(1);
  }

  const files = buildArchive(paths);
  const ok = report(gate(files, manifest), `Gates against a ${paths.length}-file archive for ${manifest.version}`);
  if ( !ok ) process.exit(1);

  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "module.zip"), zip(files));
  writeFileSync(join(DIST, "module.json"), files["module.json"]);
  const size = statSync(join(DIST, "module.zip")).size;
  console.log(`\nBuilt ${relative(ROOT, join(DIST, "module.zip"))} (${size} bytes, ${paths.length} files)`);
  for ( const path of paths ) console.log(`  ${path}`);

  // Re-gated after the round trip, because the archive Foundry reads is the one
  // on disk rather than the one assembled in memory.
  const written = unzipSync(new Uint8Array(readFileSync(join(DIST, "module.zip"))));
  if ( !report(gate(written, manifest), "Gates against the archive as written") ) process.exit(1);

  if ( !args.includes("--publish") ) {
    console.log(`\nNot published. Add --publish to cut v${manifest.version} with gh.`);
    return;
  }
  const tag = `v${manifest.version}`;
  const notes = `Built and gated by dev/release.ts: ${paths.length} files, every declared path,`
    + " every relative import and every runtime route resolved inside the archive.";
  const result = Bun.spawnSync(["gh", "release", "create", tag, join(DIST, "module.json"), join(DIST, "module.zip"),
    "--title", tag, "--notes", notes], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  process.exit(result.exitCode ?? 1);
}

if ( import.meta.main ) {
  main().catch(err => {
    console.error(err.message);
    process.exit(2);
  });
}
