import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCaptureEndedHandler, prepareBrowserCapture, releaseCapture, selectCaptureMime } from './browser-capture.js';

class FakeTrack extends EventTarget {
  stop = vi.fn();
  constructor(public readonly kind: 'video' | 'audio') { super(); }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
}

describe('browser capture preparation', () => {
  const priorMediaStream = globalThis.MediaStream;
  const priorRecorder = globalThis.MediaRecorder;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: FakeStream });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: class { static isTypeSupported(value: string) { return value.includes('webm'); } },
    });
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('screen-0001').mockReturnValueOnce('system-0001').mockReturnValueOnce('camera-0001').mockReturnValueOnce('mic-0000001') });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: priorMediaStream });
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: priorRecorder });
    vi.unstubAllGlobals();
  });

  it('selects supported MIME types and reports actual shared audio availability', async () => {
    const display = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
    const user = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
    const devices = { getDisplayMedia: vi.fn().mockResolvedValue(display), getUserMedia: vi.fn().mockResolvedValue(user) };
    const prepared = await prepareBrowserCapture({ microphone: true, camera: true }, devices as unknown as MediaDevices);
    expect(devices.getDisplayMedia).toHaveBeenCalledOnce();
    expect(prepared.sharedAudioAvailable).toBe(true);
    expect(prepared.tracks.map((track) => track.role)).toEqual(['screen', 'system-audio', 'camera', 'microphone']);
    expect(selectCaptureMime('audio')).toBe('audio/webm;codecs=opus');
    releaseCapture(prepared);
    expect(display.getTracks().every((track) => track.stop.mock.calls.length === 1)).toBe(true);
    expect(user.getTracks().every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it('does not promise shared audio when the browser omits that track', async () => {
    const display = new FakeStream([new FakeTrack('video')]);
    const devices = { getDisplayMedia: vi.fn().mockResolvedValue(display), getUserMedia: vi.fn() };
    const prepared = await prepareBrowserCapture({ microphone: false, camera: false }, devices as unknown as MediaDevices);
    expect(prepared.sharedAudioAvailable).toBe(false);
    expect(prepared.tracks.map((track) => track.role)).toEqual(['screen']);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it('releases a display stream when a later device permission is denied', async () => {
    const displayTrack = new FakeTrack('video');
    const display = new FakeStream([displayTrack]);
    const denied = new DOMException('denied', 'NotAllowedError');
    const devices = { getDisplayMedia: vi.fn().mockResolvedValue(display), getUserMedia: vi.fn().mockRejectedValue(denied) };
    await expect(prepareBrowserCapture({ microphone: true, camera: false }, devices as unknown as MediaDevices)).rejects.toThrow('permission was denied');
    expect(displayTrack.stop).toHaveBeenCalledOnce();
  });

  it('reports source/device loss exactly once and allows listener cleanup', () => {
    const displayTrack = new FakeTrack('video');
    const userTrack = new FakeTrack('audio');
    const prepared = {
      displayStream: new FakeStream([displayTrack]),
      userStream: new FakeStream([userTrack]),
      tracks: [],
      sharedAudioAvailable: false,
    } as unknown as Awaited<ReturnType<typeof prepareBrowserCapture>>;
    const ended = vi.fn();
    const detach = attachCaptureEndedHandler(prepared, ended);
    displayTrack.dispatchEvent(new Event('ended'));
    displayTrack.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce();
    detach();
    userTrack.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce();
  });
});
