import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * Call recording and local transcription (ADR 0030).
 *
 * iPhone calls relayed to the Mac ("Calls from iPhone") play through the
 * Mac's audio devices. The operator routes them, plus the microphone, into
 * one aggregate input device (see docs/operations/call-transcription.md);
 * this module records that device with ffmpeg and transcribes the file with
 * whisper.cpp on the same machine. No audio or transcript leaves the Mac,
 * and everything lives under the gitignored `.orchestrator/calls/`.
 *
 * Recording needs explicit consent confirmation every time: many places
 * require every party to agree to a recording, and nothing about a Mac-side
 * recording tells the other party it is happening.
 */

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the program could not be started at all (e.g. not installed). */
  readonly error?: string;
}

/** Injected so tests never run ffmpeg or whisper. */
export interface ProcessRunner {
  /** Runs to completion with output captured. */
  run(command: string, args: readonly string[]): CommandResult;
  /** Runs attached to the terminal; Ctrl+C stops the child, not this process. */
  runInteractive(command: string, args: readonly string[]): Promise<number | null>;
}

export const realProcessRunner: ProcessRunner = {
  run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
  },
  runInteractive(command, args) {
    return new Promise((resolve, reject) => {
      // Ctrl+C reaches the whole process group. ffmpeg finalizes the file on
      // SIGINT; this process must survive it to go on and transcribe.
      const ignore = () => {};
      process.on("SIGINT", ignore);
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", (error) => {
        process.off("SIGINT", ignore);
        reject(error);
      });
      child.on("exit", (code) => {
        process.off("SIGINT", ignore);
        resolve(code);
      });
    });
  },
};

export interface CallsConfig {
  /** Root for recordings and transcripts: `<cwd>/.orchestrator/calls`. */
  readonly dir: string;
  /** The aggregate input device that carries both sides of the call. */
  readonly device: string;
  readonly ffmpegBin: string;
  readonly whisperBin: string;
  /** Path to a whisper.cpp ggml model file; required to transcribe. */
  readonly whisperModel?: string;
  /** whisper.cpp language code, or "auto". */
  readonly language: string;
}

export const DEFAULT_DEVICE = "Call Capture";

export function callsConfigFromEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): CallsConfig {
  return {
    dir: join(cwd, ".orchestrator", "calls"),
    device: env.CALLS_AUDIO_DEVICE || DEFAULT_DEVICE,
    ffmpegBin: env.CALLS_FFMPEG || "ffmpeg",
    whisperBin: env.WHISPER_BIN || "whisper-cli",
    whisperModel: env.WHISPER_MODEL || undefined,
    language: env.WHISPER_LANGUAGE || "auto",
  };
}

export const recordingsDir = (c: CallsConfig) => join(c.dir, "recordings");
export const transcriptsDir = (c: CallsConfig) => join(c.dir, "transcripts");

const AUDIO_EXTENSIONS = new Set([".wav", ".m4a", ".mp3", ".aac", ".caf", ".aiff", ".mp4"]);

/** `2026-10-05_1432_dentist` — sortable, local time, label reduced to safe filename characters. */
export function recordingBaseName(now: Date, label?: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug ? `${stamp}_${slug}` : stamp;
}

/** 16 kHz mono 16-bit PCM is what whisper.cpp reads directly. */
export function ffmpegRecordArgs(device: string, output: string): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-f", "avfoundation", "-i", `:${device}`, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
}

export function ffmpegConvertArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
}

export function whisperArgs(model: string, input: string, outputBase: string, language: string): string[] {
  return ["-m", model, "-f", input, "-l", language, "-otxt", "-of", outputBase];
}

interface ConsentRecord {
  readonly consentConfirmedAt: string;
  readonly label?: string;
  readonly device: string;
}

export interface RecordResult {
  readonly ok: boolean;
  readonly recording?: string;
  readonly error?: string;
}

/** Records until the operator presses Ctrl+C (or q). Caller must have confirmed consent. */
export async function recordCall(c: CallsConfig, runner: ProcessRunner, now: Date, label?: string): Promise<RecordResult> {
  await mkdir(recordingsDir(c), { recursive: true });
  const base = recordingBaseName(now, label);
  const recording = join(recordingsDir(c), `${base}.wav`);
  const consent: ConsentRecord = { consentConfirmedAt: now.toISOString(), ...(label ? { label } : {}), device: c.device };
  await writeFile(join(recordingsDir(c), `${base}.json`), `${JSON.stringify(consent, null, 2)}\n`);

  let code: number | null;
  try {
    code = await runner.runInteractive(c.ffmpegBin, ffmpegRecordArgs(c.device, recording));
  } catch (error) {
    return { ok: false, error: `could not start ${c.ffmpegBin}: ${(error as Error).message}` };
  }
  // ffmpeg exits 255 after a Ctrl+C; what matters is whether audio was written.
  const size = existsSync(recording) ? (await stat(recording)).size : 0;
  if (size <= 44) return { ok: false, recording, error: `no audio was recorded (ffmpeg exit ${code}). Run "orchestrator calls doctor".` };
  return { ok: true, recording };
}

export interface TranscribeResult {
  readonly ok: boolean;
  readonly transcript?: string;
  readonly error?: string;
}

export function transcriptPathFor(c: CallsConfig, recording: string): string {
  return join(transcriptsDir(c), `${basename(recording, extname(recording))}.md`);
}

async function readConsent(recording: string): Promise<ConsentRecord | undefined> {
  const sidecar = join(recording.slice(0, recording.length - extname(recording).length) + ".json");
  try {
    return JSON.parse(await readFile(sidecar, "utf-8")) as ConsentRecord;
  } catch {
    return undefined;
  }
}

