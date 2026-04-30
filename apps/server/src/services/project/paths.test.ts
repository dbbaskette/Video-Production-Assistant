import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveProjectRoot, projectFiles, trackerPath } from './paths.js';

describe('paths', () => {
  it('resolveProjectRoot joins parentDir + name', () => {
    expect(resolveProjectRoot('/Users/me/Movies/VPA', 'demo-1')).toBe(
      path.join('/Users/me/Movies/VPA', 'demo-1'),
    );
  });

  it('resolveProjectRoot rejects names with path separators', () => {
    expect(() => resolveProjectRoot('/x', 'a/b')).toThrow(/separator|invalid/i);
  });

  it('projectFiles returns expected sub-paths', () => {
    const f = projectFiles('/p');
    expect(f.metadata).toBe('/p/project.yaml');
    expect(f.storyboard).toBe('/p/storyboard.yaml');
    expect(f.state).toBe('/p/state.yaml');
    expect(f.recordingsDir).toBe('/p/recordings');
    expect(f.narrationDir).toBe('/p/narration');
    expect(f.overlaysDir).toBe('/p/overlays');
    expect(f.sourceDocsDir).toBe('/p/source-docs');
  });

  it('trackerPath joins vpaHome + projects.json', () => {
    expect(trackerPath('/u/.vpa')).toBe('/u/.vpa/projects.json');
  });
});
