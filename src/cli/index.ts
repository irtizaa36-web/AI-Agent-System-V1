import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createTask } from "../core/task";
import { runToCompletion } from "../core/orchestrator";
import { applyConstraints } from "../core/apply-constraints";
import { loadDefaultConfig, createDefaultInkboxClient } from "../config/load";
import { JsonFileRunStore } from "../store/run-store";
import { JsonFileWorkflowStore } from "../store/workflow-store";
import { JsonFileConstraintsStore, formatConstraintsForPrompt, type ConstraintsStore } from "../store/constraints-store";
import { JsonFileForwardingLog } from "../integrations/inkbox/forwarding-log";
import { JsonFileMessageEventLog } from "../integrations/inkbox/message-event-log";
import { JsonFileDraftStore } from "../integrations/inkbox/draft-store";
import { runInkboxCommand } from "./inkbox-commands";
import { runBrowserCommand } from "./browser-commands";
import { runDispatchCommand } from "./dispatch-commands";
import { runCoworkerCommand } from "./coworker-commands";
import { JsonFileCoworkerTaskStore } from "../coworker/store";
import { runAgentStatusCommand } from "./agent-status-commands";
import { JsonFileAgentStatusStore } from "../dashboard/agent-status-store";
import { runRecommendCommand } from "./recommend-commands";
import { JsonFileRecommendationStore } from "../dashboard/recommendation-store";
import { runOperationalUpdateCommand } from "./operational-update-commands";
import { JsonFileOperationalUpdateStore, type OperationalUpdateStore } from "../dashboard/operational-update-store";
import { runDashboardCommand } from "./dashboard-command";
import { runJobsCommand } from "./jobs-commands";
import { runSleeperCommand } from "./sleeper-commands";
import { JsonFilePickemStore } from "../sleeper/pickem/store";
import { JsonFilePlayersCache, createRealSleeperClient } from "../integrations/sleeper/real-client";
import { createSleeperWriteClientFromEnv } from "../integrations/sleeper/graphql-client";
import type { SleeperDeps } from "../config/load";
import { runSettlementsCommand } from "./settlements-commands";
import { runMarketplaceCommandFromCwd } from "./marketplace-commands";
import { runXCommand } from "./x-commands";
import { runWatchBriefsCommand } from "./watch-briefs-commands";
import { createSettlementsDeps, type SettlementsDeps } from "../settlements/deps";
import { JsonFileTrackerStorage } from "../settlements/storage";
import { runVoiceCommand } from "./voice-commands";
import { runCallsCommand } from "./calls-commands";
import { createDefaultVoiceDeps, type VoiceDeps } from "../voice/deps";
import type { Registry } from "../registry/registry";
import type { RunStore } from "../store/run-store";
import type { WorkflowStore } from "../store/workflow-store";
import type { InkboxClient } from "../integrations/inkbox/client";
import type { ForwardingLog } from "../integrations/inkbox/forwarding-log";
import type { MessageEventLog } from "../integrations/inkbox/message-event-log";
import type { CoworkerTaskStore } from "../coworker/store";
import type { AgentStatusStore } from "../dashboard/agent-status-store";
import type { RecommendationStore } from "../dashboard/recommendation-store";

