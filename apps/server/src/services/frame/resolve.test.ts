import { describe, it, expect } from 'vitest';
import { resolveSceneFrame, createCachingBrandColorResolver, type BrandColorResolver } from './resolve.js';
import type { FrameManifest } from './manifest.js';
import type { Scene, StoryboardDefaults } from '@vpa/shared';

const FAKE_ASSETS = '/fake/assets';

const manifest: FrameManifest = {
  version: 1,
  frames: [
    {
      id: 'laptop-flat',
      family: 'laptop',
      variant: 'flat',
      displayName: 'MacBook (flat)',
      frame: 'frames/laptop-flat.png',
      thumbnail: 'thumbnails/laptop-flat.png',
      type: 'flat',
      frameSize: { w: 1920, h: 1200 },
      inset: { x: 80, y: 80, w: 1760, h: 1100 },
    },
    {
      id: 'tablet-tilt',
      family: 'tablet',
      variant: 'tilt',
      displayName: 'Tablet (tilted)',
      frame: 'frames/tablet-tilt.png',
      thumbnail: 'thumbnails/tablet-tilt.png',
      type: 'perspective',
      frameSize: { w: 2000, h: 1400 },
      quad: {
        tl: { x: 100, y: 50 },
        tr: { x: 1900, y: 50 },
        br: { x: 1900, y: 1350 },
        bl: { x: 100, y: 1350 },
      },
    },
  ],
};

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    name: 'Scene 1',
    description: '',
    type: 'desktop',
    ...overrides,
  };
}

function baseOpts(scene: Scene, defaults?: StoryboardDefaults) {
  return {
    scene,
    defaults,
    manifest,
    assetsDir: FAKE_ASSETS,
    projectPath: '/fake/project',
    vpaHome: '/fake/vpa-home',
    workspaceRoot: '/fake/workspace',
    // Test fake — never reaches the real `resolveLtColors`.
    brandColorResolver: (async () => '#abc123') satisfies BrandColorResolver,
  };
}

