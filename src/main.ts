import { AudioMixer } from './audio';
import { describeStream, listDevices, openCamera, openMic, openTab, stopStream } from './capture';
import { Compositor } from './compositor';
import { ensureWritable, loadFolder, pickFolder } from './folder';
import { Recorder, probeCapabilities, type Capabilities, type RecorderState } from './recorder';
import {
  formatBytesPerMinute,
  frameSize,
  loadSettings,
  qualityLabel,
  saveSettings,
  videoBitrate,
  type Codec,
  type Layout,
  type PipShape,
  type Settings,
} from './settings';
import { Teleprompter } from './teleprompter';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const settings: Settings = loadSettings();
const preview = $<HTMLCanvasElement>('preview');
const compositor = new Compositor(preview);
const mixer = new AudioMixer();
const teleprompter = new Teleprompter($('teleprompter'), $('tpScroll'));

const logEl = $('log');
const statusEl = $('status');
const clockEl = $('clock');
const progressEl = $('progress');
const progressBar = $('progressBar');
const progressText = $('progressText');

function log(msg: string, isError = false) {
  logEl.textContent = msg;
  logEl.classList.toggle('error', isError);
  (isError ? console.error : console.log)(msg);
}

const recorder = new Recorder({
  state: onRecorderState,
  log,
  progress: (fraction, label) => {
    progressEl.classList.toggle('hidden', !label);
    progressText.textContent = label;
    progressBar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
  },
});

let caps: Capabilities = { avc: true, hevc: false, aac: true };
let folder: FileSystemDirectoryHandle | null = null;
const camStreams: (MediaStream | null)[] = [null, null, null];
let micStream: MediaStream | null = null;
let tabStream: MediaStream | null = null;
let wakeLock: WakeLockSentinel | null = null;

// ---------- Sources ----------

async function populateDevices() {
  const { cameras, mics } = await listDevices();
  for (let i = 0; i < 3; i++) {
    const sel = $<HTMLSelectElement>(`cam${i + 1}`);
    sel.innerHTML = '<option value="">None</option>' + cameras.map((c) => `<option value="${c.deviceId}">${c.label || 'Camera'}</option>`).join('');
    sel.value = settings.cameraIds[i];
    if (sel.value !== settings.cameraIds[i]) sel.value = '';
  }
  const micSel = $<HTMLSelectElement>('mic');
  micSel.innerHTML = mics.map((m) => `<option value="${m.deviceId}">${m.label || 'Microphone'}</option>`).join('');
  micSel.value = settings.micId;
  if (!micSel.value && mics.length) micSel.value = mics[0].deviceId;
}

async function applyCamera(index: number) {
  const id = $<HTMLSelectElement>(`cam${index + 1}`).value;
  settings.cameraIds[index] = id;
  saveSettings(settings);
  stopStream(camStreams[index]);
  camStreams[index] = null;
  compositor.setCamera(index, null);
  if (!id) {
    updateHint();
    return;
  }
  try {
    const { width, height } = frameSize(settings.resolution);
    const stream = await openCamera(id, width, height, settings.fps);
    camStreams[index] = stream;
    compositor.setCamera(index, stream.getVideoTracks()[0] as MediaStreamVideoTrack);
    log(`Camera ${index + 1}: ${describeStream(stream)}`);
  } catch (e) {
    log(`Camera ${index + 1} could not open: ${e instanceof Error ? e.message : e}`, true);
  }
  updateHint();
}

async function applyMic() {
  const id = $<HTMLSelectElement>('mic').value;
  settings.micId = id;
  saveSettings(settings);
  stopStream(micStream);
  micStream = null;
  mixer.setMic(null);
  try {
    micStream = await openMic(id);
    mixer.setMic(micStream);
    await mixer.resume();
  } catch (e) {
    log(`Microphone could not open: ${e instanceof Error ? e.message : e}`, true);
  }
}

async function shareTab() {
  try {
    const { width, height } = frameSize(settings.resolution);
    const stream = await openTab(width, height, settings.fps);
    stopTab(false);
    tabStream = stream;
    compositor.setTab(stream.getVideoTracks()[0] as MediaStreamVideoTrack);
    mixer.setTab(stream);
    await mixer.resume();
    const hasAudio = stream.getAudioTracks().length > 0;
    $('tabInfo').textContent = `Sharing a tab: ${describeStream(stream)}.` + (hasAudio ? '' : ' Tick "Also share tab audio" in the picker to record its sound.');
    $<HTMLButtonElement>('btnStopTab').disabled = false;
    stream.getVideoTracks()[0].addEventListener('ended', () => stopTab(true));
    if (compositor.layout === 'full' && !compositor.hasCamera(compositor.activeCam)) setLayout('tab');
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotAllowedError')) log(`Tab share failed: ${e instanceof Error ? e.message : e}`, true);
  }
  updateHint();
}