export interface CliDeps {
  readonly registry: Registry;
  readonly store: RunStore;
  /** Persists Workflow records for `orchestrator dispatch` (ADR 0008) — separate from RunStore, since a Workflow chains multiple Runs together. */
  readonly workflowStore: WorkflowStore;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Working directory `status` checks Git/build state against. Defaults to process.cwd() in `main`. */
  readonly cwd: string;
  /** The Inkbox client `inkbox` subcommands operate on directly — the same instance wired into the Registry's tools. */
  readonly inkboxClient: InkboxClient;
  /** Tracks which inbound messages have already been forwarded to the owner, so `inkbox check-replies` never double-forwards. */
  readonly forwardingLog: ForwardingLog;
  /** Records sent/delivered/bounced/failed/forwarded-confirmation outcomes reported by Inkbox webhook events. */
  readonly messageEventLog: MessageEventLog;
  /** The shared coworker task list (`orchestrator coworker ...`) — meant to be committed to Git so both personas' machines see it. */
  readonly coworkerStore: CoworkerTaskStore;
  /** Each agent's latest self-reported status (`orchestrator agent-status ...`), read by the dashboard. */
  readonly agentStatusStore: AgentStatusStore;
  /** The dashboard's own "noticed / did" feed (`orchestrator recommend ...`). */
  readonly recommendationStore: RecommendationStore;
  readonly operationalUpdateStore?: OperationalUpdateStore;
  /** Accumulated corrections (see store/constraints-store.ts), prepended to every `run` command's Agent automatically. Optional so existing callers/tests keep working without one. */
  readonly constraintsStore?: ConstraintsStore;
  /** Sleeper read/write clients and the pick'em log for `orchestrator sleeper ...` (ADR 0021) — the same instances the Registry's Sleeper tools use. */
  readonly sleeper?: SleeperDeps;
  /** The settlement tracker and research sources for `orchestrator settlements ...` (ADR 0022) — the same instance the Registry's settlements tools use. */
  readonly settlements?: SettlementsDeps;
  /** The Google Voice code broker and reply drafter for `orchestrator voice ...` (ADR 0023). Every switch is off unless set to "true". */
  readonly voice?: VoiceDeps;
}

function printUsage(stdout: (line: string) => void): void {
  stdout(
    [
      "Usage:",
      '  orchestrator run --task "<instructions>" [--agent <name>]   Run a task through an agent',
      "  orchestrator list-agents                                    List configured agents",
      "  orchestrator status                                         Show a snapshot of the project",
      "  orchestrator inkbox <subcommand>                            Draft-review-approve email flow (see below)",
      "  orchestrator browser login <site> <url>                     One-time human login, saves an authenticated session",
      "  orchestrator browser health <site> <url>                    Read-only load + blocked-vs-quiet check; exits 1 unless ok/empty",
      '  orchestrator dispatch run --task "<goal>"                   State a goal in plain English; the Dispatcher plans and runs it',
      "  orchestrator dispatch status|approve|resume <id>            Check on, approve, or resume a paused workflow",
      '  orchestrator coworker add "<task>" --to <persona>           Add a task to the shared coworker list',
      "  orchestrator coworker list|dispatched|undispatch|complete|update Inspect or update the shared coworker task list",
      "  orchestrator agent-status set <name> --status <s> [--task]  An agent reports its own current status",
      "  orchestrator agent-status list                              List the latest self-reported statuses",
      '  orchestrator recommend add "<summary>" --scope <s>          Log something the dashboard noticed',
      "  orchestrator recommend implemented <id> [--details]        Record that a recommendation was acted on",
      "  orchestrator recommend list                                 List logged recommendations",
      '  orchestrator operational-update add "<summary>" --by <a> --provenance <p> Log a concise operational handoff',
      "  orchestrator operational-update list                         List operational handoffs",
      "  orchestrator dashboard [--port N]                           Serve the local agents/projects dashboard",
      "  orchestrator jobs run                                       Run the job-search pipeline and write today's digest",
      "  orchestrator jobs digest|sources|costs                      Read the last digest, check sources, or review model spend",
      "  orchestrator sleeper leagues|preview|waivers <username>     Read-only Sleeper fantasy monitoring",
      "  orchestrator sleeper write --action <file> [--confirm]      Dry-run (default) or send one Sleeper league change",
      "  orchestrator sleeper pickem research|slip|log|settle|bankroll Pick'em research and bankroll; you place every entry",
      "  orchestrator settlements deadlines|alerts|review|research   Settlement claims: deadlines, nudges, eligibility, new-settlement research",
      "  orchestrator settlements add|status|verdict|action|...      Record what you did; you file every claim yourself (settlements help)",
      "  orchestrator voice status|ingest|alerts|drafts|approve|send  Google Voice: matched verification codes, gated SMS replies (voice help)",
      "  orchestrator calls doctor|record|transcribe|list            Record iPhone calls on this Mac, transcribe locally (calls help)",
      "  orchestrator marketplace selling|buying|channels ...       FB Marketplace selling agent: queues, hunts, outbox (marketplace selling help)",
      "  orchestrator x search-sweep                                 Standing X search-intel sweep, with session health-check and fallback (ADR 0025)",
      "  orchestrator watch-briefs poll                              One poll for new orchestrator briefs on claude/* branches (ADR 0027)",
      "  orchestrator watch-briefs loop [--interval-ms N]            Repeat that poll every N ms (default ~3 min)",
      '  orchestrator constraints add "<text>"                       Record a correction, applied to every future run',
      "  orchestrator constraints list                                List recorded corrections",
      "  orchestrator help                                           Show this message",
      "",
      "inkbox subcommands: draft, review-draft, prepare-send, approve-send, check-replies, review-offer, " +
        "serve-webhook, webhook-health",
      "",
      'Try it with no API key: orchestrator run --task "say hello" --agent demo',
    ].join("\n"),
  );
}

