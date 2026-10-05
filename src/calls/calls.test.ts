import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAvfoundationAudioDevices, recordingBaseName, type CommandResult, type ProcessRunner } from "./calls";
import { runCallsCommand } from "../cli/calls-commands";

const NOW = new Date(2026, 9, 5, 14, 32, 7);

/** Fakes ffmpeg and whisper-cli by writing the files the real tools would. */
function fakeRunner(opts: { recordBytes?: number; transcript?: string; missing?: string[] } = {}) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: ProcessRunner = {
    run(command, args): CommandResult {
      calls.push({ command, args });
      if (opts.missing?.includes(command)) return { status: null, stdout: "", stderr: "", error: "spawn ENOENT" };
      if (args.includes("-list_devices")) {
        return { status: 1, stdout: "", stderr: [
          "[AVFoundation indev @ 0x1] AVFoundation video devices:",
          "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
          "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
          "[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone",
          "[AVFoundation indev @ 0x1] [1] Call Capture",
          "Error opening input file .",
        ].join("\n") };
      }
      if (command === "ffmpeg" && args.includes("-y")) {
        return writeSync(args[args.length - 1], "RIFF");
      }
      if (command === "whisper-cli" && args.includes("-otxt")) {
        const base = args[args.indexOf("-of") + 1];
        return writeSync(`${base}.txt`, opts.transcript ?? " Hi, this is the dentist's office.\n");
      }
      return { status: 0, stdout: "ffmpeg version 7.1\n", stderr: "" };
    },
    async runInteractive(command, args) {
      calls.push({ command, args });
      await writeFile(args[args.length - 1], Buffer.alloc(opts.recordBytes ?? 32_000));
      return 255;
    },
  };
  return { runner, calls };
}

function writeSync(path: string, content: string): CommandResult {
  writeFileSync(path, content);
  return { status: 0, stdout: "", stderr: "" };
}

async function setup(env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "calls-"));
  const model = join(cwd, "ggml-base.en.bin");
  await writeFile(model, "model");
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    out,
    err,
    deps: (runner: ProcessRunner) => ({
      cwd,
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
      env: { WHISPER_MODEL: model, ...env },
      runner,
      now: () => NOW,
      platform: "darwin" as NodeJS.Platform,
    }),
  };
}

test("recordingBaseName is sortable local time plus a filename-safe label", () => {
  assert.equal(recordingBaseName(NOW), "2026-10-05_143207");
  assert.equal(recordingBaseName(NOW, "Dr. Smith's office!"), "2026-10-05_143207_dr-smith-s-office");
});

test("record refuses without --consent and never starts ffmpeg", async () => {
  const s = await setup();
  const { runner, calls } = fakeRunner();
  const code = await runCallsCommand(["record"], s.deps(runner));
  assert.equal(code, 1);
  assert.match(s.err.join("\n"), /--consent is required/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(s.cwd, ".orchestrator", "calls")), false);
});

test("record --consent records the capture device, writes a consent sidecar, then transcribes", async () => {
  const s = await setup();
  const { runner, calls } = fakeRunner();
  const code = await runCallsCommand(["record", "--consent", "--label", "Dentist"], s.deps(runner));
  assert.equal(code, 0, s.err.join("\n"));

  const record = calls[0];
  assert.equal(record.command, "ffmpeg");
  assert.deepEqual(record.args.slice(3, 7), ["-f", "avfoundation", "-i", ":Call Capture"]);

  const dir = join(s.cwd, ".orchestrator", "calls");
  const consent = JSON.parse(await readFile(join(dir, "recordings", "2026-10-05_143207_dentist.json"), "utf-8"));
  assert.equal(consent.label, "Dentist");
  assert.equal(consent.consentConfirmedAt, NOW.toISOString());

  const transcript = await readFile(join(dir, "transcripts", "2026-10-05_143207_dentist.md"), "utf-8");
  assert.match(transcript, /^# Call transcript: Dentist/);
  assert.match(transcript, /Operator confirmed all parties consented/);
  assert.match(transcript, /Hi, this is the dentist's office\./);

  // Working files are cleaned up; only the transcript remains.
  assert.deepEqual(await readdir(join(dir, "transcripts")), ["2026-10-05_143207_dentist.md"]);
});

test("record reports failure when ffmpeg wrote no audio", async () => {
  const s = await setup();
  const { runner } = fakeRunner({ recordBytes: 0 });
  const code = await runCallsCommand(["record", "--consent", "--no-transcribe"], s.deps(runner));
  assert.equal(code, 1);
  assert.match(s.err.join("\n"), /no audio was recorded/);
});

test("transcribe fails clearly when WHISPER_MODEL is unset", async () => {
  const s = await setup({ WHISPER_MODEL: "" });
  const { runner } = fakeRunner();
  const audio = join(s.cwd, "call.m4a");
  await writeFile(audio, "audio");
  const code = await runCallsCommand(["transcribe", audio], s.deps(runner));
  assert.equal(code, 1);
  assert.match(s.err.join("\n"), /WHISPER_MODEL is not set/);
});

test("transcribe --pending handles only recordings without a transcript, and marks imported files' consent unknown", async () => {
  const s = await setup();
  const { runner } = fakeRunner();
  const recordings = join(s.cwd, ".orchestrator", "calls", "recordings");
  const transcripts = join(s.cwd, ".orchestrator", "calls", "transcripts");
  await mkdir(recordings, { recursive: true });
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(recordings, "done.wav"), "x");
  await writeFile(join(transcripts, "done.md"), "existing");
  await writeFile(join(recordings, "imported.m4a"), "x");
  await writeFile(join(recordings, "notes.txt"), "not audio");

  const code = await runCallsCommand(["transcribe", "--pending"], s.deps(runner));
  assert.equal(code, 0, s.err.join("\n"));
  assert.equal(await readFile(join(transcripts, "done.md"), "utf-8"), "existing");
  assert.match(await readFile(join(transcripts, "imported.md"), "utf-8"), /consent unknown/);
});

test("doctor reports each missing piece with how to fix it", async () => {
  const s = await setup({ CALLS_AUDIO_DEVICE: "Missing Device" });
  const { runner } = fakeRunner({ missing: ["whisper-cli"] });
  const code = await runCallsCommand(["doctor"], s.deps(runner));
  assert.equal(code, 1);
  const out = s.out.join("\n");
  assert.match(out, /FAIL  audio device: "Missing Device" not found\. Available: "MacBook Pro Microphone", "Call Capture"/);
  assert.match(out, /FAIL  whisper\.cpp: whisper-cli not found\. Install with: brew install whisper-cpp/);
  assert.match(out, /ok    whisper model/);
});

test("doctor passes when everything is in place", async () => {
  const s = await setup();
  const { runner } = fakeRunner();
  assert.equal(await runCallsCommand(["doctor"], s.deps(runner)), 0);
  assert.match(s.out.join("\n"), /Ready to record\./);
});

test("parseAvfoundationAudioDevices ignores video devices", () => {
  const output = [
    "[AVFoundation indev @ 0x1] AVFoundation video devices:",
    "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
    "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
    "[AVFoundation indev @ 0x1] [0] BlackHole 2ch",
    "[AVFoundation indev @ 0x1] [1] Call Capture",
    ": Input/output error",
  ].join("\n");
  assert.deepEqual(parseAvfoundationAudioDevices(output), ["BlackHole 2ch", "Call Capture"]);
});
