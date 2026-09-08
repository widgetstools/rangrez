/**
 * Schema-driven form model (architecture §10, Phase 7).
 *
 * The editors are generated from `datasource-config.schema.json` rather than
 * hand-written, and that is a correctness decision more than a labour-saving
 * one. A hand-written form is a SECOND definition of what a datasource is: add
 * a field to the schema and the form silently cannot set it; change an enum and
 * the form offers a value the validator rejects. The config would then be
 * editable into states the system refuses to load.
 *
 * This turns a `$defs` entry into a flat list of fields the UI can render
 * without knowing anything about datasources. It deliberately produces a MODEL,
 * not markup — the same model drives the form, the diff view and the reload
 * plan, and none of them should re-derive it.
 */

import { reloadClassAt } from '../../dshub-provider/src/reload.mjs';

const deref = (node, root) => {
  if (!node?.$ref) return node;
  return node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root) ?? node;
};

/** `notionalAmount` -> `Notional Amount`; `clientId` -> `Client Id`. */
export function labelFor(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** The widget a field wants, from its schema alone. */
export function widgetFor(node) {
  if (node?.enum) return node.enum.length <= 4 ? 'radio' : 'select';
  if (node?.const !== undefined) return 'const';
  const type = Array.isArray(node?.type) ? node.type.find((t) => t !== 'null') : node?.type;
  switch (type) {
    case 'boolean': return 'checkbox';
    case 'integer':
    case 'number': return 'number';
    case 'array': return 'list';
    case 'object': return 'object';
    default: return node?.format === 'uri' ? 'url' : 'text';
  }
}

/**
 * Which branch of a discriminated union a value is in.
 *
 * Keyed on the `const` property every branch declares — `snapshot.mode` here.
 * Guessing by "which branch validates" would pick the wrong one whenever
 * branches overlap, and the editor would then rewrite fields the user did not
 * touch.
 */
export function activeBranch(node, value, root) {
  if (!Array.isArray(node?.oneOf)) return null;
  const discriminator = discriminatorOf(node, root);
  if (!discriminator) return null;
  const current = value?.[discriminator];
  for (const branch of node.oneOf) {
    const b = deref(branch, root);
    if (b?.properties?.[discriminator]?.const === current) return b;
  }
  return null;
}

/** The property every branch pins with `const` — the union's tag. */
export function discriminatorOf(node, root) {
  if (!Array.isArray(node?.oneOf)) return null;
  const first = deref(node.oneOf[0], root);
  for (const [key, prop] of Object.entries(first?.properties ?? {})) {
    if (prop?.const === undefined) continue;
    const inAll = node.oneOf.every((b) => deref(b, root)?.properties?.[key]?.const !== undefined);
    if (inAll) return key;
  }
  return null;
}

/**
 * Flatten a definition into renderable fields.
 *
 * `value` matters: a discriminated union exposes only the ACTIVE branch's
 * fields, so switching `snapshot.mode` changes which inputs exist. Showing all
 * branches at once would offer `triggerDestination` alongside `url` and let
 * someone build a config that validates as neither.
 *
 * @returns {{path: string[], key: string, label: string, widget: string,
 *            required: boolean, reload: string, enum?: any[], description?: string,
 *            branchOf?: string}[]}
 */
export function fieldsFor(defName, value, schema, { prefix = [], maxDepth = 4 } = {}) {
  const rootSchema = { $defs: schema.$defs, $ref: `#/$defs/${defName}` };
  /**
   * `ancestorAbsent`: this field sits inside an OPTIONAL object that is not
   * present. Its `required` flag is conditional — "required once you opt into
   * opField at all" — not a decision the form should demand up front. Such
   * fields fold; they surface the moment the parent gains a value.
   */
  const walk = (node, val, path, depth, required, ancestorAbsent = false) => {
    const out = [];
    if (depth > maxDepth) return out;
    const n = deref(node, schema);

    if (Array.isArray(n?.oneOf)) {
      const tag = discriminatorOf(n, schema);
      if (tag) {
        // The tag itself is a field: choosing it is how you switch branch.
        const options = n.oneOf.map((b) => deref(b, schema)?.properties?.[tag]?.const).filter((x) => x !== undefined);
        out.push({
          path: [...path, tag], key: tag, label: labelFor(tag), widget: options.length <= 4 ? 'radio' : 'select',
          required: true, enum: options, description: n.description,
          reload: reloadClassAt([...path.slice(prefix.length), tag], rootSchema, schema),
        });
        const branch = activeBranch(n, val, schema);
        if (branch) {
          for (const [k, prop] of Object.entries(branch.properties ?? {})) {
            if (k === tag) continue;
            out.push(...walk(prop, val?.[k], [...path, k], depth + 1, (branch.required ?? []).includes(k), ancestorAbsent));
          }
        }
        return out;
      }
    }

    if (n?.type === 'object' && n.properties) {
      const absent = ancestorAbsent || (!required && val === undefined);
      for (const [k, prop] of Object.entries(n.properties)) {
        out.push(...walk(prop, val?.[k], [...path, k], depth + 1, (n.required ?? []).includes(k), absent));
      }
      return out;
    }

    out.push({
      path,
      ancestorAbsent,
      key: path[path.length - 1],
      label: labelFor(path[path.length - 1] ?? ''),
      widget: widgetFor(n),
      required,
      enum: n?.enum,
      description: n?.description,
      reload: reloadClassAt(path.slice(prefix.length), rootSchema, schema),
    });
    return out;
  };

  const def = deref({ $ref: `#/$defs/${defName}` }, schema);
  const out = [];
  for (const [k, prop] of Object.entries(def?.properties ?? {})) {
    out.push(...walk(prop, value?.[k], [...prefix, k], 1, (def.required ?? []).includes(k)));
  }
  return out;
}

/** Read/write a nested path, so the form can bind to one. */
export const readPath = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);

