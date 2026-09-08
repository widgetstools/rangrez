/**
 * Schema interpreter + secret guard.
 *
 * Hand-written, not generated: one small interpreter over the schema beats a
 * large emitter producing per-type validators, and it is the same code path in
 * both hosts. Covers exactly the JSON Schema subset the specs use.
 *
 * With no config server, these validators are the only thing between a typo in
 * the admin UI and a broken datasource on a trader's machine (architecture §3.5),
 * so validation runs on EVERY write, not just on import.
 */

/** Property names that must never carry a literal value in config. */
const SECRET_NAME = /^(pass(word|wd|phrase)?|secret|api[-_]?key|private[-_]?key|token|credential|auth|bearer|sas|pfx|p12)$/i;

/** Values that look like a secret even under an innocent key name. */
const SECRET_VALUE = [
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[A-Za-z0-9_-]{10,}\./,           // JWT
  /^(?:xox[baprs]|ghp|gho|github_pat)_/, // common provider tokens
];

/** `credentialRef` is the sanctioned escape hatch and is exempt from the name rule. */
const REF_KEYS = new Set(['credentialRef', 'caRef', 'schemaRef', 'connectionRef']);

/**
 * Walk any object rejecting embedded secrets.
 *
 * Enforced on IndexedDB write, on export AND on import (architecture §3.9).
 * Bundles travel over email — assume it.
 */
export function assertNoSecrets(value, path = '$', errors = []) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      for (const re of SECRET_VALUE) {
        if (re.test(value)) {
          errors.push({ path, message: 'value looks like an embedded secret; use a credentialRef' });
          break;
        }
      }
    }
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`, errors));
    return errors;
  }
  for (const [k, v] of Object.entries(value)) {
    // Only a SCALAR under a password-shaped name is a secret. `auth: { mode:
    // "token-from-app" }` is legitimate config; `auth: "Bearer ..."` is not.
    // Without this distinction the guard fires on valid configs, and a guard
    // that cries wolf is a guard someone switches off.
    const scalar = v === null || typeof v !== 'object';
    if (scalar && !REF_KEYS.has(k) && SECRET_NAME.test(k)) {
      errors.push({ path: `${path}.${k}`, message: `password-shaped field "${k}" is not permitted in config` });
    }
    assertNoSecrets(v, `${path}.${k}`, errors);
  }
  return errors;
}

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;

function matchesType(value, t) {
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number';
  return typeOf(value) === t;
}

function resolve(ref, root) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new Error(`unsupported $ref: ${ref}`);
  const def = root.$defs?.[m[1]];
  if (!def) throw new Error(`missing $ref target: ${ref}`);
  return def;
}

const DISCRIMINATORS = ['mode', 'kind', 'type'];

/**
 * Find the oneOf branch a value's discriminator names, recursing through nested
 * unions. Without the recursion, a bad `command` message reports as "matched no
 * permitted variant" at the root rather than "idempotencyKey required".
 */
function branchFor(node, value, root) {
  if (node.$ref) return branchFor(resolve(node.$ref, root), value, root);
  if (!node.oneOf || !value || typeof value !== 'object') return null;
  for (const key of DISCRIMINATORS) {
    const disc = value[key];
    if (disc === undefined) continue;
    for (const sub of node.oneOf) {
      if (sub.properties?.[key]?.const === disc) return sub;
    }
  }
  for (const sub of node.oneOf) {
    const nested = branchFor(sub, value, root);
    if (nested) return nested;
  }
  return null;
}

function check(value, schema, root, path, errors) {
  if (schema.$ref) return check(value, resolve(schema.$ref, root), root, path, errors);

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` });
    return errors;
  }

  if (schema.allOf) for (const sub of schema.allOf) check(value, sub, root, path, errors);

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => check(value, sub, root, path, []).length === 0);
    if (matches.length !== 1) {
      // Report against the branch the discriminator names, so the error is
      // actionable instead of "matched no variant". Must search nested oneOf:
      // the control protocol is root -> clientMessage -> per-message branches.
      const named = branchFor(schema, value, root);
      if (named) check(value, named, root, path, errors);
      else errors.push({ path, message: matches.length === 0 ? 'matched no permitted variant' : 'ambiguous: matched several variants' });
    }
  }

  const t = schema.type ?? (schema.properties ? 'object' : undefined);
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((one) => matchesType(value, one))) {
      errors.push({ path, message: `expected ${types.join(' | ')}, got ${typeOf(value)}` });
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push({ path, message: `does not match ${schema.pattern}` });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push({ path, message: `below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push({ path, message: `above maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
    if (schema.items) value.forEach((v, i) => check(v, schema.items, root, `${path}[${i}]`, errors));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      // `key in value` is true for an explicitly-undefined key, so it alone
      // would let `{ ref: undefined }` satisfy a required `ref`. Absent has to
      // mean the same thing here as it does for type checking below.
      if (value[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'required' });
    }
    for (const [key, v] of Object.entries(value)) {
      // A key present with value `undefined` is ABSENT.
      //
      // JSON.stringify drops such keys, so over a WebSocket they never arrive.
      // Structured clone PRESERVES them, so the identical message reaches the
      // worker with the key present and undefined. Treating that as a type
      // error would make the same message valid on one transport and invalid on
      // the other — and architecture §2.2 requires both to carry these messages.
      if (v === undefined) continue;
      const sub = schema.properties?.[key];
      if (sub) { check(v, sub, root, `${path}.${key}`, errors); continue; }
      if (schema.additionalProperties === false && schema.properties) {
        errors.push({ path: `${path}.${key}`, message: 'unknown property' });
      } else if (typeof schema.additionalProperties === 'object') {
        check(v, schema.additionalProperties, root, `${path}.${key}`, errors);
      }
    }
  }

  return errors;
}

/** Structural validation only. */
export function validate(value, schema) {
  return check(value, schema, schema, '$', []);
}

/**
 * The write path. Structure AND secrets, because a config that validates
 * structurally but carries a password is the failure this is here to stop.
 */
export function validateForWrite(value, schema) {
  return [...validate(value, schema), ...assertNoSecrets(value)];
}

/**
 * Referential integrity the schema cannot express: every connectionRef must
 * name a connection that exists in the same bundle.
 */
export function validateBundleRefs(bundle) {
  const errors = [];
  const known = new Set((bundle.connections ?? []).map((c) => c.id));
  for (const [i, ds] of (bundle.datasources ?? []).entries()) {
    if (ds.connectionRef && !known.has(ds.connectionRef)) {
      errors.push({
        path: `$.datasources[${i}].connectionRef`,
        message: `no connection with id "${ds.connectionRef}" in this bundle`,
      });
    }
  }
  return errors;
}
