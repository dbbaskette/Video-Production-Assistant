import { join } from 'node:path';

export interface BrandPaths {
  registryFile: string;
  brandsRoot: string;
  brandDir(slug: string): string;
  designMd(slug: string): string;
  parentJson(slug: string): string;
  assetsDir(slug: string): string;
  sourceDocsDir(slug: string): string;
  extractedTextMd(slug: string): string;
  sourcesJson(slug: string): string;
}

export function brandPaths(workspaceRoot: string, vpaDir: string): BrandPaths {
  const brandsRoot = join(workspaceRoot, 'brands');
  return {
    registryFile: join(vpaDir, 'brands.json'),
    brandsRoot,
    brandDir:        (slug) => join(brandsRoot, slug),
    designMd:        (slug) => join(brandsRoot, slug, 'design.md'),
    parentJson:      (slug) => join(brandsRoot, slug, 'parent.json'),
    assetsDir:       (slug) => join(brandsRoot, slug, 'assets'),
    sourceDocsDir:   (slug) => join(brandsRoot, slug, 'assets', 'source-docs'),
    extractedTextMd: (slug) => join(brandsRoot, slug, 'assets', 'source-docs', 'extracted-text.md'),
    sourcesJson:     (slug) => join(brandsRoot, slug, 'assets', 'source-docs', 'sources.json'),
  };
}
