/**
 * Audio mixer: mic and tab audio each pass through a gain node tied to a slider,
 * then merge into one stereo track that the recorder encodes. Nothing here is sent
 * to the speakers; the shared tab keeps playing on its own through the headphones.
 */
export class AudioMixer {
  readonly ctx: AudioContext;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private tabSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode;
  private tabGain: GainNode;
  private micAnalyser: AnalyserNode;
  private tabAnalyser: AnalyserNode;
  private dest: MediaStreamAudioDestinationNode;
  private buf = new Float32Array(1024);

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    this.micGain = this.ctx.createGain();
    this.tabGain = this.ctx.createGain();
    this.micAnalyser = this.ctx.createAnalyser();
    this.tabAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.tabAnalyser.fftSize = 1024;
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.micGain.connect(this.micAnalyser).connect(this.dest);
    this.tabGain.connect(this.tabAnalyser).connect(this.dest);
  }

  /** The merged stereo track for the recorder. */
  get outputTrack(): MediaStreamAudioTrack {
    return this.dest.stream.getAudioTracks()[0] as MediaStreamAudioTrack;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setMic(stream: MediaStream | null) {
    this.micSource?.disconnect();
    this.micSource = null;
    if (stream && stream.getAudioTracks().length) {
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micGain);
    }
  }

  setTab(stream: MediaStream | null) {
    this.tabSource?.disconnect();
    this.tabSource = null;
    if (stream && stream.getAudioTracks().length) {
      // A separate MediaStream holding only the audio track, so the video track does not matter here.
      const audioOnly = new MediaStream(stream.getAudioTracks());
      this.tabSource = this.ctx.createMediaStreamSource(audioOnly);
      this.tabSource.connect(this.tabGain);
    }
  }

  /** gain 1 = unchanged, 2 = +6 dB, 0 = silent. Smooth so the slider does not click. */
  setMicGain(gain: number) {
    this.micGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }
  setTabGain(gain: number) {
    this.tabGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Peak levels 0 to 1 for the meters. */
  levels(): { mic: number; tab: number } {
    return { mic: this.peak(this.micAnalyser), tab: this.peak(this.tabAnalyser) };
  }

  private peak(a: AnalyserNode) {
    a.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i]);
      if (v > p) p = v;
    }
    return p;
  }
}