function stopTab(fromBrowser: boolean) {
  stopStream(tabStream);
  tabStream = null;
  compositor.setTab(null);
  mixer.setTab(null);
  $('tabInfo').textContent = fromBrowser ? 'Tab sharing ended.' : 'No tab shared.';
  $<HTMLButtonElement>('btnStopTab').disabled = true;
  if (fromBrowser && (recorder.state === 'recording' || recorder.state === 'paused')) log('Tab sharing stopped while recording. The tab area is now black.', true);
  updateHint();
}

function updateHint() {
  const any = compositor.hasTab() || [0, 1, 2].some((i) => compositor.hasCamera(i));
  $('stageHint').classList.toggle('hidden', any);
}

// ---------- Layout and camera switching ----------

function setLayout(layout: Layout) {
  compositor.layout = layout;
  document.querySelectorAll<HTMLButtonElement>('#layoutSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
}

function setActiveCam(index: number) {
  compositor.activeCam = index;
  document.querySelectorAll<HTMLButtonElement>('#camSeg .seg-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.cam) === index));
}

// ---------- Recording settings ----------

async function refreshCapabilities() {
  caps = await probeCapabilities(settings);
  const codecSel = $<HTMLSelectElement>('codec');
  const hevcOpt = codecSel.querySelector('option[value="hevc"]') as HTMLOptionElement;
  hevcOpt.disabled = !caps.hevc;
  hevcOpt.textContent = caps.hevc ? 'HEVC (smaller file)' : 'HEVC (not available on this Chrome)';
  if (!caps.hevc && settings.codec === 'hevc') {
    settings.codec = 'avc';
    codecSel.value = 'avc';
  }
  if (!caps.avc) log('H.264 encoding is not available in this browser. Recording will not work.', true);
  updateBitrateInfo();
}

function updateBitrateInfo() {
  const bps = videoBitrate(settings);
  $('bitrateInfo').textContent = `About ${(bps / 1e6).toFixed(0)} Mbps, roughly ${formatBytesPerMinute(bps + 192_000)}.`;
  $('qualityVal').textContent = qualityLabel(settings.quality);
}

async function applyFrameSettings() {
  const { width, height } = frameSize(settings.resolution);
  compositor.setFrame(width, height, settings.fps);
  const constraints: MediaTrackConstraints = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: settings.fps } };
  for (const s of [...camStreams, tabStream]) {
    const t = s?.getVideoTracks()[0];
    if (t) await t.applyConstraints(constraints).catch(() => {});
  }
  await refreshCapabilities();
}

