import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Usage } from "./cost";

/**
 * Scoring via the local Claude Code CLI (Toozy's Pro account). The Anthropic
 * API credit was retired 2026-10-01 and is never consulted — no key, no
 * fallback, no 400s.
 *
 * The orchestrator's ModelProvider (src/providers/) is the right seam for an
 * agent Run, but it deliberately exposes no token usage and no prompt
 * caching — both of which this pipeline needs, because it must report what
 * each run cost and must cache the stable scoring prefix across batches.
 * Rather than widen that interface for one caller, this is its own small
 * port with its own fake, following the same ports-and-adapters shape
 * (ADR 0001) and the same no-dependencies rule (ADR 0002).
 */

export interface CompletionRequest {
  readonly model: string;
  /** Cached across calls — the rubric and the candidate profile, which never vary within a run. */
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: Usage;
}

export interface ScoringClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Runs the prompt through `claude -p` (print mode, prompt on stdin) and
 * returns stdout. Usage is reported as zeros — the CLI bills Toozy's Pro
 * account directly rather than per-token here, so the cost ledger records
 * the call with no token counts.
 */
export class ClaudeCliScoringClient implements ScoringClient {
  private readonly cliPath: string;

  constructor(cliPath: string) {
    this.cliPath = cliPath;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = await runClaudeCli(this.cliPath, `${request.system}\n\n${request.user}`);
    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

function runClaudeCli(cliPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cliPath,
      ["-p", "--output-format", "text"],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ANTHROPIC_API_KEY")) },
      (error, stdout, stderr) => {
        if (error) {
          const detail = typeof stderr === "string" ? stderr : String(stderr ?? "");
          reject(new Error(`claude CLI failed: ${detail.slice(0, 300) || error.message}`));
          return;
        }
        resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** Where the CLI binary is expected to live, in priority order. */
function discoverClaudeCli(): string | undefined {
  const fromEnv = process.env["CLAUDE_CLI_PATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env["HOME"] ?? "";
  for (const candidate of [
    home ? `${home}/.local/bin/claude` : "",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The CLI client when the binary is present, otherwise undefined — never a
 * half-configured client. The retired Anthropic API is deliberately not
 * consulted: its credit is exhausted and it is not coming back.
 */
export function createScoringClientFromEnv(): ScoringClient | undefined {
  const cliPath = discoverClaudeCli();
  return cliPath ? new ClaudeCliScoringClient(cliPath) : undefined;
}

/** Scripted stand-in so the whole pipeline runs, and is tested, with no CLI and no spend. */
export class FakeScoringClient implements ScoringClient {
  public readonly requests: CompletionRequest[] = [];
  private readonly responses: readonly string[];

  constructor(responses: readonly string[]) {
    this.responses = responses;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.responses[this.requests.length - 1] ?? "[]";
    return { text, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
