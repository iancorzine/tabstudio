export type Codec = 'avc' | 'hevc';
export type Layout = 'full' | 'pip' | 'tab';
export type PipShape = 'rect' | 'rounded' | 'circle';

export interface Settings {
  resolution: 1080 | 2160;
  fps: 30 | 60;
  codec: Codec;
  quality: 1 | 2 | 3 | 4 | 5;
  standardMp4: boolean;
  cameraIds: [string, string, string];
  micId: string;
  micGain: number;
  tabGain: number;
  pipShape: PipShape;
  pip: { x: number; y: number; w: number }; // fractions of frame width/height; w is a fraction of width
  tpSpeed: number;
  tpText: string;
}

const KEY = 'tabstudio.settings.v1';

export const defaults: Settings = {
  resolution: 1080,
  fps: 30,
  codec: 'avc',
  quality: 3,
  standardMp4: true,
  cameraIds: ['', '', ''],
  micId: '',
  micGain: 1,
  tabGain: 1,
  pipShape: 'rounded',
  pip: { x: 0.72, y: 0.66, w: 0.25 },
  tpSpeed: 30,
  tpText: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaults);
    return { ...structuredClone(defaults), ...JSON.parse(raw) };
  } catch {
    return structuredClone(defaults);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Frame size for a resolution choice. */
export function frameSize(resolution: 1080 | 2160) {
  return resolution === 2160 ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };
}

/**
 * Video bitrate in bits per second. Quality 3 is the recommended default:
 * about 12 Mbps for 1080p30 H.264 and about 40 Mbps for 4K30 H.264.
 * HEVC uses roughly two thirds of the H.264 number at the same quality.
 */
export function videoBitrate(s: Settings): number {
  const base = s.resolution === 2160 ? 40_000_000 : 12_000_000;
  const qualityScale = [0.5, 0.75, 1, 1.4, 2][s.quality - 1];
  const fpsScale = s.fps === 60 ? 1.6 : 1;
  const codecScale = s.codec === 'hevc' ? 0.65 : 1;
  return Math.round(base * qualityScale * fpsScale * codecScale);
}

export const AUDIO_BITRATE = 192_000;

export function qualityLabel(q: number) {
  return ['Smallest', 'Small', 'High', 'Very high', 'Maximum'][q - 1];
}

export function formatBytesPerMinute(bitsPerSecond: number) {
  const mb = (bitsPerSecond / 8) * 60 / 1_000_000;
  return `${Math.round(mb)} MB per minute`;
}
