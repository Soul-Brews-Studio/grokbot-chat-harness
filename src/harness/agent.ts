/**
 * The loop.
 *
 * Per turn: project the log into messages, call the model, append whatever comes
 * back, run any tool calls, append their results, repeat. Stop when the model
 * returns no tool calls, or the step budget runs out.
 *
 * Nothing here mutates history. Every step is an append, which is what makes
 * compaction non-destructive.
 */
import { EventLog } from "./events.ts";
import { GROK_TOOLS, closeGateway, type Tool } from "./tools.ts";
import { chat } from "./llm.ts";

export const DEFAULT_TOOLS: Tool[] = GROK_TOOLS;

export type RunOpts = {
  model: string;
  maxSteps?: number;
  compactAfter?: number;
  /** cheap model for summaries; falls back to a mechanical summary if unset */
  smol?: string;
  tools?: Tool[];
  onEvent?: (kind: string, detail: string) => void;
};

const SYSTEM = `You drive a set of Grok Bot agents running on a remote box. Each is a
separate assistant with its own conversation and its own memory of what it has been
told; some can search the live web.

How to work:
- Start with grok_ls. Agent ids are not guessable and the roster changes.
- Pick the agent that fits. Only harness=temporal agents can search the web. Prefer an
  agent whose existing conversation is already about the topic — grok_find shows you
  which one that is, without spending a question.
- Ask one self-contained question per grok_ask, and say what form the answer must take.
  The bot cannot see this conversation, only what you send it.
- A temporal agent doing a live search is silent for minutes. That is normal. Do not
  re-ask; the tool waits.
- Quote what a bot actually said. If it did not answer the question, say so rather than
  filling the gap yourself.

When the task is done, reply with the answer in plain text and no tool calls.`;

export async function run(log: EventLog, task: string, opts: RunOpts) {
  const {
    model,
    maxSteps = 12,
    compactAfter = 40,
    smol,
    tools = DEFAULT_TOOLS,
    onEvent = () => {},
  } = opts;

  const byName = new Map(tools.map((t) => [t.name, t]));
  log.append({ t: "user", text: task });

  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (log.all().length > compactAfter) await compact(log, smol, onEvent);

      const messages = log.deriveMessages(SYSTEM);
      const reply = await chat(model, messages, tools);

      if (reply.text.trim()) {
        log.append({ t: "assistant", text: reply.text });
        onEvent("say", reply.text);
      }

      if (reply.toolCalls.length === 0) {
        onEvent("done", `finished in ${step} step(s)`);
        return reply.text;
      }

      for (const call of reply.toolCalls) {
        log.append({ t: "tool_call", id: call.id, name: call.name, args: call.args });
        onEvent("call", `${call.name} ${JSON.stringify(call.args).slice(0, 160)}`);

        const tool = byName.get(call.name);
        let result: string;
        try {
          result = tool ? await tool.run(call.args) : `no such tool: ${call.name}`;
        } catch (e: any) {
          // Errors go back as results, not thrown. A model recovers from a failed
          // call far more often than a crashed process does.
          result = `error: ${e.message}`;
        }
        log.append({ t: "tool_result", id: call.id, name: call.name, result });
        onEvent("result", result.slice(0, 300));
      }
    }

    onEvent("done", `step budget (${maxSteps}) exhausted`);
    return null;
  } finally {
    closeGateway();
  }
}

/**
 * Mark a compaction point.
 *
 * A `smol` model writes the summary when configured — cheap, quality-tolerant work
 * worth giving a second model. If it is missing or fails we fall back to a mechanical
 * summary, because a failed summariser must not take down the run. Either way every
 * original event stays in the log.
 */
async function compact(
  log: EventLog,
  smol: string | undefined,
  onEvent: (k: string, d: string) => void,
) {
  const events = log.all();
  const upto = Math.floor(events.length / 2);
  const touched = new Set<string>();
  for (const e of events.slice(0, upto + 1)) if (e.t === "tool_call") touched.add(e.name);

  const mechanical =
    `${upto + 1} earlier events omitted from this view. ` +
    `Tools used so far: ${[...touched].join(", ") || "none"}. ` +
    `Full history remains in the event log.`;

  let summary = mechanical;
  if (smol) {
    const transcript = events
      .slice(0, upto + 1)
      .map((e) =>
        e.t === "user" || e.t === "assistant"
          ? `${e.t}: ${e.text.slice(0, 400)}`
          : e.t === "tool_call"
            ? `tool ${e.name}(${JSON.stringify(e.args).slice(0, 160)})`
            : e.t === "tool_result"
              ? `-> ${e.result.slice(0, 200)}`
              : "",
      )
      .filter(Boolean)
      .join("\n");
    try {
      const r = await chat(
        smol,
        [
          {
            role: "system",
            content:
              "Summarise this agent transcript for the agent's own future reference. " +
              "State which bots were asked, what they answered, what failed, and any id " +
              "or fact it will need later. Under 150 words, plain prose, no preamble.",
          },
          { role: "user", content: transcript },
        ],
        [],
      );
      if (r.text.trim()) summary = r.text.trim();
    } catch (e: any) {
      onEvent("compact", `smol summariser failed (${e.message.slice(0, 60)}); using mechanical`);
    }
  }

  log.append({ t: "compact", upto, summary });
  onEvent("compact", summary.slice(0, 200));
}