describe('resolveSceneFrame', () => {
  describe('override chain — frame_style', () => {
    it('returns null when neither scene nor defaults set a style', async () => {
      const result = await resolveSceneFrame(baseOpts(makeScene()));
      expect(result).toBeNull();
    });

    it('returns null when scene unsets a style and defaults are absent', async () => {
      const result = await resolveSceneFrame(baseOpts(makeScene(), undefined));
      expect(result).toBeNull();
    });

    it('uses defaults.frame_style when scene has no override', async () => {
      const result = await resolveSceneFrame(
        baseOpts(makeScene(), { frame_style: 'laptop-flat' }),
      );
      expect(result?.frameEntry.id).toBe('laptop-flat');
    });

    it('scene-level frame_style wins over defaults', async () => {
      const result = await resolveSceneFrame(
        baseOpts(
          makeScene({ frame_style: 'tablet-tilt' }),
          { frame_style: 'laptop-flat' },
        ),
      );
      expect(result?.frameEntry.id).toBe('tablet-tilt');
    });

    it('throws on unknown frame_style id', async () => {
      await expect(
        resolveSceneFrame(baseOpts(makeScene({ frame_style: 'no-such-frame' }))),
      ).rejects.toThrow(/Unknown frame_style: no-such-frame/);
    });
  });

  describe('background color resolution', () => {
    it('falls back to neutral dark gray when background is unspecified', async () => {
      const result = await resolveSceneFrame(
        baseOpts(makeScene({ frame_style: 'laptop-flat' })),
      );
      expect(result?.backgroundColor).toBe('#1a1a1a');
    });

    it('passes through a literal hex value', async () => {
      const result = await resolveSceneFrame(
        baseOpts(makeScene({ frame_style: 'laptop-flat', frame_background: '#0a1b2c' })),
      );
      expect(result?.backgroundColor).toBe('#0a1b2c');
    });

    it("passes through 'transparent' so the renderer can throw downstream", async () => {
      const result = await resolveSceneFrame(
        baseOpts(makeScene({ frame_style: 'laptop-flat', frame_background: 'transparent' })),
      );
      expect(result?.backgroundColor).toBe('transparent');
    });

    it("resolves 'brand' through the injected brand color resolver", async () => {
      let capturedProject: string | null = null;
      const fakeResolver: BrandColorResolver = async (project) => {
        capturedProject = project;
        return '#deadbe';
      };
      const opts = baseOpts(makeScene({ frame_style: 'laptop-flat', frame_background: 'brand' }));
      const result = await resolveSceneFrame({ ...opts, brandColorResolver: fakeResolver });
      expect(result?.backgroundColor).toBe('#deadbe');
      expect(capturedProject).toBe('/fake/project');
    });

    it('scene-level background wins over defaults', async () => {
      const result = await resolveSceneFrame(
        baseOpts(
          makeScene({ frame_style: 'laptop-flat', frame_background: '#111111' }),
          { frame_style: 'tablet-tilt', frame_background: '#222222' },
        ),
      );
      expect(result?.backgroundColor).toBe('#111111');
    });

    it('uses defaults.frame_background when scene leaves it unset', async () => {
      const result = await resolveSceneFrame(
        baseOpts(
          makeScene({ frame_style: 'laptop-flat' }),
          { frame_background: '#222222' },
        ),
      );
      expect(result?.backgroundColor).toBe('#222222');
    });
  });

  describe('returned shape', () => {
    it('includes the resolved frame entry and assets dir', async () => {
      const result = await resolveSceneFrame(
        baseOpts(makeScene({ frame_style: 'laptop-flat' })),
      );
      expect(result).toEqual({
        frameEntry: manifest.frames[0],
        backgroundColor: '#1a1a1a',
        assetsDir: FAKE_ASSETS,
      });
    });
  });

  describe("brand background guard — missing vpaHome / workspaceRoot", () => {
    it("throws a clear error when frame_background='brand' and no resolver or vpaHome", async () => {
      const opts = {
        scene: makeScene({ frame_style: 'laptop-flat', frame_background: 'brand' }),
        defaults: undefined,
        manifest,
        assetsDir: FAKE_ASSETS,
        projectPath: '/fake/project',
        vpaHome: '',          // empty — should trigger the guard
        workspaceRoot: '/fake/workspace',
        // No brandColorResolver injected
      };
      await expect(resolveSceneFrame(opts)).rejects.toThrow(
        /Cannot resolve frame_background='brand': vpaHome and workspaceRoot are required/,
      );
    });

    it("throws a clear error when frame_background='brand' and workspaceRoot is missing", async () => {
      const opts = {
        scene: makeScene({ frame_style: 'laptop-flat', frame_background: 'brand' }),
        defaults: undefined,
        manifest,
        assetsDir: FAKE_ASSETS,
        projectPath: '/fake/project',
        vpaHome: '/fake/vpa-home',
        workspaceRoot: '',    // empty — should trigger the guard
        // No brandColorResolver injected
      };
      await expect(resolveSceneFrame(opts)).rejects.toThrow(
        /Cannot resolve frame_background='brand': vpaHome and workspaceRoot are required/,
      );
    });

    it("does NOT throw when a brandColorResolver is injected, even if vpaHome is empty", async () => {
      const opts = {
        scene: makeScene({ frame_style: 'laptop-flat', frame_background: 'brand' }),
        defaults: undefined,
        manifest,
        assetsDir: FAKE_ASSETS,
        projectPath: '/fake/project',
        vpaHome: '',
        workspaceRoot: '',
        brandColorResolver: (async () => '#aabbcc') satisfies BrandColorResolver,
      };
      const result = await resolveSceneFrame(opts);
      expect(result?.backgroundColor).toBe('#aabbcc');
    });
  });
});

describe('createCachingBrandColorResolver', () => {
  it('calls the inner resolver only once across multiple invocations', async () => {
    let callCount = 0;
    const inner: BrandColorResolver = async (_projectPath, _opts) => {
      callCount += 1;
      return '#cached';
    };

    const cached = createCachingBrandColorResolver(inner);

    const r1 = await cached('/fake/project', { vpaHome: '/vpa', workspaceRoot: '/ws' });
    const r2 = await cached('/fake/project', { vpaHome: '/vpa', workspaceRoot: '/ws' });
    const r3 = await cached('/fake/project', { vpaHome: '/vpa', workspaceRoot: '/ws' });

    expect(callCount).toBe(1);
    expect(r1).toBe('#cached');
    expect(r2).toBe('#cached');
    expect(r3).toBe('#cached');
  });

  it('each wrapper instance has its own independent cache', async () => {
    let callCount = 0;
    const inner: BrandColorResolver = async () => {
      callCount += 1;
      return `#color${callCount}`;
    };

    const wrapper1 = createCachingBrandColorResolver(inner);
    const wrapper2 = createCachingBrandColorResolver(inner);

    const r1 = await wrapper1('/fake/project', { vpaHome: '/vpa', workspaceRoot: '/ws' });
    const r2 = await wrapper2('/fake/project', { vpaHome: '/vpa', workspaceRoot: '/ws' });

    // Each wrapper calls the inner once — total 2 calls.
    expect(callCount).toBe(2);
    expect(r1).toBe('#color1');
    expect(r2).toBe('#color2');
  });
});
