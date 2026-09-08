/**
 * Config bundle codec — export, import, diff.
 *
 * Architecture §3.7. There is no config server, so a bundle is how config moves
 * between machines: exported, committed to git, reviewed in a PR, imported.
 *
 * Every rule here assumes the bundle will travel over email, because it will.
 */

import { assertNoSecrets } from '../../dshub-spec/src/validate.mjs';

export const BUNDLE_KIND = 'dshub-config-bundle';
export const SPEC_VERSION = '1.0';

/**
 * Canonical JSON — sorted keys, no incidental whitespace.
 *
 * The checksum is computed over THIS, not over whatever JSON.stringify happened
 * to produce. Otherwise two byte-identical configs hash differently because a
 * key moved, and the §3.6 reconcile starts reporting phantom conflicts.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/** sha256 of the canonical form. Web Crypto exists in both hosts. */
export async function checksum(payload) {
  const bytes = new TextEncoder().encode(canonicalize(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

const CONTENT_KEYS = ['connections', 'datasources', 'artifacts', 'rules'];

/**
 * Build an exportable bundle.
 *
 * Layouts are EXCLUDED by default: personal window arrangements should not ride
 * along when a datasource config is shared (§3.7). Secrets are stripped and
 * then re-checked, because "we stripped it" and "it is not there" are different
 * claims.
 */
export async function exportBundle(store, { exportedBy, includeLayouts = false } = {}) {
  // DETACHED copies. An IndexedDB backend deserializes on read so this is
  // already true there, but an in-memory store hands back live references and
  // then editing the exported bundle silently edits the live config. The
  // contract should not depend on which backend is underneath.
  const detach = (rows) => rows.map((r) => structuredClone(r));

  const payload = {};
  for (const k of CONTENT_KEYS) payload[k] = detach(await store.all(k));
  if (includeLayouts) payload.layouts = detach(await store.all('layouts'));

  const meta = await store.meta();
  const secrets = assertNoSecrets(payload);
  if (secrets.length) {
    throw Object.assign(
      new Error(`refusing to export: ${secrets.length} secret-shaped field(s), first at ${secrets[0].path}`),
      { code: 'config-invalid', errors: secrets }
    );
  }

  const bundle = {
    kind: BUNDLE_KIND,
    specVersion: SPEC_VERSION,
    bundleVersion: meta?.bundleVersion ?? 0,
    exportedAt: new Date().toISOString(),
    ...(exportedBy ? { exportedBy } : {}),
    ...payload,
  };
  // The checksum covers the CONTENT, not the envelope: exportedAt changes every
  // time and would make every export look like a different config.
  bundle.checksum = await checksum(payload);
  return bundle;
}

/**
 * Validate an incoming bundle before anything is written.
 *
 * @returns {Promise<{ok: boolean, errors: object[]}>}
 */
export async function verifyBundle(bundle) {
  const errors = [];
  if (bundle?.kind !== BUNDLE_KIND) {
    errors.push({ path: '$.kind', message: `not a ${BUNDLE_KIND}` });
    return { ok: false, errors };
  }

  // A NEWER specVersion is refused outright rather than partially applied —
  // half-importing a config is worse than not importing it.
  if (bundle.specVersion !== SPEC_VERSION) {
    const newer = String(bundle.specVersion) > SPEC_VERSION;
    errors.push({
      path: '$.specVersion',
      message: newer
        ? `bundle is spec ${bundle.specVersion}; this app speaks ${SPEC_VERSION}. Upgrade the app rather than importing.`
        : `bundle is spec ${bundle.specVersion}; this app speaks ${SPEC_VERSION}.`,
    });
  }

  const payload = {};
  for (const k of CONTENT_KEYS) payload[k] = bundle[k] ?? [];
  if (bundle.layouts) payload.layouts = bundle.layouts;

  if (bundle.checksum) {
    const actual = await checksum(payload);
    if (actual !== bundle.checksum) {
      // Catches a file truncated by email or a share drive.
      errors.push({ path: '$.checksum', message: 'checksum mismatch — the bundle was altered or truncated in transit' });
    }
  } else {
    errors.push({ path: '$.checksum', message: 'no checksum; refusing to trust the contents' });
  }

  for (const e of assertNoSecrets(payload)) {
    errors.push({ ...e, message: `import rejected: ${e.message}` });
  }
  return { ok: errors.length === 0, errors };
}

/** Diff by id, per collection. This is what replaces promotion-with-review. */
export function diffBundle(incoming, current) {
  const out = {};
  for (const k of CONTENT_KEYS) {
    const a = new Map((current?.[k] ?? []).map((x) => [idOf(k, x), x]));
    const b = new Map((incoming?.[k] ?? []).map((x) => [idOf(k, x), x]));
    const added = [], changed = [], removed = [], unchanged = [];

    for (const [id, item] of b) {
      if (!a.has(id)) { added.push(id); continue; }
      (canonicalize(a.get(id)) === canonicalize(item) ? unchanged : changed).push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) removed.push(id);
    out[k] = { added, changed, removed, unchanged };
  }
  return out;
}

const idOf = (collection, item) =>
  collection === 'artifacts' ? `${item.id}@v${item.version}` : item.id;

export const IMPORT_MODES = ['dry-run', 'merge-incoming', 'merge-local', 'replace-all'];

/**
 * Apply a bundle.
 *
 * `dry-run` is the DEFAULT and writes nothing — the review step is the point,
 * and a destructive default is how someone loses a desk's config to a stray
 * double-click.
 */
export async function importBundle(store, bundle, { mode = 'dry-run', now = () => Date.now() } = {}) {
  if (!IMPORT_MODES.includes(mode)) throw new Error(`unknown import mode "${mode}"`);

  const verdict = await verifyBundle(bundle);
  const current = {};
  for (const k of CONTENT_KEYS) current[k] = await store.all(k);
  const diff = diffBundle(bundle, current);

  if (!verdict.ok) return { applied: false, mode, diff, errors: verdict.errors };
  if (mode === 'dry-run') return { applied: false, mode, diff, errors: [] };

  const meta = await store.meta();
  const nextVersion = Math.max(meta?.bundleVersion ?? 0, bundle.bundleVersion ?? 0) + 1;

  // ONE transaction. A mid-import failure must leave the previous config
  // intact rather than half-replaced (§3.7).
  await store.transaction(async (tx) => {
    if (mode === 'replace-all') for (const k of CONTENT_KEYS) await tx.clear(k);

    for (const k of CONTENT_KEYS) {
      for (const item of bundle[k] ?? []) {
        const id = idOf(k, item);
        if (mode === 'merge-local' && (await tx.has(k, id))) continue;   // adds only
        await tx.put(k, id, item);
      }
    }
    await tx.putMeta({
      bundleVersion: nextVersion,
      checksum: bundle.checksum,
      updatedAt: now(),
      updatedBy: bundle.exportedBy ?? null,
      specVersion: SPEC_VERSION,
    });
  });

  return { applied: true, mode, diff, errors: [], bundleVersion: nextVersion };
}

export { CONTENT_KEYS, idOf };
