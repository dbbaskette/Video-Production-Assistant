import { describe, it, expect, beforeEach } from 'vitest';
import { TtsService, createFakeTtsProvider } from './index.js';

describe('TtsService', () => {
  let service: TtsService;

  beforeEach(() => {
    service = new TtsService();
    service.register(createFakeTtsProvider());
  });

  it('lists registered engines', () => {
    const engines = service.listEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.id).toBe('fake');
    expect(engines[0]!.displayName).toBe('Fake TTS (Development)');
    expect(engines[0]!.voices.length).toBeGreaterThan(0);
  });

  it('gets a provider by id', () => {
    expect(service.getProvider('fake')).toBeDefined();
    expect(service.getProvider('nonexistent')).toBeUndefined();
  });

  it('generates audio with timings', async () => {
    const result = await service.generate('fake', '[warm] Hello world, this is a test.', {
      voice: 'alice',
    });
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.timings).toBeDefined();
    expect(result.timings!.length).toBeGreaterThan(0);
    // Emotive tags should be stripped from timings
    expect(result.timings!.some((t) => t.word.startsWith('['))).toBe(false);
  });

  it('throws for unknown engine', async () => {
    await expect(service.generate('nonexistent', 'hello', { voice: 'x' })).rejects.toThrow(
      'TTS engine not found',
    );
  });

  it('adjusts duration by speed', async () => {
    const normal = await service.generate('fake', 'Hello world this is a test sentence', {
      voice: 'alice',
      speed: 1.0,
    });
    const fast = await service.generate('fake', 'Hello world this is a test sentence', {
      voice: 'alice',
      speed: 2.0,
    });
    expect(fast.durationSec).toBeLessThan(normal.durationSec);
  });

  it('checks unsupported emotive tags', () => {
    const unsupported = service.checkEmotives('fake', '[warm] Hello [alien-tone] world');
    expect(unsupported).toContain('alien-tone');
    expect(unsupported).not.toContain('warm');
  });

  it('returns empty for checkEmotives with unknown engine', () => {
    expect(service.checkEmotives('nonexistent', '[warm] hello')).toEqual([]);
  });
});
