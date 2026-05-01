import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  duration_sec: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  size_bytes: number;
}

export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
  if (!videoStream) throw new Error('No video stream found in file');

  const [num, den] = (videoStream.r_frame_rate ?? '30/1').split('/');
  const fps = den ? Number(num) / Number(den) : Number(num);

  return {
    duration_sec: parseFloat(info.format?.duration ?? videoStream.duration ?? '0'),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    codec: videoStream.codec_name ?? 'unknown',
    fps: Math.round(fps * 100) / 100,
    size_bytes: parseInt(info.format?.size ?? '0', 10),
  };
}

export function createFakeProbe(): typeof probeVideo {
  return async (_filePath: string): Promise<VideoMetadata> => ({
    duration_sec: 47.2,
    width: 1920,
    height: 1080,
    codec: 'h264',
    fps: 30,
    size_bytes: 15_000_000,
  });
}
