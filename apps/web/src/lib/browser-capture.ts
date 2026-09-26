import type { BrowserCaptureTrackRole } from '@vpa/shared';

export interface PreparedCaptureTrack {
  id: string;
  role: BrowserCaptureTrackRole;
  kind: 'video' | 'audio';
  mimeType: string;
  stream: MediaStream;
  sharedAudioAvailable?: boolean;
}

export interface PreparedBrowserCapture {
  displayStream: MediaStream;
  userStream?: MediaStream;
  tracks: PreparedCaptureTrack[];
  sharedAudioAvailable: boolean;
}

export interface CaptureMediaDevices {
  getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream>;
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
}

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm'];

export function selectCaptureMime(kind: 'video' | 'audio', recorder: Pick<typeof MediaRecorder, 'isTypeSupported'> = MediaRecorder): string | null {
  return (kind === 'video' ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES)
    .find((mime) => recorder.isTypeSupported(mime)) ?? null;
}

export function releaseCapture(prepared: PreparedBrowserCapture | null | undefined): void {
  const unique = new Set<MediaStreamTrack>();
  for (const stream of [prepared?.displayStream, prepared?.userStream]) {
    for (const track of stream?.getTracks() ?? []) unique.add(track);
  }
  for (const track of unique) track.stop();
}

export async function prepareBrowserCapture(
  options: { microphone: boolean; camera: boolean },
  devices: CaptureMediaDevices = navigator.mediaDevices,
): Promise<PreparedBrowserCapture> {
  if (!devices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Browser recording requires desktop Chrome or Edge with screen capture enabled.');
  }
  const videoMime = selectCaptureMime('video');
  const audioMime = selectCaptureMime('audio');
  if (!videoMime || !audioMime) throw new Error('This browser does not support the required WebM recording formats.');

  let displayStream: MediaStream | undefined;
  let userStream: MediaStream | undefined;
  try {
    displayStream = await devices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
      audio: true,
    });
    if (options.microphone || options.camera) {
      userStream = await devices.getUserMedia({
        audio: options.microphone,
        video: options.camera ? { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    }

    const displayVideo = displayStream.getVideoTracks()[0];
    if (!displayVideo) throw new Error('The selected display did not provide a video track.');
    const tracks: PreparedCaptureTrack[] = [{
      id: `track_${crypto.randomUUID()}`,
      role: 'screen',
      kind: 'video',
      mimeType: videoMime,
      stream: new MediaStream([displayVideo]),
    }];
    const displayAudio = displayStream.getAudioTracks()[0];
    if (displayAudio) {
      tracks.push({
        id: `track_${crypto.randomUUID()}`,
        role: 'system-audio',
        kind: 'audio',
        mimeType: audioMime,
        stream: new MediaStream([displayAudio]),
        sharedAudioAvailable: true,
      });
    }
    const cameraTrack = userStream?.getVideoTracks()[0];
    if (cameraTrack) tracks.push({ id: `track_${crypto.randomUUID()}`, role: 'camera', kind: 'video', mimeType: videoMime, stream: new MediaStream([cameraTrack]) });
    const microphoneTrack = userStream?.getAudioTracks()[0];
    if (microphoneTrack) tracks.push({ id: `track_${crypto.randomUUID()}`, role: 'microphone', kind: 'audio', mimeType: audioMime, stream: new MediaStream([microphoneTrack]) });
    return { displayStream, userStream, tracks, sharedAudioAvailable: Boolean(displayAudio) };
  } catch (error) {
    releaseCapture(displayStream ? { displayStream, userStream, tracks: [], sharedAudioAvailable: false } : null);
    if (error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)) {
      throw new Error('Screen, microphone, or camera permission was denied. Nothing was recorded.');
    }
    throw error;
  }
}

export function attachCaptureEndedHandler(prepared: PreparedBrowserCapture, onEnded: () => void): () => void {
  const tracks = [...prepared.displayStream.getTracks(), ...(prepared.userStream?.getTracks() ?? [])];
  for (const track of tracks) track.addEventListener('ended', onEnded, { once: true });
  return () => {
    for (const track of tracks) track.removeEventListener('ended', onEnded);
  };
}