function setRecordingControlsEnabled(enabled: boolean) {
  for (const id of ['resolution', 'fps', 'codec', 'quality', 'standardMp4', 'btnFolder']) {
    ($(id) as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = !enabled;
  }
}

// ---------- Record, pause, stop ----------

function onRecorderState(s: RecorderState) {
  const rec = $<HTMLButtonElement>('btnRecord');
  const pause = $<HTMLButtonElement>('btnPause');
  const stop = $<HTMLButtonElement>('btnStop');
  rec.disabled = s !== 'idle';
  pause.disabled = !(s === 'recording' || s === 'paused');
  pause.textContent = s === 'paused' ? 'Resume' : 'Pause';
  stop.disabled = !(s === 'recording' || s === 'paused');
  statusEl.className = 'status' + (s === 'recording' ? ' live' : s === 'paused' ? ' paused' : '');
  statusEl.textContent = { idle: 'Not recording', recording: 'Recording', paused: 'Paused', stopping: 'Stopping', finalizing: 'Saving' }[s];
  setRecordingControlsEnabled(s === 'idle');
  document.title = s === 'recording' ? '● Recording - TabStudio' : 'TabStudio';
}

async function startRecording() {
  if (recorder.state !== 'idle') return;
  if (!compositor.hasTab() && ![0, 1, 2].some((i) => compositor.hasCamera(i))) {
    log('Pick a camera or share a tab first.', true);
    return;
  }
  if (folder && !(await ensureWritable(folder))) {
    log('No permission to write to the save folder. Choose it again.', true);
    return;
  }
  await mixer.resume();
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
  try {
    await recorder.start(compositor.canvas, mixer.outputTrack, settings, caps);
  } catch (e) {
    log(`Could not start: ${e instanceof Error ? e.message : e}`, true);
  }
}

async function stopRecording() {
  if (!(recorder.state === 'recording' || recorder.state === 'paused')) return;
  try {
    const name = await recorder.stop(folder, settings.standardMp4);
    log(`Saved ${name}${folder ? ` in ${folder.name}` : ' to Downloads'}.`);
  } catch (e) {
    log(`Save failed: ${e instanceof Error ? e.message : e}. The recording is still in the recovery list.`, true);
    await checkRecovery();
  } finally {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
}

function togglePause() {
  if (recorder.state === 'recording') recorder.pause();
  else if (recorder.state === 'paused') recorder.resume();
}

// ---------- Recovery ----------

async function checkRecovery() {
  const items = await Recorder.listUnfinished().catch(() => []);
  const group = $('recoverGroup');
  if (!items.length) {
    group.classList.add('hidden');
    return;
  }
  group.classList.remove('hidden');
  $('recoverInfo').textContent = items.map((i) => `${i.name.replace('.recording.mp4', '')} (${(i.size / 1e6).toFixed(0)} MB)`).join('; ');
  $('btnRecover').onclick = async () => {
    if (folder && !(await ensureWritable(folder))) return;
    for (const i of items) {
      try {
        const name = await Recorder.recover(i.name, folder, settings.standardMp4, { state: () => {}, log, progress: recorderProgress });
        log(`Recovered ${name}.`);
      } catch (e) {
        log(`Recovery failed for ${i.name}: ${e instanceof Error ? e.message : e}`, true);
      }
    }
    await checkRecovery();
  };
  $('btnDiscard').onclick = async () => {
    for (const i of items) await Recorder.deleteTemp(i.name);
    await checkRecovery();
  };
}

function recorderProgress(fraction: number | null, label: string) {
  progressEl.classList.toggle('hidden', !label);
  progressText.textContent = label;
  progressBar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
}

// ---------- Wiring ----------

function bind() {
  for (let i = 0; i < 3; i++) $(`cam${i + 1}`).addEventListener('change', () => applyCamera(i));
  $('mic').addEventListener('change', applyMic);
  $('btnShareTab').addEventListener('click', shareTab);
  $('btnStopTab').addEventListener('click', () => stopTab(false));

  document.querySelectorAll<HTMLButtonElement>('#layoutSeg .seg-btn').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout as Layout)));
  document.querySelectorAll<HTMLButtonElement>('#camSeg .seg-btn').forEach((b) => b.addEventListener('click', () => setActiveCam(Number(b.dataset.cam))));

  const pipShape = $<HTMLSelectElement>('pipShape');
  pipShape.value = settings.pipShape;
  compositor.pipShape = settings.pipShape;
  pipShape.addEventListener('change', () => {
    settings.pipShape = pipShape.value as PipShape;
    compositor.pipShape = settings.pipShape;
    saveSettings(settings);
  });
  compositor.pip = { ...settings.pip };
  $('btnResetPip').addEventListener('click', () => compositor.resetPip());
  let pipSaveTimer = 0;
  compositor.onPipChange = (pip) => {
    settings.pip = { ...pip };
    clearTimeout(pipSaveTimer);
    pipSaveTimer = window.setTimeout(() => saveSettings(settings), 300);
  };

  const micGain = $<HTMLInputElement>('micGain');
  const tabGain = $<HTMLInputElement>('tabGain');
  micGain.value = String(Math.round(settings.micGain * 100));
  tabGain.value = String(Math.round(settings.tabGain * 100));
  const applyGains = () => {
    settings.micGain = Number(micGain.value) / 100;
    settings.tabGain = Number(tabGain.value) / 100;
    $('micVal').textContent = `${micGain.value}%`;
    $('tabVal').textContent = `${tabGain.value}%`;
    mixer.setMicGain(settings.micGain);
    mixer.setTabGain(settings.tabGain);
    saveSettings(settings);
  };
  micGain.addEventListener('input', applyGains);
  tabGain.addEventListener('input', applyGains);
  applyGains();

  const res = $<HTMLSelectElement>('resolution');
  const fps = $<HTMLSelectElement>('fps');
  const codec = $<HTMLSelectElement>('codec');
  const quality = $<HTMLInputElement>('quality');
  const standard = $<HTMLInputElement>('standardMp4');
  res.value = String(settings.resolution);
  fps.value = String(settings.fps);
  codec.value = settings.codec;
  quality.value = String(settings.quality);
  standard.checked = settings.standardMp4;
  res.addEventListener('change', async () => {
    settings.resolution = Number(res.value) as 1080 | 2160;
    saveSettings(settings);
    await applyFrameSettings();
  });
  fps.addEventListener('change', async () => {
    settings.fps = Number(fps.value) as 30 | 60;
    saveSettings(settings);
    await applyFrameSettings();
  });
  codec.addEventListener('change', () => {
    settings.codec = codec.value as Codec;
    saveSettings(settings);
    updateBitrateInfo();
  });
  quality.addEventListener('input', () => {
    settings.quality = Number(quality.value) as Settings['quality'];
    saveSettings(settings);
    updateBitrateInfo();
  });
  standard.addEventListener('change', () => {
    settings.standardMp4 = standard.checked;
    saveSettings(settings);
  });

  $('btnFolder').addEventListener('click', async () => {
    try {
      folder = await pickFolder();
      $('folderInfo').textContent = `Saving to "${folder.name}".`;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) log(`Folder: ${e instanceof Error ? e.message : e}`, true);
    }
  });

  const tpText = $<HTMLTextAreaElement>('tpText');
  const tpSpeed = $<HTMLInputElement>('tpSpeed');
  tpText.value = settings.tpText;
  tpSpeed.value = String(settings.tpSpeed);
  teleprompter.speed = settings.tpSpeed;
  teleprompter.setText(settings.tpText);
  tpText.addEventListener('input', () => {
    settings.tpText = tpText.value;
    teleprompter.setText(tpText.value);
    saveSettings(settings);
  });
  tpSpeed.addEventListener('input', () => {
    settings.tpSpeed = Number(tpSpeed.value);
    teleprompter.speed = settings.tpSpeed;
    saveSettings(settings);
  });
  $('btnTp').addEventListener('click', () => {
    if (teleprompter.visible) {
      teleprompter.hide();
      $('btnTp').textContent = 'Show';
    } else {
      teleprompter.show();
      $('btnTp').textContent = 'Hide';
    }
  });

  $('btnRecord').addEventListener('click', startRecording);
  $('btnPause').addEventListener('click', togglePause);
  $('btnStop').addEventListener('click', stopRecording);

  document.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key) {
      case '1': case '2': case '3': setActiveCam(Number(ev.key) - 1); break;
      case 'f': case 'F': setLayout('full'); break;
      case 'p': case 'P': setLayout('pip'); break;
      case 't': case 'T': setLayout('tab'); break;
      case ' ':
        ev.preventDefault();
        if (recorder.state === 'idle') void startRecording();
        else togglePause();
        break;
      case 's': case 'S': void stopRecording(); break;
      default: return;
    }
  });

  window.addEventListener('beforeunload', (ev) => {
    if (recorder.state !== 'idle') {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  compositor.onFrame = () => recorder.onFrame();

  // Meters and clock.
  const micMeter = $('micMeter');
  const tabMeter = $('tabMeter');
  const meterLoop = () => {
    const { mic, tab } = mixer.levels();
    micMeter.style.width = `${Math.min(100, mic * 100)}%`;
    tabMeter.style.width = `${Math.min(100, tab * 100)}%`;
    micMeter.classList.toggle('hot', mic > 0.95);
    tabMeter.classList.toggle('hot', tab > 0.95);
    requestAnimationFrame(meterLoop);
  };
  requestAnimationFrame(meterLoop);
  setInterval(() => {
    const s = recorder.elapsed();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    clockEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }, 250);
}

async function init() {
  if (!('MediaStreamTrackProcessor' in window) || !('VideoEncoder' in window) || !navigator.mediaDevices?.getDisplayMedia) {
    log('This app needs a current version of Google Chrome on a desktop computer.', true);
    return;
  }
  bind();
  onRecorderState('idle');
  const { width, height } = frameSize(settings.resolution);
  compositor.setFrame(width, height, settings.fps);
  updateBitrateInfo();
  folder = await loadFolder();
  $('folderInfo').textContent = folder ? `Saving to "${folder.name}".` : 'No folder chosen. Files will download instead (fine for short clips; choose a folder for long or 4K recordings).';
  await populateDevices();
  await Promise.all([applyMic(), applyCamera(0), applyCamera(1), applyCamera(2)]);
  await refreshCapabilities();
  await checkRecovery();
  navigator.mediaDevices.addEventListener('devicechange', () => void populateDevices());
}

void init();
