/**
 * Tool interface, plus the Grok tools that are the point of this harness.
 *
 * Every Grok call rides the SAME ssh repl (tools/tui/gateway.ts) for the whole
 * run — one connection, many requests, keyed by rid. Nothing is left running on
 * the box when the process exits.
 *
 * Tool descriptions here are written for the model, not for a human reader.
 * Where a tool has a trap, the trap is in the description: the model is the one
 * choosing the arguments, so that is the only place the warning can act.
 */
import { Gateway, HOST, SENTINEL, type Event as GwEvent } from "../tui/gateway.ts";
import { redact } from "./redact.ts";

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: any): Promise<string>;
};

/** One gateway for the process; opened lazily so `--help` costs no ssh. */
let gw: Gateway | null = null;
let owned = false;
let gwStatus = "";

/** Lend the harness an already-open connection — the TUI does this so a task
 *  does not open a second ssh beside the one already streaming its transcript. */
export function setGateway(external: Gateway | null) {
  gw = external;
  owned = false;
}

function gateway(): Gateway {
  if (!gw) {
    gw = new Gateway((s) => {
      gwStatus = s;
    });
    gw.start();
    owned = true;
  }
  return gw;
}

/** Closes only what this module opened; a borrowed gateway is left alone. */
export function closeGateway() {
  if (owned) gw?.stop();
  if (owned) gw = null;
}

/** Collect one request's events, ending at `done`. */
function ask(req: Record<string, unknown>, onEvent?: (e: GwEvent) => void): Promise<GwEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: GwEvent[] = [];
    const timer = setTimeout(
      () => reject(new Error(`gateway timeout (${gwStatus || "no status"})`)),
      1000 * 60 * 35,
    );
    gateway().send(req, (e) => {
      if (e.kind === "done") {
        clearTimeout(timer);
        resolve(seen);
        return;
      }
      seen.push(e);
      onEvent?.(e);
    });
  });
}

const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");

export const GROK_TOOLS: Tool[] = [
  {
    name: "grok_ls",
    description:
      "List the Grok Bot agents on the box, newest conversation first, each with its index, " +
      "short id, harness type, state and the last line of its conversation. " +
      "Call this FIRST: agent ids are not guessable and the roster changes. " +
      "harness=temporal agents can search the live web; harness=null ones cannot.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      const events = await ask({ cmd: "ls", preview: true });
      const rows = events
        .filter((e) => e.kind === "agent")
        .map(
          (e) =>
            `${String(e.i).padStart(2)} ${e.id.slice(0, 8)} ${e.harness ?? "-"} ` +
            `${e.running ? "running" : e.active ? "active" : "idle"} ${when(e.updated)} ` +
            `${e.name} — ${(e.preview || "").slice(0, 100)}`,
        );
      return redact(rows.join("\n") || "no agents");
    },
  },
  {
    name: "grok_ask",
    description:
      "Send a prompt to one Grok agent and wait for the complete reply. " +
      "`agent` is an index from grok_ls, an id prefix, or a name substring — ambiguity is an " +
      "error listing candidates, not a guess. A temporal agent doing a live web search is " +
      "SILENT for minutes; that is normal and this tool waits for it. " +
      "Ask one question per call and say what form the answer should take.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "index, id prefix, or name substring" },
        prompt: { type: "string", description: "the question, self-contained" },
      },
      required: ["agent", "prompt"],
    },
    async run(a: { agent: string; prompt: string }) {
      const prompt =
        `${a.prompt}\n\nWhen you have finished answering, write the line ${SENTINEL} on its own.`;
      const events = await ask({ cmd: "ask", agent: a.agent, prompt, poll: 4, deadline: 1500 });
      const chunks = events.filter((e) => e.kind === "chunk").map((e) => e.text);
      const end = events.find((e) => e.kind === "end");
      const err = events.find((e) => e.kind === "error");
      if (err) return `error: ${err.text}`;
      if (!chunks.length) return `no reply (${end?.reason ?? "unknown"})`;
      return redact(chunks.join("\n").replaceAll(SENTINEL, "").trim());
    },
  },
  {
    name: "grok_tail",
    description:
      "Read the recent transcript of one agent without sending anything. " +
      "Use it to check what a bot already said before asking it again, and to verify that a " +
      "reply actually landed. This reads the live server-side transcript, which is the only " +
      "place a temporal agent's replies exist — their local store.db is never written.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        limit: { type: "number", description: "entries, default 20" },
      },
      required: ["agent"],
    },
    async run(a: { agent: string; limit?: number }) {
      const events = await ask({ cmd: "tail", agent: a.agent, limit: a.limit ?? 20 });
      const lines = events
        .filter((e) => e.kind === "entry" && e.text)
        .map((e) => `[${e.role}] ${String(e.text).slice(0, 600)}`);
      return redact(lines.join("\n") || "empty transcript");
    },
  },
  {
    name: "grok_find",
    description:
      "Full-text search across EVERY agent's transcript on the box. Returns agent id, entry id " +
      "and a snippet. Use it to find which bot already knows about a topic instead of asking " +
      "them all. Search is lexical: prefer a distinctive term (a hostname, an id, an error " +
      "string) over common words, which return many diluted hits.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "default 15" },
      },
      required: ["query"],
    },
    async run(a: { query: string; limit?: number }) {
      const events = await ask({ cmd: "find", query: a.query, limit: a.limit ?? 15 });
      const lines = events
        .filter((e) => e.kind === "hit")
        .map((e) => `${e.id.slice(0, 8)} ${e.entry} ${e.name} :: ${e.snippet}`);
      return redact(lines.join("\n") || `no transcript matches for ${a.query}`);
    },
  },
  {
    name: "grok_host",
    description:
      "Which box the Grok tools are talking to. Cheap; use it when reporting where a finding " +
      "came from.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      return `${HOST}${gwStatus ? ` (${gwStatus})` : ""}`;
    },
  },
];
