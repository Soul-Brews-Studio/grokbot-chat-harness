#!/usr/bin/env bun
/**
 * grok-harness — give an agent a task, let it drive the Grok bots.
 *
 *   bun run tools/harness/cli.ts "which bot knows about NetBird, and what did it say?"
 *   bun run tools/harness/cli.ts --model glm:glm-5.3 --session jev "..."
 *
 * Flags:
 *   --model   provider:model for the loop        (default glm:glm-5.3)
 *   --smol    cheap model for compaction summaries
 *   --session name of the event log under sessions/  (default: today + time)
 *   --steps   step budget                         (default 12)
 *   --quiet   print only the final answer
 *
 * The log at sessions/<name>.jsonl is append-only and resumable: run again with the
 * same --session and the agent continues with its history intact.
 */
import { EventLog } from "./events.ts";
import { run } from "./agent.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Everything that is not a flag or a flag's value is the task. */
const VALUED = new Set(["--model", "--smol", "--session", "--steps"]);
const task: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUED.has(a)) {
    i++;
    continue;
  }
  if (a.startsWith("--")) continue;
  if (a.trim()) task.push(a);   // `just harness` with no args passes "" — not a task
}

/** No task on the command line: ask for one if a human is there, print usage if
 *  not. A bare `just harness` is a person wanting to type a task, not an error. */
if (!task.join(" ").trim()) {
  if (process.stdin.isTTY) {
    process.stderr.write(
      "what should the agent do? (it picks which bot itself)\ntask ❯ ",
    );
    const typed = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d: string) => {
        buf += d;
        if (buf.includes("\n")) {
          process.stdin.pause();
          resolve(buf.split("\n")[0]);
        }
      });
    });
    if (!typed.trim()) {
      process.stderr.write("nothing to do\n");
      process.exit(0);
    }
    task.push(typed.trim());
  } else {
    console.error(
      'usage: bun run tools/harness/cli.ts [--model M] [--session S] [--steps N] "<task>"\n' +
        "\nThe task is what you want done, not which bot to use — the agent picks.\n" +
        'e.g. "which bot already knows about NetBird, and what did it conclude?"',
    );
    process.exit(2);
  }
}

const quiet = process.argv.includes("--quiet");
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})/, "$1-");
const session = flag("session", stamp)!;
const logPath = join(HERE, "sessions", `${session}.jsonl`);
const log = new EventLog(logPath);

const icon: Record<string, string> = {
  say: "  ",
  call: "→ ",
  result: "← ",
  compact: "⊙ ",
  done: "✓ ",
};

const answer = await run(log, task.join(" "), {
  model: flag("model", "glm:glm-5.3")!,
  smol: flag("smol"),
  maxSteps: Number(flag("steps", "12")),
  onEvent: (kind, detail) => {
    if (quiet) return;
    if (kind === "result") detail = detail.replace(/\n/g, "\n    ");
    console.error(`${icon[kind] ?? "  "}${detail}`);
  },
});

if (answer) console.log(answer);
if (!quiet) console.error(`\nlog: ${logPath} (${log.all().length} events)`);
process.exit(answer ? 0 : 1);
