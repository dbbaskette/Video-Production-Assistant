import yaml from 'js-yaml';
import type { DesignMdFrontMatter } from '@vpa/shared';

export function assembleDesignMd(frontMatter: DesignMdFrontMatter, body: string): string {
  const yamlText = yaml.dump(frontMatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  return `---\n${yamlText}---\n\n${body.trim()}\n`;
}
