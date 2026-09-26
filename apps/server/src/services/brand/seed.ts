import type { BrandPaths } from './paths.js';
import { syncTanzuBrand } from './tanzu-brand-source.js';

export async function seedBrands(
  paths: BrandPaths,
  registryFile: string,
): Promise<void> {
  // VPA owns the adapter; the installed Tanzu Brand package owns the brand.
  // An absent package is a supported state and leaves the registry untouched.
  await syncTanzuBrand(paths, registryFile);
}
