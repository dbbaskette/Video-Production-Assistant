import { describe, it, expect } from 'vitest';
import { createFakeProbe, probeVideo } from './metadata.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('recording metadata', () => {
  describe('createFakeProbe', () => {
    it('returns expected metadata shape', async () => {
      const probe = createFakeProbe();
      const meta = await probe('/fake/path.mp4');
      expect(meta.duration_sec).toBe(47.2);
      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1080);
      expect(meta.codec).toBe('h264');
      expect(meta.fps).toBe(30);
      expect(meta.size_bytes).toBe(15_000_000);
    });

    it('ignores file path argument', async () => {
      const probe = createFakeProbe();
      const meta1 = await probe('/a.mp4');
      const meta2 = await probe('/b.mp4');
      expect(meta1).toEqual(meta2);
    });
  });

  describe('probeVideo', () => {
    it('throws on non-existent file', async () => {
      await expect(probeVideo('/tmp/does-not-exist-video.mp4')).rejects.toThrow();
    });

    it('probes a real file if ffprobe is available', async () => {
      // Check if ffprobe is available
      try {
        await execFileAsync('which', ['ffprobe']);
      } catch {
        return; // skip if no ffprobe
      }

      // Create a tiny test video with ffmpeg if available
      const testFile = '/tmp/vpa-test-probe.mp4';
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          testFile,
        ], { timeout: 10000 });
      } catch {
        return; // skip if ffmpeg can't create test file
      }

      const meta = await probeVideo(testFile);
      expect(meta.width).toBe(320);
      expect(meta.height).toBe(240);
      expect(meta.duration_sec).toBeGreaterThan(0);
      expect(meta.codec).toBe('h264');
      expect(meta.fps).toBeGreaterThan(0);
      expect(meta.size_bytes).toBeGreaterThan(0);
    });
  });
});
