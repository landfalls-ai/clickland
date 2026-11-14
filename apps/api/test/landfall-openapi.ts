/**
 * Landfall's Source Protocol OpenAPI file, as a validator. Landfall is a separate (private) repository, so the file is
 * read from a checkout next to this one (`../landfall`), or from `LANDFALL_REPO`; tests that need it skip without it.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = process.env.LANDFALL_REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../landfall');
export const OPENAPI_PATH = join(repo, 'libs/signals/protocol/source-protocol.openapi.yaml');
export const haveOpenApi = existsSync(OPENAPI_PATH);

type Schema = Record<string, unknown>;

/** OpenAPI 3.0 schema → JSON Schema (draft 2019+): `nullable`, boolean `exclusiveMinimum`, component refs. */
export function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Schema = {};
  for (const [k, v] of Object.entries(node as Schema)) {
    if (k === '$ref' && typeof v === 'string') out.$ref = v.replace('#/components/schemas/', '#/definitions/');
    else if (k === 'nullable') continue;
    else out[k] = toJsonSchema(v);
  }
  const src = node as Schema;
  if (src.exclusiveMinimum === true && typeof src.minimum === 'number') {
    out.exclusiveMinimum = src.minimum;
    delete out.minimum;
  } else if (src.exclusiveMinimum === false) delete out.exclusiveMinimum;
  if (src.nullable === true) return { anyOf: [out, { type: 'null' }] };
  return out;
}

let validators: Map<string, ValidateFunction> | null = null;

/** Validates `value` against one of the file's component schemas; returns the problems (empty when it conforms). */
export function validateAgainst(component: string, value: unknown): string[] {
  if (!validators) {
    const doc = parse(readFileSync(OPENAPI_PATH, 'utf8')) as { components: { schemas: Schema } };
    const definitions = toJsonSchema(doc.components.schemas) as Schema;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const addFormats = addFormatsModule as unknown as (a: Ajv) => void;
    addFormats(ajv);
    validators = new Map(
      Object.keys(definitions).map((name) => [name, ajv.compile({ definitions, $ref: `#/definitions/${name}` })]),
    );
  }
  const validate = validators.get(component);
  if (!validate) throw new Error(`No component ${component} in ${OPENAPI_PATH}`);
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** The paths and methods the file defines, e.g. `GET /v1/health`. */
export function openApiRoutes(): string[] {
  const doc = parse(readFileSync(OPENAPI_PATH, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
  );
}