/** Pulls the pass/fail summary out of `node --test`'s own report. Pure — no I/O — so it's testable without a real test run. */
export function parseTestSummary(output: string): string | undefined {
  const total = output.match(/^ℹ tests (\d+)$/m)?.[1];
  const pass = output.match(/^ℹ pass (\d+)$/m)?.[1];
  const fail = output.match(/^ℹ fail (\d+)$/m)?.[1];
  if (!total || !pass || !fail) return undefined;
  return fail === "0" ? `${pass}/${total} passing` : `${pass}/${total} passing, ${fail} failing`;
}

const RECURSION_GUARD_ENV_VAR = "ORCHESTRATOR_STATUS_CHECK_IN_PROGRESS";

/**
 * Best-effort: actually runs the compiled test suite if it's been built,
 * rather than guessing. That nested run includes this very test file, whose
 * own status test would otherwise try to spawn another nested run in turn —
 * an env var guard caps this at exactly one real level of recursion.
 */
export function getTestStatus(cwd: string): string {
  const distDir = join(cwd, "dist");
  if (!existsSync(distDir)) {
    return "not built yet (run `npm run build` or `npm test`)";
  }

  if (process.env[RECURSION_GUARD_ENV_VAR] === "1") {
    return "skipped (already inside a status check)";
  }

  const result = spawnSync(process.execPath, ["--test", distDir], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, [RECURSION_GUARD_ENV_VAR]: "1" },
  });
  const summary = parseTestSummary(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return summary ?? "unable to determine (run `npm test` manually)";
}

/** Best-effort: reports whether the Git working tree has uncommitted changes. */
export function getGitStatus(cwd: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    return "unknown (not a Git repository, or git is unavailable)";
  }
  const changedFiles = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  return changedFiles.length === 0 ? "clean" : `${changedFiles.length} file(s) with uncommitted changes`;
}

function statusCommand(deps: CliDeps): number {
  const agents = deps.registry.listAgents();
  const providers = deps.registry.listProviders();
  const tools = deps.registry.listTools();
  const packs = deps.registry.listPacks();

  deps.stdout("AI-Agent-System status");
  deps.stdout("-----------------------");
  deps.stdout(`Agents:    ${agents.length} (${agents.map((a) => a.name).join(", ") || "none"})`);
  deps.stdout(`Providers: ${providers.length} (${providers.map((p) => p.name).join(", ") || "none"})`);
  deps.stdout(`Tools:     ${tools.length} (${tools.map((t) => t.name).join(", ") || "none"})`);
  deps.stdout(`Packs:     ${packs.length} (${packs.join(", ") || "none"})`);
  deps.stdout(`Tests:     ${getTestStatus(deps.cwd)}`);
  deps.stdout(`Git:       ${getGitStatus(deps.cwd)}`);
  deps.stdout("");
  deps.stdout("Capabilities currently available:");
  for (const agent of agents) {
    deps.stdout(
      `  - Run "${agent.name}" (provider: ${agent.providerName}, tools: ${agent.toolNames.join(", ") || "none"})`,
    );
  }

  return 0;
}