export function writePath(obj, path, value) {
  const out = structuredClone(obj ?? {});
  let cur = out;
  for (const k of path.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  const last = path[path.length - 1];
  // An empty input is ABSENT, not an empty string: `{selector: ''}` and
  // `{}` mean different things to a subscription, and the schema treats a
  // present-but-empty required field as satisfied.
  if (value === '' || value === undefined) delete cur[last];
  else cur[last] = value;
  return out;
}

/**
 * Group fields into SECTIONS with progressive disclosure.
 *
 * A flat list of 39 dotted-path inputs is the schema's shape, not a human's.
 * Three rules turn it into a form someone can actually read:
 *
 *   1. Fields group by their top-level key: `snapshot.*` is one card,
 *      `updates.*` another. Scalars at the root form the "Basics" card.
 *   2. A field is visible when it is REQUIRED — full stop. Optional fields
 *      fold even when they are set: the editing surface is the ~10 decisions a
 *      human actually makes, and the fold label carries a "· N set" count so a
 *      configured value is never hidden silently. (The first cut showed
 *      required-or-set, and a populated datasource rendered ~32 inputs — the
 *      seed config sets many optional fields, so "set" is no signal of what a
 *      person needs on screen.)
 *   3. Labels are relative to their card: inside the Snapshot card the field
 *      is "End Of Snapshot › Kind", not `snapshot.endOfSnapshot.kind`.
 *
 * Still 100% schema-driven: nothing here names a datasource field.
 */
export function sectionsFor(defName, value, schema, opts) {
  const all = fieldsFor(defName, value, schema, opts);
  const byKey = new Map();

  for (const f of all) {
    const top = f.path.length === 1 ? '_basics' : f.path[0];
    if (!byKey.has(top)) {
      byKey.set(top, { key: top, label: top === '_basics' ? 'Basics' : labelFor(top), fields: [] });
    }
    const rel = f.path.length === 1 ? f.path : f.path.slice(1);
    byKey.get(top).fields.push({
      ...f,
      label: rel.map(labelFor).join(' › '),
      advanced: !f.required || f.ancestorAbsent === true,
      isSet: readPath(value, f.path) !== undefined,
    });
  }

  const sections = [...byKey.values()];
  for (const s of sections) {
    s.visible = s.fields.filter((f) => !f.advanced);
    s.hidden = s.fields.filter((f) => f.advanced);
    s.hiddenSet = s.hidden.filter((f) => f.isSet).length;
    // The card's own badge: the strongest reload consequence inside it.
    s.reload = s.fields.reduce((acc, f) => {
      const order = ['none', 'live', 'resubscribe', 'rebuild', 'restart'];
      return order.indexOf(f.reload) > order.indexOf(acc) ? f.reload : acc;
    }, 'none');
    // A card with nothing set and nothing required starts fully folded.
    s.collapsed = s.visible.length === 0;
  }
  // Basics first, then cards with content, then empty ones.
  sections.sort((a, b) =>
    (a.key === '_basics' ? -1 : b.key === '_basics' ? 1 : (b.visible.length ? 1 : 0) - (a.visible.length ? 1 : 0)));
  return sections;
}
