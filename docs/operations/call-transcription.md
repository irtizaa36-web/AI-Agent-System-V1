# Call recording and transcription (Mac)

Records iPhone calls that ring through on the Mac ("Calls from iPhone") and transcribes them on the same Mac with whisper.cpp. Nothing is uploaded: the audio and the transcript stay in `.orchestrator/calls/`, which git ignores. Design and boundaries: ADR 0030.

## Consent first

Many places, including California, Florida, Illinois, Pennsylvania, Washington and the EU, require **every** person on a call to agree to a recording. Nothing about a Mac-side recording tells the other person it is happening. At the start of each call, say something like "I'm recording this call for my notes, is that OK?". Start recording only after they agree. The tool will not record without `--consent`, and it stores the time you confirmed alongside the recording.

## One-time setup

### 1. Install the tools

```bash
brew install ffmpeg whisper-cpp blackhole-2ch
```

BlackHole is a virtual audio cable. Restart the Mac (or run `sudo killall coreaudiod`) so macOS sees it.

### 2. Download a speech model

```bash
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

`large-v3-turbo` (~1.6 GB) is accurate and fast on Apple Silicon. For a smaller download, use `ggml-base.en.bin` (~150 MB, English only, less accurate).

### 3. Create two audio devices in Audio MIDI Setup

Open **Audio MIDI Setup** (in Applications → Utilities).

**Call Output**: the caller's voice goes to your ears *and* to BlackHole.
1. Click **+** (bottom left) → **Create Multi-Output Device**.
2. Tick your normal speakers or headphones first, then **BlackHole 2ch**.
3. Tick **Drift Correction** for BlackHole 2ch.
4. Double-click the device name and rename it `Call Output`.

**Call Capture**: the recorder hears the caller (BlackHole) plus you (the mic).
1. Click **+** → **Create Aggregate Device**.
2. Tick your microphone first, then **BlackHole 2ch**.
3. Tick **Drift Correction** for BlackHole 2ch.
4. Rename it `Call Capture`. The tool looks for this exact name. To use another name, set `CALLS_AUDIO_DEVICE`.

### 4. Settings

Add these lines to this checkout's `.env`, using your own path:

```bash
WHISPER_MODEL=/Users/<you>/whisper-models/ggml-large-v3-turbo.bin
# Optional:
# CALLS_AUDIO_DEVICE=Call Capture
# WHISPER_LANGUAGE=auto   # or en, es, ...
```

### 5. Check everything

```bash
npm run calls -- doctor
```

Every line should say `ok`. Each `FAIL` line says what to fix.

## Each call

1. Before or as the call starts, set **System Settings → Sound → Output** to **Call Output**. You can also Option-click the menu-bar volume icon. Volume keys don't work on a Multi-Output device, so set the volume on the speakers/headphones beforehand.
2. Answer or place the call on the Mac, and get the other person's consent.
3. In Terminal, in this checkout:
   ```bash
   npm run calls -- record --consent --label "dentist"
   ```
   The first time, macOS asks to let Terminal use the microphone. Allow it.
4. When the call ends, press **Ctrl+C** in Terminal. The tool saves the recording and transcribes it, which takes about a minute for a 10-minute call on Apple Silicon.
5. Switch the Sound output back to your normal speakers.

Files:

- `.orchestrator/calls/recordings/2026-10-05_143207_dentist.wav`: the audio
- `.orchestrator/calls/recordings/2026-10-05_143207_dentist.json`: when you confirmed consent
- `.orchestrator/calls/transcripts/2026-10-05_143207_dentist.md`: the transcript

## Other commands

```bash
npm run calls -- list                             # recordings and whether each is transcribed
npm run calls -- transcribe path/to/audio.m4a     # transcribe any audio file (e.g. a QuickTime or Voice Memos export)
npm run calls -- transcribe --pending             # transcribe every recording in the folder without a transcript
npm run calls -- record --consent --no-transcribe # record now, transcribe later
```

## Working with Claude on a transcript

- **Claude Code on this Mac** can read `.orchestrator/calls/transcripts/` directly. Ask it to summarize the call, pull out action items, or draft a follow-up.
- **A cloud or web Claude session** can't see your Mac. Paste the transcript text into the chat.
- **Never commit** recordings or transcripts. They contain other people's voices and words. `.orchestrator/` is gitignored; keep it that way.

## Limits

- Both sides are in one stream, so the transcript doesn't label who said what.
- Recording only works for calls whose audio plays through the Mac. A call answered on the iPhone itself isn't captured.
- AirPods and other Bluetooth headsets switch to a low-quality mode while the mic is in use. Wired headphones or the built-in speakers and mic give a cleaner transcript.
- Delete old recordings when you no longer need them: `rm .orchestrator/calls/recordings/<name>.*`.