async function runTaskCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  let taskText: string | undefined;
  let agentName: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { task: { type: "string" }, agent: { type: "string" } },
      allowPositionals: true,
    });
    taskText = parsed.values.task ?? parsed.positionals[0];
    agentName = parsed.values.agent;
  } catch (error) {
    deps.stderr(`Invalid arguments: ${(error as Error).message}`);
    return 1;
  }

  if (!taskText) {
    deps.stderr('Usage: orchestrator run --task "<instructions>" [--agent <name>]');
    return 1;
  }

  let agent;
  try {
    agent = deps.registry.getAgent(agentName ?? "default");
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }

  const provider = deps.registry.getProvider(agent.providerName);
  const tools = deps.registry.toolMapFor(agent.toolNames);
  const task = createTask(taskText);

  // Corrections recorded via `orchestrator constraints add` (CONSTRAINTS.md,
  // in code): loaded once per run and prepended to the agent's system
  // prompt, so a past mistake never has to be re-discovered — and re-paid
  // for — on a future run.
  const constraints = deps.constraintsStore ? await deps.constraintsStore.list() : [];
  const effectiveAgent = applyConstraints(agent, formatConstraintsForPrompt(constraints));

  deps.stdout(`Running task "${task.instructions}" with agent "${agent.name}" (provider: ${agent.providerName})...`);

  try {
    const run = await runToCompletion(task, effectiveAgent, { provider, tools });
    await deps.store.save(run);

    if (run.status === "succeeded") {
      deps.stdout(`\nResult (run ${run.id}, ${run.steps.length} step(s)):\n${run.result?.output ?? ""}`);
      return 0;
    }

    deps.stderr(`\nRun ${run.id} failed: ${run.result?.error ?? "unknown error"}`);
    return 1;
  } catch (error) {
    deps.stderr(`\nRun failed: ${(error as Error).message}`);
    return 1;
  }
}

/** `orchestrator constraints add "<text>"` records a correction; `list` shows everything recorded so far. Requires deps.constraintsStore. */
async function runConstraintsCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  if (!deps.constraintsStore) {
    deps.stderr("Constraints are not configured for this CLI invocation.");
    return 1;
  }

  const [subcommand, ...rest] = args;

  if (subcommand === "add") {
    const text = rest.join(" ").trim();
    if (!text) {
      deps.stderr('Usage: orchestrator constraints add "<correction text>"');
      return 1;
    }
    const constraint = await deps.constraintsStore.add(text);
    deps.stdout(`Recorded constraint ${constraint.id}: ${constraint.text}`);
    return 0;
  }

  if (subcommand === "list") {
    const constraints = await deps.constraintsStore.list();
    if (constraints.length === 0) {
      deps.stdout("No constraints recorded yet.");
      return 0;
    }
    for (const c of constraints) {
      deps.stdout(`${c.recordedAt.slice(0, 10)}  ${c.text}`);
    }
    return 0;
  }

  deps.stderr('Usage: orchestrator constraints add "<text>" | orchestrator constraints list');
  return 1;
}

