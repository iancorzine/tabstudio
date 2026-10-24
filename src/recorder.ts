/**
 * Recorder: encodes the compositor canvas and the mixed audio track into an MP4.
 *
 * While recording, a fragmented MP4 streams into the browser's private file store (OPFS)
 * through a worker, so a crash keeps everything up to the last second. When recording
 * stops, the file is converted (packet copy, no re-encode) into a standard MP4 in the
 * folder Ian chose, or downloaded if no folder was chosen.
 */
import {
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
  type StreamTargetChunk,
} from 'mediabunny';
import OpfsWorker from './opfs-writer.worker?worker';
import { AUDIO_BITRATE, videoBitrate, type Settings } from './settings';

const TEMP_SUFFIX = '.recording.mp4';

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopping' | 'finalizing';

export interface RecorderEvents {
  state: (s: RecorderState) => void;
  log: (msg: string, isError?: boolean) => void;
  progress: (fraction: number | null, label: string) => void;
}

export interface Capabilities {
  avc: boolean;
  hevc: boolean;
  aac: boolean;
}

export async function probeCapabilities(s: Settings): Promise<Capabilities> {
  const { width, height } = s.resolution === 2160 ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };
  const bitrate = videoBitrate(s);
  const [avc, hevc, aac] = await Promise.all([
    canEncodeVideo('avc', { width, height, bitrate }).catch(() => false),
    canEncodeVideo('hevc', { width, height, bitrate }).catch(() => false),
    canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE }).catch(() => false),
  ]);
  return { avc, hevc, aac };
}

class OpfsFile {
  private worker: Worker;
  private pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

