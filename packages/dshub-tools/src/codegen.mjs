#!/usr/bin/env node
/**
 * spec -> TypeScript types (and Rust serde types from Phase 10).
 *
 * Deliberately dependency-free and deliberately narrow: it supports exactly the
 * JSON Schema subset the three specs use, and throws on anything else rather
 * than degrading to `any`. A generator that silently emits `any` is worse than
 * no generator, because the types then lie.
 *
 * Runtime validation is NOT generated — packages/dshub-spec/src/validate.mjs
 * interprets the schema directly. One small interpreter beats a large emitter.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../dshub-spec');
const OUT = join(SPEC, 'src/generated');

const SCHEMAS = [
  { file: 'datasource-config.schema.json', root: 'ConfigBundle' },
  { file: 'schema-artifact.schema.json', root: 'SchemaArtifact' },
  { file: 'control-protocol.schema.json', root: 'ControlMessage' },
];

const pascal = (s) =>
  s.replace(/[-_ ]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (c) => c.toUpperCase());

class Emitter {
  constructor(schema, rootName) {
    this.schema = schema;
    this.rootName = rootName;
    this.lines = [];
    this.defNames = new Set(Object.keys(schema.$defs ?? {}));
  }

  /** $defs/foo -> Foo. Anything else is a ref shape we do not support. */
  refName(ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!m) throw new Error(`unsupported $ref: ${ref} (only #/$defs/<name> is supported)`);
    if (!this.defNames.has(m[1])) throw new Error(`$ref points at missing def: ${ref}`);
    return pascal(m[1]);
  }

  /** JSON Schema node -> TypeScript type expression. */
  type(node, path) {
    if (node.$ref) return this.refName(node.$ref);
    if (node.const !== undefined) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ');

    // allOf is used only to attach the envelope; the oneOf beside it carries the shape.
    if (node.oneOf) return node.oneOf.map((s, i) => this.type(s, `${path}/oneOf/${i}`)).join('\n  | ');

    // `properties` implies an object shape whether or not `type` says so.
    // The control-protocol oneOf branches rely on this.
    const t = node.type ?? (node.properties ? 'object' : undefined);
    if (Array.isArray(t)) {
      // e.g. ["integer","null"]
      return t.map((one) => this.type({ ...node, type: one }, path)).join(' | ');
    }

    switch (t) {
      case 'string': return 'string';
      case 'integer':
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': {
        if (!node.items) return 'unknown[]';
        const inner = this.type(node.items, `${path}/items`);
        return inner.includes('|') ? `Array<${inner}>` : `${inner}[]`;
      }
      case 'object': {
        if (node.properties) return this.objectLiteral(node, path);
        if (node.additionalProperties && typeof node.additionalProperties === 'object') {
          return `Record<string, ${this.type(node.additionalProperties, `${path}/ap`)}>`;
        }
        return 'Record<string, unknown>';
      }
      case undefined:
        // Intentionally open: colDef fragments and command payloads.
        return 'unknown';
      default:
        throw new Error(`unsupported type "${t}" at ${path}`);
    }
  }

  objectLiteral(node, path) {
    const req = new Set(node.required ?? []);
    const fields = Object.entries(node.properties).map(([key, sub]) => {
      const opt = req.has(key) ? '' : '?';
      const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `    ${safe}${opt}: ${this.type(sub, `${path}/${key}`)};`;
    });
    return `{\n${fields.join('\n')}\n  }`;
  }

  /**
   * A single object literal becomes an interface (better errors, declaration
   * merging). Anything with a top-level union — which is every oneOf — must be
   * a type alias; `interface X {...} | {...}` is a syntax error.
   */
  declare(name, node, body) {
    const isUnion = Boolean(node.oneOf) || Array.isArray(node.type);
    return !isUnion && body.startsWith('{')
      ? `export interface ${name} ${body}`
      : `export type ${name} =\n  ${body};`;
  }

  emit() {
    const s = this.schema;
    this.lines.push('// GENERATED — do not edit. Source: ' + s.$id);
    this.lines.push('// Regenerate with `npm run codegen`. CI asserts this file matches.');
    this.lines.push('');

    for (const [name, def] of Object.entries(s.$defs ?? {})) {
      const tn = pascal(name);
      const body = this.type(def, `#/$defs/${name}`);
      if (def.description) this.lines.push(`/** ${def.description.replace(/\*\//g, '*\\/')} */`);
      this.lines.push(this.declare(tn, def, body));
      this.lines.push('');
    }

    this.lines.push(this.declare(this.rootName, s, this.type(s, '#')));
    this.lines.push('');
    return this.lines.join('\n');
  }
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const index = [];

  for (const { file, root } of SCHEMAS) {
    const schema = JSON.parse(readFileSync(join(SPEC, file), 'utf8'));
    const base = file.replace(/\.schema\.json$/, '');
    const ts = new Emitter(schema, root).emit();
    writeFileSync(join(OUT, `${base}.ts`), ts);
    index.push(`export * from './${base}.js';`);
    console.log(`  ${base}.ts`);
  }

  // Re-export the schemas themselves so the validator and the admin UI's
  // schema-driven forms read the same bytes the types were generated from.
  index.push('');
  for (const { file } of SCHEMAS) {
    const base = file.replace(/\.schema\.json$/, '');
    const name = base.replace(/-(.)/g, (_, c) => c.toUpperCase()) + 'Schema';
    index.push(`export { default as ${name} } from '../../${file}' with { type: 'json' };`);
  }
  writeFileSync(join(OUT, 'index.ts'), index.join('\n') + '\n');
  console.log('  index.ts');

  // Rust emitter: written in Phase 1 while the schemas are fresh, exercised
  // from Phase 10 when hub-rust exists. Keeping it stubbed but present keeps
  // the spec honest about being language-neutral.
  console.log('  (rust emitter: Phase 10 — see architecture §2.2)');
}

main();
