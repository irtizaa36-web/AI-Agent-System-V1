---
status: accepted
---

# Local call recording and transcription, gated on consent

Irtiza wants Claude to be able to work from what was said on phone calls placed through the Mac ("Calls from iPhone"). Claude can't join a live call, so the useful shape is a transcript produced after the call that a Claude session can then read.

## Decision

**`orchestrator calls` records and transcribes on the Mac, and nothing leaves it.** `src/calls/calls.ts` records an aggregate input device with ffmpeg's `avfoundation` input. That device combines the microphone with BlackHole, which carries the call audio, so one recording has both sides. It then transcribes the recording with whisper.cpp (`whisper-cli`). Both run as local programs through an injected `ProcessRunner`, the same pattern as `GitRunner` in `auto-commit.ts`, so the tests never start either one. No cloud speech API is used, so call audio from people who never agreed to a third-party service is never uploaded.

**No new runtime dependency.** ffmpeg and whisper.cpp are installed with Homebrew and called as subprocesses, keeping ADR 0002 intact. The audio routing is a one-time manual step in Audio MIDI Setup, documented in `docs/operations/call-transcription.md`. `orchestrator calls doctor` checks each piece and says how to fix what's missing.

**Recording requires `--consent` on every run.** Many places require all parties to agree to a recording, and a Mac-side recording gives the other party no signal. That's unlike iPhone's built-in call recording, which announces itself. Without the flag the command refuses and explains why. With it, the tool writes a sidecar recording when consent was confirmed, and the transcript header carries that line. Files transcribed from elsewhere (`calls transcribe <file>`) are marked "consent unknown" rather than assumed.

**Storage is the gitignored `.orchestrator/calls/`.** Recordings and transcripts hold other people's voices and words, which counts as private personal data under CLAUDE.md. They are never committed and never copied into handoffs, per `docs/operations/local-operations.md`.

## Not built

- **Speaker separation.** The capture is mixed to mono, so transcripts don't label who spoke. Keeping the mic and BlackHole as separate channels would allow it later.
- **Automatic start and stop.** macOS exposes no supported "call started" hook for Continuity calls, so recording is started and stopped by hand.
- **Feeding transcripts to an Agent automatically.** A transcript is a file. Summaries and follow-ups go through a Claude session the operator starts, so any action taken from a call stays behind the existing approval gates (ADR 0004).
