/**
 * Self-test: records a synthetic canvas and a test tone for a few seconds with no camera,
 * mic, or tab, then checks the produced MP4. Open /selftest.html and read the page.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Input } from 'mediabunny';
import { Recorder, probeCapabilities } from './recorder';
import { defaults, type Settings } from './settings';

const out = document.getElementById('out') as HTMLPreElement;
const say = (s: string) => {
  out.textContent += s + '\n';
  console.log('[selftest] ' + s);
};

async function run() {
  const settings: Settings = { ...structuredClone(defaults), resolution: 1080, fps: 30, codec: 'avc', quality: 3 };
  const caps = await probeCapabilities(settings);
  say(`capabilities: ${JSON.stringify(caps)}`);

  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d')!;
  let t = 0;
  const draw = () => {
    t++;
    ctx.fillStyle = `hsl(${(t * 2) % 360} 60% 30%)`;
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(960 + Math.sin(t / 20) * 600, 540, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '80px sans-serif';
    ctx.fillText(`frame ${t}`, 80, 160);
  };

  const ac = new AudioContext({ sampleRate: 48000 });
  const osc = ac.createOscillator();
  osc.frequency.value = 440;
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  await ac.resume();
  const audioTrack = dest.stream.getAudioTracks()[0] as MediaStreamAudioTrack;

  let captured: { blob: Blob; size: number } | null = null;
  Recorder.deliver = async (tempName) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(tempName)).getFile();
    say(`fragmented temp file: ${(file.size / 1e6).toFixed(2)} MB`);
    const target = new BufferTarget();
    await (Recorder as unknown as { remux: (f: File, t: BufferTarget, e: unknown) => Promise<void> }).remux(file, target, {
      state: () => {},
      log: say,
      progress: () => {},
    });
    captured = { blob: new Blob([target.buffer!], { type: 'video/mp4' }), size: target.buffer!.byteLength };
    return 'in-memory.mp4';
  };

  const recorder = new Recorder({ state: (s) => say(`state: ${s}`), log: (m, e) => say((e ? 'ERROR: ' : '') + m), progress: () => {} });
  await recorder.start(canvas, audioTrack, settings, caps);

  const ticker = setInterval(() => {
    draw();
    recorder.onFrame();
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, 2000));
  recorder.pause();
  say('paused 1 s (should not appear in the file)');
  await new Promise((r) => setTimeout(r, 1000));
  recorder.resume();
  await new Promise((r) => setTimeout(r, 2000));
  clearInterval(ticker);
  await recorder.stop(null, true);
  osc.stop();

  if (!captured) throw new Error('no output captured');
  const c = captured as { blob: Blob; size: number };
  say(`standard mp4: ${(c.size / 1e6).toFixed(2)} MB`);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(c.blob) });
  const fmt = await input.getFormat();
  const duration = await input.computeDuration();
  const tracks = await input.getTracks();
  say(`format: ${fmt.name}, duration: ${duration.toFixed(2)} s (expected about 4.0), tracks: ${tracks.length}`);
  for (const tr of tracks) {
    say(`  ${tr.type}: codec ${tr.codec}`);
  }
  const ok = tracks.length === 2 && duration > 3.5 && duration < 4.6;
  say(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  const url = URL.createObjectURL(c.blob);
  const v = document.getElementById('v') as HTMLVideoElement;
  v.src = url;
}

run().catch((e) => say('RESULT: FAIL ' + (e instanceof Error ? e.stack ?? e.message : String(e))));
