/**
 * Writes recording bytes straight into a file in the browser's private file store (OPFS)
 * using a synchronous access handle. Writes land on disk immediately and are flushed
 * every second, so a crash keeps everything up to the last flush. The main thread
 * copies the finished file into the chosen folder when recording stops.
 */
type Msg =
  | { type: 'open'; name: string }
  | { type: 'write'; data: ArrayBuffer; position: number }
  | { type: 'close' };

let handle: FileSystemSyncAccessHandle | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(msg.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      flushTimer = setInterval(() => {
        if (handle && dirty) {
          handle.flush();
          dirty = false;
        }
      }, 1000);
      self.postMessage({ type: 'opened' });
    } else if (msg.type === 'write') {
      if (!handle) throw new Error('File not open');
      handle.write(new Uint8Array(msg.data), { at: msg.position });
      dirty = true;
      self.postMessage({ type: 'written' });
    } else if (msg.type === 'close') {
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = null;
      if (handle) {
        handle.flush();
        const size = handle.getSize();
        handle.close();
        handle = null;
        self.postMessage({ type: 'closed', size });
      } else {
        self.postMessage({ type: 'closed', size: 0 });
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