/**
 * The CLI's actual logic, kept separate from process.argv/process.exit so it
 * can be tested directly with injected dependencies. `main` below is the
 * only part of this file that touches the real process.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help") {
    printUsage(deps.stdout);
    return 0;
  }

  if (command === "list-agents") {
    for (const agent of deps.registry.listAgents()) {
      deps.stdout(`${agent.name}\t(provider: ${agent.providerName}, model: ${agent.model})`);
    }
    return 0;
  }

  if (command === "run") {
    return runTaskCommand(rest, deps);
  }

  if (command === "status") {
    return statusCommand(deps);
  }

  if (command === "inkbox") {
    return runInkboxCommand(rest, deps);
  }

  if (command === "browser") {
    return runBrowserCommand(rest, deps);
  }

  if (command === "dispatch") {
    return runDispatchCommand(rest, deps);
  }

  if (command === "coworker") {
    return runCoworkerCommand(rest, deps);
  }

  if (command === "agent-status") {
    return runAgentStatusCommand(rest, deps);
  }

  if (command === "recommend") {
    return runRecommendCommand(rest, deps);
  }
  if (command === "operational-update") {
    return runOperationalUpdateCommand(rest, deps);
  }

  if (command === "dashboard") {
    return runDashboardCommand(rest, deps);
  }

  if (command === "constraints") {
    return runConstraintsCommand(rest, deps);
  }

  if (command === "jobs") {
    return runJobsCommand(rest, deps);
  }

  if (command === "sleeper") {
    return runSleeperCommand(rest, deps);
  }

  if (command === "settlements") {
    return runSettlementsCommand(rest, deps);
  }

  if (command === "voice") {
    return runVoiceCommand(rest, deps);
  }

  if (command === "calls") {
    return runCallsCommand(rest, deps);
  }

  if (command === "marketplace") {
    return runMarketplaceCommandFromCwd(rest, deps);
  }

  if (command === "x") {
    return runXCommand(rest, deps);
  }

  if (command === "watch-briefs") {
    return runWatchBriefsCommand(rest, deps);
  }

  deps.stderr(`Unknown command "${command}". Run "orchestrator help" for usage.`);
  return 1;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const inkboxClient = createDefaultInkboxClient(new JsonFileDraftStore(join(cwd, ".orchestrator", "inkbox-drafts")));
  const sleeper: SleeperDeps = {
    readClient: createRealSleeperClient({ playersCache: new JsonFilePlayersCache(join(cwd, ".orchestrator", "sleeper", "players-nfl.json")) }),
    writeClient: createSleeperWriteClientFromEnv(),
    pickemStore: new JsonFilePickemStore(join(cwd, ".orchestrator", "sleeper", "pickem.json")),
  };
  const settlements = createSettlementsDeps({ storage: new JsonFileTrackerStorage(join(cwd, ".orchestrator", "settlements", "tracker.json")) });
  const registry = loadDefaultConfig(inkboxClient, undefined, undefined, undefined, undefined, undefined, sleeper, { settlements });
  const store = new JsonFileRunStore(join(cwd, ".orchestrator", "runs"));
  const workflowStore = new JsonFileWorkflowStore(join(cwd, ".orchestrator", "workflows"));
  const coworkerStore = new JsonFileCoworkerTaskStore(join(cwd, "coworker", "tasks"));
  const agentStatusStore = new JsonFileAgentStatusStore(join(cwd, "coworker", "agents"));
  const recommendationStore = new JsonFileRecommendationStore(join(cwd, "coworker", "recommendations"));
  const operationalUpdateStore = new JsonFileOperationalUpdateStore(join(cwd, "coworker", "operational-updates"));
  const constraintsStore = new JsonFileConstraintsStore(join(cwd, ".orchestrator", "constraints.json"));

  const exitCode = await runCli(process.argv.slice(2), {
    registry,
    store,
    workflowStore,
    cwd,
    inkboxClient,
    forwardingLog: new JsonFileForwardingLog(join(cwd, ".orchestrator", "inkbox-forwarding")),
    messageEventLog: new JsonFileMessageEventLog(join(cwd, ".orchestrator", "inkbox-events")),
    coworkerStore,
    agentStatusStore,
    recommendationStore,
    operationalUpdateStore,
    constraintsStore,
    sleeper,
    settlements,
    voice: createDefaultVoiceDeps(cwd),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });

  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}
