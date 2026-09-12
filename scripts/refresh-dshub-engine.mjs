#!/usr/bin/env node
/**
 * Refresh the `dshub-hub` distributable's ENGINE from the tracked wasm build.
 *
 * `dist-pkg/` is gitignored and was originally assembled by hand, so the
 * tarball it holds could not be traced to a commit: the one canvasgrid
 * vendored was cut two hours BEFORE this repo's first commit and shipped a
 * wasm that matched no revision. This script fixes the half of that which is
 * mechanical, and records what it did.
 *
 * Mechanical, precisely: `runtime/dshub.js` and `runtime/dshub_bg.wasm` are
 * byte copies of `hub-rust/pkg/`. Nothing is authored here -- verified by
 * hashing the pair in the previous tarball against `pkg/` at the commit it was
 * cut from (they matched). The glue and the binary are taken from the same
 * `pkg/`, so the wasm-bindgen ABI pairing cannot drift.
 *
 * NOT refreshed: `lib/`. That is compiled TypeScript from
 * `apps/dshub-react-perspective/src/` with workspace imports rewritten to
 * bundled relative paths, and two of its files (`index.js`, `liveTicks.js`)
 * have no tracked source at all. Reproducing it means deciding what the
 * package's public API is and how imports are rewritten -- product decisions,
 * not a script. Until those sources land, `lib/` stays at whatever the last
 * hand-build produced, and PROVENANCE.json says so rather than implying the
 * whole package is traceable.
 *
 * Usage:  node scripts/refresh-dshub-engine.mjs [--version X.Y.Z]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'hub-rust', 'pkg');
const DIST = join(ROOT, 'dist-pkg', 'dshub-hub');
const PLANE_SRC = join(ROOT, 'packages', 'dshub-plane', 'src');
/** The engine pair: glue + binary, always taken together. */
const ENGINE = ['dshub.js', 'dshub_bg.wasm'];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

for (const dir of [PKG, DIST]) {
  if (!existsSync(dir)) {
    console.error(`missing ${dir}`);
    process.exit(1);
  }
}

// A pin is only worth having if it names a commit, so refuse to stamp one
// that would be a lie.
const dirty = git('status', '--porcelain', '--', 'hub-rust/pkg');
if (dirty) {
  console.error('hub-rust/pkg has uncommitted changes:');
  console.error(dirty);
  console.error('\nCommit the wasm build first -- a stamped artifact must name a real revision.');
  process.exit(1);
}
const commit = git('rev-parse', 'HEAD');
const engineCommit = git('log', '-1', '--format=%H', '--', 'hub-rust/pkg');

const argv = process.argv.slice(2);
const versionArg = argv.indexOf('--version');
const manifestPath = join(DIST, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const before = ENGINE.map((f) => sha256(join(DIST, 'runtime', f)));

for (const f of ENGINE) copyFileSync(join(PKG, f), join(DIST, 'runtime', f));

// The plane ships as TypeScript SOURCE, not compiled output. Consumers of
// this tarball are TS repos that already build from source (canvasgrid's own
// packages resolve to `./src/index.ts`), and shipping source keeps the plane
// traceable the way `lib/` is not: every file below is tracked, so the
// commit stamped in PROVENANCE.json describes it exactly.
//
// Tests and the vitest stub stay behind — they belong to the package, not to
// what a consumer links against.
const planeDir = join(DIST, 'plane');
rmSync(planeDir, { recursive: true, force: true });
mkdirSync(planeDir, { recursive: true });
const planeFiles = readdirSync(PLANE_SRC)
  .filter((f) => (f.endsWith('.ts')) && !f.endsWith('.test.ts') && f !== 'dshub.vitest-stub.ts')
  .sort();
for (const f of planeFiles) copyFileSync(join(PLANE_SRC, f), join(planeDir, f));
const planeCommit = git('log', '-1', '--format=%H', '--', 'packages/dshub-plane/src');
const after = ENGINE.map((f) => sha256(join(DIST, 'runtime', f)));
const changed = ENGINE.some((_, i) => before[i] !== after[i]);

if (versionArg !== -1) {
  const next = argv[versionArg + 1];
  if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
    console.error('--version needs X.Y.Z');
    process.exit(1);
  }
  manifest.version = next;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// Travels INSIDE the tarball, which is the point: dist-pkg/ is gitignored, so
// the consumer's copy has to carry its own provenance -- and `files` decides
// what npm packs, so a provenance record left out of it would exist only on
// the machine that built it.
let manifestDirty = false;
for (const entry of ['PROVENANCE.json', 'plane']) {
  if (!manifest.files.includes(entry)) { manifest.files = [...manifest.files, entry]; manifestDirty = true; }
}
// Subpath export so a consumer can take the plane WITHOUT the barrel, which
// pulls React through useSsrm/useCsrm even though React is an optional peer.
// `./plane` is the page-safe barrel. `./plane/*` is for consumers that
// inject their own `RustHubFactory` and therefore need `SsrmWasmPlane`
// itself, which the barrel withholds on purpose: its module body carries a
// literal `import('@starui/dshub')` that a page bundle cannot resolve. An
// injected factory never reaches that import, but the specifier still has to
// resolve at BUILD time, so such a consumer also needs an alias for it.
for (const [k, v] of [['./plane', './plane/index.ts'], ['./plane/*', './plane/*']]) {
  if (manifest.exports[k] !== v) { manifest.exports = { ...manifest.exports, [k]: v }; manifestDirty = true; }
}
if (manifestDirty) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(DIST, 'PROVENANCE.json'), JSON.stringify({
  package: `${manifest.name}@${manifest.version}`,
  // Deliberately no build timestamp. The consumer pins this tarball by
  // sha256, and a clock reading would change that hash on every run for
  // byte-identical inputs -- the pin would go noisy for no information. The
  // commit IS the identity; `git show` gives you its date.
  repo: 'widgetstools/rangrez',
  commit,
  engine: {
    source: 'hub-rust/pkg',
    commit: engineCommit,
    files: Object.fromEntries(ENGINE.map((f, i) => [f, after[i]])),
  },
  plane: {
    source: 'packages/dshub-plane/src',
    commit: planeCommit,
    traceable: true,
    files: planeFiles,
  },
  lib: {
    traceable: false,
    note: 'Compiled from apps/dshub-react-perspective/src with imports rewritten; '
      + 'index.js and liveTicks.js have no tracked source. Not refreshed by this script.',
  },
}, null, 2) + '\n');

for (const f of readdirSync(DIST)) if (f.endsWith('.tgz')) unlinkSync(join(DIST, f));
execFileSync('npm', ['pack'], { cwd: DIST, stdio: 'inherit' });
const tgz = readdirSync(DIST).find((f) => f.endsWith('.tgz'));

console.log(`\nengine  ${changed ? 'REFRESHED' : 'already current'} from ${engineCommit.slice(0, 8)}`);
for (const [i, f] of ENGINE.entries()) console.log(`  ${f.padEnd(16)} ${after[i].slice(0, 16)}`);
console.log(`tarball ${tgz}  sha256 ${sha256(join(DIST, tgz)).slice(0, 16)}`);
console.log(`plane   ${planeFiles.length} files from ${planeCommit.slice(0, 8)}`);
console.log('lib/    NOT refreshed -- see PROVENANCE.json');
