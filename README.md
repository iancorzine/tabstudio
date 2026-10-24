# TabStudio

A browser recorder that runs in Chrome on your Mac. It records up to three cameras (including your iPhone through Continuity Camera), a shared Chrome tab with its sound, and your microphone, into one MP4 file.

## Setup (one time)

1. Install Node.js if you do not have it: https://nodejs.org (the LTS version).
2. Open Terminal, go to this folder, and run:

```
npm install
```

## Run

```
npm run dev
```

Then open http://localhost:5173 in Google Chrome. Chrome will ask for camera and microphone permission once.

Leave the Terminal window open while you record. Close it when you are done.

## Self-test (do this first)

Open http://localhost:5173/selftest.html. It records a synthetic picture and a test tone for 4 seconds with no camera, then checks the file. The last line should say `RESULT: PASS`, and the small video player should play the clip with sound. If it says FAIL, copy the text on the page and send it to me.

## Recording

1. Pick Camera 1 (and 2 and 3 if you want them). Your iPhone appears as a camera when it is near the Mac and unlocked.
2. Pick your microphone.
3. Click **Share tab**, choose the Chrome tab you want to record, and tick **Also share tab audio** in Chrome's picker. Without that tick the tab's sound is not recorded.
4. Click **Choose save folder** and pick your Movies folder (or any folder). Chrome remembers it.
5. Set resolution, frame rate, codec, and quality. The line under Quality shows the expected file size per minute.
6. Click **Record**. Click **Pause** to pause, **Stop** to finish. The file is saved to the folder with a date and time in its name.

### Keys (click the preview first so the app has keyboard focus)

- `1`, `2`, `3`: switch cameras
- `F`: camera full frame. `P`: picture in picture. `T`: tab only.
- `Space`: record, then pause and resume
- `S`: stop

### Picture in picture

Drag the camera window anywhere. Drag its bottom-right corner to resize. Choose rectangle, rounded, or circle in the panel. The position is remembered.

### Audio

The two sliders change mic and tab volume live while recording. 100% is unchanged, 200% is twice as loud. The meters turn red when the sound is clipping; turn that slider down.

Wear headphones. The app turns echo cancellation and noise suppression off for a cleaner voice, so tab sound coming out of speakers would be picked up by the mic.

### Teleprompter

Paste your script, click Show, and set the speed. It sits over the top of the preview and is never recorded.

## How the file is saved

While recording, the app writes a crash-safe file inside Chrome's private storage, flushed every second. When you press Stop, it converts that file into a standard MP4 in your folder (a fast copy, no re-encoding) and deletes the temporary copy.

If Chrome crashes or you close the tab by mistake, open the app again. A yellow box says "Unfinished recording found." Click **Recover it** and the file is saved to your folder with "(recovered)" in its name.

## Settings you may want to change

- **Codec**: H.264 plays everywhere. HEVC makes files about one third smaller, but some Windows players and web uploaders reject it. The HEVC option is greyed out if your Chrome cannot encode it.
- **Quality**: 3 (High) is the default. It gives about 12 Mbps at 1080p30 and about 40 Mbps at 4K30.
- **Convert to standard MP4 when done**: leave this on. Turn it off only if a conversion ever fails; you then get the fragmented file, which still plays in most players.

## Limits

- Chrome on a desktop computer only. Safari and Firefox do not have the needed APIs.
- 4K at 60 fps may drop frames. The log line at the bottom tells you if frames were dropped.
- If you do not choose a save folder, the file downloads to your Downloads folder. That path builds the file in memory, so choose a folder for long or 4K recordings.
- Only tab capture is supported, by design. Chrome's picker still shows windows; picking one works but shows the window's own chrome.

## Project layout

- `src/capture.ts`: cameras, mic, tab share
- `src/compositor.ts`: canvas compositing, layouts, picture-in-picture, hotkeys
- `src/audio.ts`: mic and tab gain, meters, merged track
- `src/recorder.ts`: encoding, crash-safe writing, conversion, recovery
- `src/opfs-writer.worker.ts`: the worker that writes bytes to disk
- `src/teleprompter.ts`, `src/folder.ts`, `src/settings.ts`, `src/main.ts`: UI and glue
- `selftest.html` and `src/selftest.ts`: the self-test
