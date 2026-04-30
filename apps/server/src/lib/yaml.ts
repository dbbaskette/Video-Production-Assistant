import yaml from 'js-yaml';
import type { ZodSchema } from 'zod';

/** Parse YAML text against a zod schema. Uses js-yaml's safe schema (no js/function etc.). */
export function loadYaml<T>(text: string, schema: ZodSchema<T>): T {
  const raw = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`YAML schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

/** Stringify a value to YAML using stable, human-readable formatting. */
export function dumpYaml(value: unknown): string {
  return yaml.dump(value, {
    schema: yaml.CORE_SCHEMA,
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}