export async function transcribeRecording(c: CallsConfig, runner: ProcessRunner, recording: string, now: Date): Promise<TranscribeResult> {
  if (!c.whisperModel) return { ok: false, error: "WHISPER_MODEL is not set. Point it at a downloaded ggml model file (see docs/operations/call-transcription.md)." };
  if (!existsSync(c.whisperModel)) return { ok: false, error: `WHISPER_MODEL file not found: ${c.whisperModel}` };
  if (!existsSync(recording)) return { ok: false, error: `recording not found: ${recording}` };

  await mkdir(transcriptsDir(c), { recursive: true });
  const base = basename(recording, extname(recording));
  const workBase = join(transcriptsDir(c), `.${base}.work`);
  const workWav = `${workBase}.wav`;
  const workTxt = `${workBase}.txt`;

  try {
    const convert = runner.run(c.ffmpegBin, ffmpegConvertArgs(recording, workWav));
    if (convert.error || convert.status !== 0) return { ok: false, error: `ffmpeg could not read ${recording}: ${convert.error ?? convert.stderr.trim()}` };

    const whisper = runner.run(c.whisperBin, whisperArgs(c.whisperModel, workWav, workBase, c.language));
    if (whisper.error || whisper.status !== 0 || !existsSync(workTxt)) {
      return { ok: false, error: `${c.whisperBin} failed: ${whisper.error ?? whisper.stderr.trim().split("\n").slice(-3).join(" ")}` };
    }

    const text = (await readFile(workTxt, "utf-8")).trim();
    const consent = await readConsent(recording);
    const transcript = transcriptPathFor(c, recording);
    await writeFile(transcript, formatTranscript({ base, recording, text, consent, model: basename(c.whisperModel), now }));
    return { ok: true, transcript };
  } finally {
    await rm(workWav, { force: true });
    await rm(workTxt, { force: true });
  }
}

export function formatTranscript(t: { base: string; recording: string; text: string; consent?: ConsentRecord; model: string; now: Date }): string {
  const consentLine = t.consent
    ? `Operator confirmed all parties consented at ${t.consent.consentConfirmedAt}`
    : "Not recorded by this tool; consent unknown";
  return [
    `# Call transcript: ${t.consent?.label ?? t.base}`,
    "",
    `- Recording: \`${basename(t.recording)}\``,
    `- Consent: ${consentLine}`,
    `- Transcribed: ${t.now.toISOString()} with whisper.cpp (${t.model}), on this machine`,
    "- Speakers are not separated; both sides are in one stream.",
    "",
    "## Transcript",
    "",
    t.text || "_(no speech detected)_",
    "",
  ].join("\n");
}

export interface CallEntry {
  readonly recording: string;
  readonly transcript?: string;
}

export async function listCalls(c: CallsConfig): Promise<CallEntry[]> {
  let names: string[];
  try {
    names = await readdir(recordingsDir(c));
  } catch {
    return [];
  }
  return names
    .filter((n) => AUDIO_EXTENSIONS.has(extname(n).toLowerCase()))
    .sort()
    .map((n) => {
      const recording = join(recordingsDir(c), n);
      const transcript = transcriptPathFor(c, recording);
      return existsSync(transcript) ? { recording, transcript } : { recording };
    });
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Audio device names from `ffmpeg -f avfoundation -list_devices true -i ""` (printed on stderr). */
export function parseAvfoundationAudioDevices(output: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.includes("AVFoundation audio devices"));
  if (start < 0) return [];
  const devices: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /\]\s*\[(\d+)\]\s*(.+?)\s*$/.exec(line);
    if (!match) break;
    devices.push(match[2]);
  }
  return devices;
}

export function runDoctor(c: CallsConfig, runner: ProcessRunner, platform: NodeJS.Platform = process.platform): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "macOS", ok: platform === "darwin", detail: platform === "darwin" ? "running on macOS" : `running on ${platform}; recording needs the Mac that relays your iPhone calls` });

  const ffmpeg = runner.run(c.ffmpegBin, ["-hide_banner", "-version"]);
  const ffmpegOk = !ffmpeg.error && ffmpeg.status === 0;
  checks.push({ name: "ffmpeg", ok: ffmpegOk, detail: ffmpegOk ? ffmpeg.stdout.split("\n")[0] : `${c.ffmpegBin} not found. Install with: brew install ffmpeg` });

  if (ffmpegOk && platform === "darwin") {
    const list = runner.run(c.ffmpegBin, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    const devices = parseAvfoundationAudioDevices(`${list.stdout}\n${list.stderr}`);
    const found = devices.includes(c.device);
    checks.push({
      name: "audio device",
      ok: found,
      detail: found
        ? `"${c.device}" found`
        : `"${c.device}" not found. Available: ${devices.length ? devices.map((d) => `"${d}"`).join(", ") : "none"}. Create it in Audio MIDI Setup or set CALLS_AUDIO_DEVICE.`,
    });
  }

  const whisper = runner.run(c.whisperBin, ["--help"]);
  const whisperOk = !whisper.error;
  checks.push({ name: "whisper.cpp", ok: whisperOk, detail: whisperOk ? `${c.whisperBin} found` : `${c.whisperBin} not found. Install with: brew install whisper-cpp (or set WHISPER_BIN)` });

  const modelOk = !!c.whisperModel && existsSync(c.whisperModel);
  checks.push({ name: "whisper model", ok: modelOk, detail: modelOk ? c.whisperModel! : c.whisperModel ? `file not found: ${c.whisperModel}` : "WHISPER_MODEL is not set" });

  return checks;
}
