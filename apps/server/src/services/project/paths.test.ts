import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../../config.js';
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
    expect(projectFiles('/project')).toMatchObject({
      presentationsDir: '/project/presentations',
      presentationJobsDir: '/project/presentation-jobs',
      presentationStagingDir: '/project/.presentation-staging',
    });
  });

  it('uses bounded presentation import defaults', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).presentation).toEqual({
      maxBytes: 100 * 1024 * 1024,
      maxPages: 200,
    });
  });

  it.each([
    ['VPA_PRESENTATION_MAX_BYTES', '0'],
    ['VPA_PRESENTATION_MAX_BYTES', '-1'],
    ['VPA_PRESENTATION_MAX_BYTES', '1.5'],
    ['VPA_PRESENTATION_MAX_BYTES', String(Number.MAX_SAFE_INTEGER + 1)],
    ['VPA_PRESENTATION_MAX_PAGES', '0'],
    ['VPA_PRESENTATION_MAX_PAGES', '-1'],
    ['VPA_PRESENTATION_MAX_PAGES', '1.5'],
    ['VPA_PRESENTATION_MAX_PAGES', '201'],
    ['VPA_PRESENTATION_MAX_PAGES', String(Number.MAX_SAFE_INTEGER + 1)],
  ])('rejects unsafe %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value } as NodeJS.ProcessEnv)).toThrow(key);
  });

  it('trackerPath joins vpaHome + projects.json', () => {
    expect(trackerPath('/u/.vpa')).toBe('/u/.vpa/projects.json');
  });
});
