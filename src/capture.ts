/**
 * Device capture: cameras, microphone, and the shared Chrome tab.
 * Everything here returns plain MediaStreams. The compositor and mixer consume them.
 */

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
}

/** Ask once for camera and mic permission so device labels are readable, then list devices. */
export async function listDevices(): Promise<DeviceLists> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // The user may deny one of them. Labels for the other still show up.
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput'),
  };
}

/** Open a camera at the largest size it offers up to the requested frame size. */
export async function openCamera(deviceId: string, width: number, height: number, fps: number): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps },
    },
    audio: false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Open the microphone with processing off. Ian records with headphones, so echo
 * cancellation and noise suppression would only degrade the voice.
 */
export async function openMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    },
    video: false,
  });
}

/**
 * Share a Chrome tab with its audio. Only tab content is captured: no address bar,
 * no other tabs. The picker is restricted to tabs so a whole screen cannot be chosen by mistake.
 */
export async function openTab(width: number, height: number, fps: number): Promise<MediaStream> {
  const options: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: {
      displaySurface: 'browser',
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps },
    },
    audio: {
      // Keep the tab playing through the headphones while we also capture it.
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    } as MediaTrackConstraints,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'exclude',
    systemAudio: 'exclude',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  return stream;
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** A short label for the status line, such as "1920x1080, audio". */
export function describeStream(stream: MediaStream): string {
  const v = stream.getVideoTracks()[0]?.getSettings();
  const a = stream.getAudioTracks().length > 0;
  const size = v?.width && v?.height ? `${v.width}x${v.height}` : 'video';
  return `${size}${a ? ', with audio' : ', no audio'}`;
}
