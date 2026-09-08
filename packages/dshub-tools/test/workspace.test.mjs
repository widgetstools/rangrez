import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SPEC = join(ROOT, 'packages/dshub-spec');

/**
 * Phase 1 exit criterion: generated types are checked in and CI asserts the
 * diff is empty. Run codegen into a scratch copy and compare byte-for-byte.
 */
test('codegen is deterministic and the checked-in output is current', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dshub-codegen-'));
  try {
    cpSync(join(ROOT, 'packages'), join(scratch, 'packages'), { recursive: true });
    execFileSync(process.execPath, [join(scratch, 'packages/dshub-tools/src/codegen.mjs')], {
      stdio: 'pipe',
    });

    const genDir = join(SPEC, 'src/generated');
    const files = readdirSync(genDir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4, 'expected generated output to exist');

    for (const f of files) {
      const committed = readFileSync(join(genDir, f), 'utf8');
      const fresh = readFileSync(join(scratch, 'packages/dshub-spec/src/generated', f), 'utf8');
      assert.equal(fresh, committed, `${f} is stale — run \`pnpm codegen\` and commit the result`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * Two copies of React in one page is a broken app, not a version skew, and
 * dshub-admin is mounted by a host that supplies its own React (arch §2.1).
 *
 * npm has no catalog, so root `overrides` is the enforcement — and it is
 * stronger than a catalog for this purpose: it forces one version through the
 * WHOLE tree, transitive dependencies included, so a second React cannot slip
 * in via a dependency that asks for one.
 */
const SINGLE_VERSION = /^(react|react-dom|ag-grid-community|ag-grid-enterprise|ag-grid-react)$/;

test('root overrides pin every dependency that must be single-version', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const overrides = root.overrides ?? {};
  for (const name of ['react', 'react-dom', 'ag-grid-community', 'ag-grid-enterprise', 'ag-grid-react']) {
    assert.ok(overrides[name], `${name} must be pinned in root overrides`);
    assert.match(overrides[name], /^\d+\.\d+\.\d+$/, `${name} override must be exact, not a range`);
  }
});

test('no package requests a version outside what the override forces', () => {
  // An override silently rewrites a conflicting request rather than failing, so
  // a package asking for React 18 would install 19 and only break at runtime.
  // Catch the disagreement here instead.
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const overrides = root.overrides ?? {};
  const pkgDirs = [
    ...readdirSync(join(ROOT, 'packages')).map((d) => join(ROOT, 'packages', d)),
    ...readdirSync(join(ROOT, 'apps')).map((d) => join(ROOT, 'apps', d)),
  ];

  const offenders = [];
  for (const dir of pkgDirs) {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (!SINGLE_VERSION.test(name)) continue;
        const forced = overrides[name];
        if (!forced) continue;
        const major = (r) => /(\d+)\./.exec(r)?.[1];
        if (major(range) !== major(forced)) {
          offenders.push(`${pkg.name} ${field}.${name} wants "${range}" but overrides force "${forced}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `major-version disagreement with root overrides:\n  ${offenders.join('\n  ')}`);
});

test('no prerelease of a single-version dependency is pinned', () => {
  // A canary has no place on a trading desk.
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(root.overrides ?? {})) {
    assert.ok(
      !/-(canary|beta|rc|alpha|next|experimental)/i.test(version),
      `${name} is pinned to a prerelease: ${version}`
    );
  }
});

test('the pinned versions are the ones the docs claim', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // 19.3 is the stated target but is not released; the pin tracks the newest
  // stable 19.x until it ships. Assert the major line, not a patch that moves.
  assert.match(root.overrides.react, /^19\./, 'React 19.x');
  assert.equal(root.overrides['ag-grid-community'], '36.0.0', 'AG-Grid 36.0.0');
});

test('the workspace is npm, with no pnpm remnants', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(root.workspaces), 'npm workspaces must be declared');
  assert.match(root.packageManager ?? '', /^npm@/, 'packageManager must be npm');
  for (const stale of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    assert.ok(!existsSync(join(ROOT, stale)), `${stale} should have been removed`);
  }
  // The pnpm `workspace:` protocol is not understood by npm.
  for (const dir of readdirSync(join(ROOT, 'apps')).map((d) => join(ROOT, 'apps', d))) {
    const p = join(dir, 'package.json');
    if (!existsSync(p)) continue;
    assert.ok(!readFileSync(p, 'utf8').includes('workspace:'), `${p} still uses the pnpm workspace: protocol`);
  }
});

/**
 * '.' as a flatten separator is banned in the schema because AG-Grid resolves a
 * dotted ColDef field as a deep property path. Assert the ban is actually in the
 * spec, not just in prose.
 */
test('the flatten separator enum excludes "."', () => {
  const schema = JSON.parse(readFileSync(join(SPEC, 'datasource-config.schema.json'), 'utf8'));
  const sep = schema.$defs.flatten.properties.separator;
  assert.ok(Array.isArray(sep.enum), 'separator must be a closed enum');
  assert.ok(!sep.enum.includes('.'), '"." must not be a permitted flatten separator');
});

/**
 * Every leaf carrying a reload class is what makes hot-reload derived rather
 * than decided ad hoc (arch §3.8). Guard the top-level shape at minimum.
 */
test('reload classes are declared across the config schema', () => {
  const raw = readFileSync(join(SPEC, 'datasource-config.schema.json'), 'utf8');
  const schema = JSON.parse(raw);
  const classes = new Set(schema.$defs.reloadClass.enum);
  assert.deepEqual([...classes], ['live', 'resubscribe', 'rebuild', 'restart']);

  const used = new Set([...raw.matchAll(/"x-reloadClass":\s*"([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 0, 'expected x-reloadClass annotations');
  for (const u of used) {
    assert.ok(classes.has(u), `x-reloadClass "${u}" is not one of the declared classes`);
  }
});

/**
 * The generated types must be valid TypeScript. Nothing else checks this — the
 * emitter could produce syntactically broken output and every runtime test
 * would still pass, because validation interprets the schema rather than using
 * the types.
 */
test('generated types compile under tsc', () => {
  const out = execFileSync('npx', ['tsc', '--noEmit'], {
    cwd: SPEC, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(out.trim(), '', `tsc reported errors in generated output:\n${out}`);
});
