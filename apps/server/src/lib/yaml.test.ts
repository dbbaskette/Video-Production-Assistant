import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadYaml, dumpYaml } from './yaml.js';

const Schema = z.object({ name: z.string(), n: z.number() });

describe('yaml helpers', () => {
  it('round-trips through dump and load', () => {
    const data = { name: 'foo', n: 42 };
    const text = dumpYaml(data);
    const parsed = loadYaml(text, Schema);
    expect(parsed).toEqual(data);
  });

  it('throws a useful error on schema mismatch', () => {
    expect(() => loadYaml('name: 1\nn: "x"', Schema)).toThrow(/name|n/);
  });

  it('rejects YAML with an unsafe tag (no js/function)', () => {
    const evil = '!!js/function "function(){return 42}"';
    expect(() => loadYaml(evil, Schema)).toThrow();
  });
});
