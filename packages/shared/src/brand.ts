import { z } from 'zod';
import { DesignMd } from './design-md.js';

export const BrandRegistryEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Slug: lowercase alphanumeric + hyphens, max 80 chars'),
  name: z.string().min(1).max(80),
  version: z.number().int().positive(),
  created: z.string(),
  updated: z.string(),
  forked_from: z.string().nullable(),
});
export type BrandRegistryEntry = z.infer<typeof BrandRegistryEntry>;

export const BrandRegistry = z.object({
  default_brand_id: z.string().nullable(),
  brands: z.array(BrandRegistryEntry),
}).refine(
  (r) => r.default_brand_id === null || r.brands.some((b) => b.id === r.default_brand_id),
  'default_brand_id must reference a brand in brands[]',
);
export type BrandRegistry = z.infer<typeof BrandRegistry>;

export const BrandWithDoc = z.object({
  registry: BrandRegistryEntry,
  doc: DesignMd,
});
export type BrandWithDoc = z.infer<typeof BrandWithDoc>;