  constructor() {
    this.worker = new OpfsWorker();
    this.worker.onmessage = (ev) => {
      const m = ev.data as { type: string; message?: string; size?: number };
      const p = this.pending.shift();
      if (!p) return;
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
  }

  private call(msg: unknown, transfer: Transferable[] = []) {
    return new Promise<unknown>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  open(name: string) {
    return this.call({ type: 'open', name });
  }
  write(data: Uint8Array, position: number) {
    const copy = data.slice().buffer as ArrayBuffer;
    return this.call({ type: 'write', data: copy, position }, [copy]);
  }
  async close(): Promise<number> {
    const r = (await this.call({ type: 'close' })) as { size: number };
    this.worker.terminate();
    return r.size;
  }
}

export class Recorder {
  state: RecorderState = 'idle';
  private output: Output | null = null;
  private video: CanvasSource | null = null;
  private audio: AudioSampleSource | null = null;
  private opfs: OpfsFile | null = null;
  private tempName = '';
  private baseName = '';

  private startWall = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private lastVideoTs = -1;
  private frameDuration = 1 / 30;
  private videoBusy = false;
  private droppedFrames = 0;

  private audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  private audioFrames = 0; // frames written so far, gives gapless timestamps across pauses
  private audioSampleRate = 48000;

  constructor(private events: RecorderEvents) {}

  private setState(s: RecorderState) {
    this.state = s;
    this.events.state(s);
  }

  /** Seconds of recorded material (excludes paused time). */
  elapsed(): number {
    if (this.state === 'idle' || this.state === 'finalizing') return 0;
    const now = this.state === 'paused' ? this.pausedAt : performance.now();
    return Math.max(0, (now - this.startWall - this.pausedTotal) / 1000);
  }

  async start(canvas: HTMLCanvasElement, audioTrack: MediaStreamAudioTrack, settings: Settings, caps: Capabilities) {
    if (this.state !== 'idle') throw new Error('Already recording');
    this.setState('recording');

    const codec = settings.codec === 'hevc' && caps.hevc ? 'hevc' : 'avc';
    if (settings.codec === 'hevc' && !caps.hevc) this.events.log('HEVC is not available on this machine. Using H.264.');
    const audioCodec = caps.aac ? 'aac' : 'opus';
    if (!caps.aac) this.events.log('AAC audio is not available here. Using Opus, which some players do not support.');

    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.baseName = `TabStudio ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    this.tempName = this.baseName + TEMP_SUFFIX;

    this.opfs = new OpfsFile();
    await this.opfs.open(this.tempName);
    const opfs = this.opfs;
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => opfs.write(chunk.data, chunk.position).then(() => undefined),
    });

    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new StreamTarget(writable),
    });

    this.frameDuration = 1 / settings.fps;
    this.video = new CanvasSource(canvas, {
      codec,
      bitrate: videoBitrate(settings),
      keyFrameInterval: 2,
    });
    this.audio = new AudioSampleSource({ codec: audioCodec, bitrate: AUDIO_BITRATE });
    this.output.addVideoTrack(this.video, { frameRate: settings.fps });
    this.output.addAudioTrack(this.audio);

    this.startWall = performance.now();
    this.pausedTotal = 0;
    this.lastVideoTs = -1;
    this.audioFrames = 0;
    this.droppedFrames = 0;

    await this.output.start();
    this.pumpAudio(audioTrack);
    this.events.log(`Recording ${settings.resolution === 2160 ? '4K' : '1080p'} ${settings.fps} fps, ${codec === 'hevc' ? 'HEVC' : 'H.264'}, ${Math.round(videoBitrate(settings) / 1e6)} Mbps.`);
  }

  /** Called by the compositor after each composite. */
  onFrame() {
    if (this.state !== 'recording' || !this.video) return;
    if (this.videoBusy) {
      this.droppedFrames++;
      return;
    }
    let ts = (performance.now() - this.startWall - this.pausedTotal) / 1000;
    if (ts <= this.lastVideoTs) ts = this.lastVideoTs + this.frameDuration / 2;
    this.lastVideoTs = ts;
    this.videoBusy = true;
    this.video
      .add(ts, this.frameDuration)
      .catch((e) => this.events.log(`Video encode error: ${e instanceof Error ? e.message : e}`, true))
      .finally(() => {
        this.videoBusy = false;
      });
  }

  private pumpAudio(track: MediaStreamAudioTrack) {
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    this.audioReader = reader;
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          try {
            if (this.state === 'recording' && this.audio) {
              this.audioSampleRate = value.sampleRate;
              const sample = this.toSample(value);
              await this.audio.add(sample);
              sample.close();
            }
          } finally {
            value.close();
          }
        }
      } catch (e) {
        if (this.state === 'recording' || this.state === 'paused') {
          this.events.log(`Audio error: ${e instanceof Error ? e.message : e}`, true);
        }
      }
    })();
  }

  /** Copy an AudioData into an AudioSample with a gapless timestamp of our own. */
  private toSample(data: AudioData): AudioSample {
    const channels = data.numberOfChannels;
    const frames = data.numberOfFrames;
    const buf = new Float32Array(channels * frames);
    for (let c = 0; c < channels; c++) {
      data.copyTo(buf.subarray(c * frames, (c + 1) * frames), { planeIndex: c, format: 'f32-planar' });
    }
    const sample = new AudioSample({
      data: buf,
      format: 'f32-planar',
      numberOfChannels: channels,
      sampleRate: data.sampleRate,
      timestamp: this.audioFrames / this.audioSampleRate,
    });
    this.audioFrames += frames;
    return sample;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.pausedAt = performance.now();
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.setState('recording');
  }

  /**
   * Stop, then deliver the file. Returns the final file name.
   * @param dir Folder chosen with showDirectoryPicker, or null to download.
   */
  async stop(dir: FileSystemDirectoryHandle | null, standardMp4: boolean): Promise<string> {
    if (this.state === 'paused') this.resume();
    if (this.state !== 'recording') throw new Error('Not recording');
    this.setState('stopping');

    this.video?.close();
    this.audio?.close();
    await this.audioReader?.cancel().catch(() => {});
    this.audioReader = null;
    await this.output?.finalize();
    const size = await this.opfs!.close();
    this.opfs = null;
    this.output = null;
    this.video = null;
    this.audio = null;
    if (this.droppedFrames > 0) this.events.log(`${this.droppedFrames} frames were dropped because the encoder fell behind.`);
    this.events.log(`Recorded ${(size / 1e6).toFixed(0)} MB. Saving...`);

    this.setState('finalizing');
    try {
      const name = await Recorder.deliver(this.tempName, this.baseName + '.mp4', dir, standardMp4, this.events);
      await Recorder.deleteTemp(this.tempName);
      return name;
    } finally {
      this.setState('idle');
    }
  }

  // ---- Delivery and recovery (static so the recovery path can reuse them) ----

  static async deliver(
    tempName: string,
    finalName: string,
    dir: FileSystemDirectoryHandle | null,
    standardMp4: boolean,
    events: RecorderEvents,
  ): Promise<string> {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(tempName)).getFile();

    if (dir) {
      const fh = await dir.getFileHandle(finalName, { create: true });
      const writable = await fh.createWritable();
      try {
        if (standardMp4) {
          await Recorder.remux(file, new StreamTarget(writable, { chunked: true }), events);
        } else {
          events.progress(null, 'Copying file');
          await file.stream().pipeTo(writable, { preventClose: true });
        }
      } finally {
        await writable.close();
      }
      events.progress(null, '');
      return finalName;
    }

    // No folder chosen: build in memory and download.
    let blob: Blob = file;
    if (standardMp4) {
      const target = new BufferTarget();
      await Recorder.remux(file, target, events);
      blob = new Blob([target.buffer!], { type: 'video/mp4' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = finalName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    events.progress(null, '');
    return finalName;
  }

  /** Packet copy from the fragmented recording into a standard MP4. No re-encode. */
  private static async remux(file: File, target: StreamTarget | BufferTarget, events: RecorderEvents) {
    const input = new Input({ formats: [MP4], source: new BlobSource(file) });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) {
      throw new Error('Could not convert the recording: ' + conversion.discardedTracks.map((t) => t.reason).join(', '));
    }
    conversion.onProgress = (p) => events.progress(p, `Converting ${Math.round(p * 100)}%`);
    await conversion.execute();
  }

  static async listUnfinished(): Promise<Array<{ name: string; size: number }>> {
    const root = await navigator.storage.getDirectory();
    const out: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind === 'file' && name.endsWith(TEMP_SUFFIX)) {
        const f = await (handle as FileSystemFileHandle).getFile();
        if (f.size > 0) out.push({ name, size: f.size });
      }
    }
    return out;
  }

  static async recover(tempName: string, dir: FileSystemDirectoryHandle | null, standardMp4: boolean, events: RecorderEvents) {
    const finalName = tempName.replace(TEMP_SUFFIX, ' (recovered).mp4');
    const name = await Recorder.deliver(tempName, finalName, dir, standardMp4, events);
    await Recorder.deleteTemp(tempName);
    return name;
  }

  static async deleteTemp(tempName: string) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(tempName).catch(() => {});
  }
}
