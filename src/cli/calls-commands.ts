import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  callsConfigFromEnv,
  listCalls,
  realProcessRunner,
  recordCall,
  runDoctor,
  transcribeRecording,
  type CallsConfig,
  type ProcessRunner,
} from "../calls/calls";

/**
 * `orchestrator calls ...` (ADR 0030): record iPhone calls relayed to the Mac
 * and transcribe them locally with whisper.cpp. Recordings and transcripts
 * stay in the gitignored `.orchestrator/calls/`.
 */

export interface CallsDeps {
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: ProcessRunner;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

const USAGE = [
  "Usage: orchestrator calls <subcommand>",
  "  doctor                                         Check ffmpeg, whisper.cpp, the model and the capture device",
  "  record --consent [--label <name>] [--device <name>] [--no-transcribe]",
  "                                                 Record until Ctrl+C, then transcribe",
  "  transcribe <audio-file> | --pending            Transcribe one file, or every recording without a transcript",
  "  list                                           List recordings and their transcripts",
  "",
  "--consent confirms you told everyone on the call it is being recorded and they agreed.",
  "Settings (environment or .env): CALLS_AUDIO_DEVICE (default \"Call Capture\"), WHISPER_MODEL (required),",
  "WHISPER_BIN (default whisper-cli), WHISPER_LANGUAGE (default auto), CALLS_FFMPEG (default ffmpeg).",
].join("\n");

const CONSENT_REFUSAL = [
  "Not recording: --consent is required.",
  "Many places (including California, Florida, Illinois and the EU) require every party to agree to a call recording,",
  "and the other person cannot tell your Mac is recording. Tell them at the start of the call; once they agree, run:",
  "  orchestrator calls record --consent",
].join("\n");

export async function runCallsCommand(args: readonly string[], deps: CallsDeps): Promise<number> {
  const [sub, ...rest] = args;
  const runner = deps.runner ?? realProcessRunner;
  const now = deps.now ?? (() => new Date());
  const config = callsConfigFromEnv(deps.cwd, deps.env ?? process.env);

  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        consent: { type: "boolean" },
        label: { type: "string" },
        device: { type: "string" },
        "no-transcribe": { type: "boolean" },
        pending: { type: "boolean" },
      },
    });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;

  switch (sub) {
    case "doctor": {
      const checks = runDoctor(config, runner, deps.platform);
      for (const check of checks) deps.stdout(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
      const ok = checks.every((c) => c.ok);
      deps.stdout(ok ? "Ready to record." : "Fix the FAIL lines above; setup steps are in docs/operations/call-transcription.md.");
      return ok ? 0 : 1;
    }

    case "record": {
      if (!values.consent) {
        deps.stderr(CONSENT_REFUSAL);
        return 1;
      }
      const recordConfig: CallsConfig = values.device ? { ...config, device: values.device } : config;
      deps.stdout(`Recording from "${recordConfig.device}". Press Ctrl+C (or q) when the call ends.`);
      const result = await recordCall(recordConfig, runner, now(), values.label);
      if (!result.ok) {
        deps.stderr(`Recording failed: ${result.error}`);
        return 1;
      }
      deps.stdout(`Saved ${result.recording}`);
      if (values["no-transcribe"]) return 0;
      return transcribeAndReport(recordConfig, runner, result.recording!, now(), deps);
    }

    case "transcribe": {
      if (values.pending) {
        const pending = (await listCalls(config)).filter((c) => !c.transcript);
        if (pending.length === 0) {
          deps.stdout("Nothing to transcribe.");
          return 0;
        }
        let failures = 0;
        for (const call of pending) failures += await transcribeAndReport(config, runner, call.recording, now(), deps);
        return failures ? 1 : 0;
      }
      if (positionals.length !== 1) {
        deps.stderr(USAGE);
        return 1;
      }
      return transcribeAndReport(config, runner, resolve(deps.cwd, positionals[0]), now(), deps);
    }

    case "list": {
      const calls = await listCalls(config);
      if (calls.length === 0) deps.stdout("No recordings yet.");
      for (const call of calls) deps.stdout(`${call.recording}\n  ${call.transcript ? `transcript: ${call.transcript}` : "not transcribed (orchestrator calls transcribe --pending)"}`);
      return 0;
    }

    default:
      (sub === undefined || sub === "help" ? deps.stdout : deps.stderr)(USAGE);
      return sub === undefined || sub === "help" ? 0 : 1;
  }
}

async function transcribeAndReport(config: CallsConfig, runner: ProcessRunner, recording: string, now: Date, deps: CallsDeps): Promise<number> {
  deps.stdout(`Transcribing ${recording} ...`);
  const result = await transcribeRecording(config, runner, recording, now);
  if (!result.ok) {
    deps.stderr(`Transcription failed: ${result.error}`);
    return 1;
  }
  deps.stdout(`Transcript: ${result.transcript}`);
  return 0;
}
