#!/usr/bin/env bun
/**
 * grok-tui — drive the Grok Bot agents from one screen.
 *
 *   bun run tools/tui/grok-tui.tsx        (or: just grok-tui)
 *
 * Left: the roster. Right: the selected agent's transcript, streaming.
 * Bottom: a prompt line. No server anywhere — one ssh holds a repl on the box
 * (see gateway.ts), and it dies when this process does.
 *
 * keys   j/k or ↑/↓ select · enter or i write · a hand a task to the harness agent ·
 *        esc back · / search · r refresh · tab cycle agent · q quit
 * mouse  click a row to select it · wheel over the roster moves the selection ·
 *        wheel over the transcript scrolls it. Mouse tracking makes the terminal
 *        send clicks to this app instead of selecting text -- hold shift (or the
 *        terminal's own modifier) when you actually want to select and copy.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Gateway, HOST, SENTINEL, type Event } from "./gateway.ts";
import { enableMouse } from "./mouse.ts";
import { EventLog } from "../harness/events.ts";
import { run as runHarness } from "../harness/agent.ts";
import { setGateway } from "../harness/tools.ts";

type Agent = {
  i: number;
  id: string;
  name: string;
  harness: string | null;
  running: boolean;
  active: boolean;
  updated?: number;
  preview?: string;
};

type Line = { id: string; role: string; text: string; live?: boolean };

const ROLE_COLOUR: Record<string, string> = {
  user: "cyan",
  assistant: "white",
  you: "cyan",
  note: "yellow",
  error: "red",
};

function stateOf(a: Agent) {
  return a.running ? "running" : a.active ? "active" : "idle";
}

/** Today as a clock time, older as a date — the way a chat list reads. */
function when(ms?: number) {
  if (!ms) return "";
  const t = new Date(ms);
  const today = new Date();
  const sameDay =
    t.getDate() === today.getDate() &&
    t.getMonth() === today.getMonth() &&
    t.getFullYear() === today.getFullYear();
  return sameDay
    ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
    : `${t.getDate()}/${t.getMonth() + 1}`;
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 30;
  const cols = stdout?.columns ?? 100;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [sel, setSel] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("connecting…");
  const [mode, setMode] = useState<"list" | "ask" | "find" | "task">("list");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const [scroll, setScroll] = useState(0); // rows held back from the bottom

  const gw = useRef<Gateway | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const selRef = useRef(0);
  selRef.current = sel;
  // the mouse handler is installed once, so it reads layout through a ref
  const layout = useRef({ listStart: 0, listWidth: 0, listRows: 0, bodyHeight: 0, flatLen: 0, agentsLen: 0 });

  const append = useCallback((line: Line) => setLines((ls) => [...ls, line]), []);

  const loadRoster = useCallback(() => {
    const next: Agent[] = [];
    gw.current!.send({ cmd: "ls", preview: true }, (e: Event) => {
      if (e.kind === "agent") next.push(e as Agent);
      if (e.kind === "done") {
        setAgents(next);
        setStatus(`${next.length} agents on ${HOST}`);
      }
      if (e.kind === "error") setStatus(e.text);
    });
  }, []);

  const loadTranscript = useCallback((agent: Agent, quiet = false) => {
    if (!agent) return;
    gw.current!.send({ cmd: "tail", agent: agent.id, limit: 60 }, (e: Event) => {
      if (e.kind === "entry" && e.text && !seen.current.has(e.id)) {
        seen.current.add(e.id);
        append({ id: e.id, role: e.role ?? "?", text: e.text });
      }
      if (e.kind === "error" && !quiet) setStatus(e.text);
    });
  }, [append]);

  // connect once; the repl lives for the whole session
  useEffect(() => {
    gw.current = new Gateway((s) => s && setStatus(s));
    gw.current.start();
    const t = setTimeout(loadRoster, 300);
    return () => {
      clearTimeout(t);
      gw.current?.stop();
    };
  }, [loadRoster]);

  // clicks and the wheel: row 1 is the header, row 2 the box border, so the
  // first roster line sits on screen row 3
  useEffect(() => {
    return enableMouse((e) => {
      const { listStart, listWidth, listRows, bodyHeight, flatLen, agentsLen } = layout.current;
      const overList = e.col <= listWidth;
      if (e.type === "wheel") {
        if (overList) {
          setSel((s) => {
            const next = e.direction === "up" ? s - 1 : s + 1;
            return Math.min(Math.max(0, next), Math.max(0, agentsLen - 1));
          });
        } else {
          setScroll((s) =>
            Math.min(Math.max(0, flatLen - bodyHeight),
                     Math.max(0, s + (e.direction === "up" ? 3 : -3))));
        }
        return;
      }
      if (e.type !== "press" || e.button !== 0) return;
      if (overList) {
        const idx = listStart + Math.floor((e.row - 3) / 2);
        if (idx >= listStart && idx < listStart + listRows) setSel(idx);
      }
    });
  }, []);

  // selecting an agent resets the view to that agent's recent transcript
  useEffect(() => {
    const agent = agents[sel];
    if (!agent) return;
    seen.current = new Set();
    setLines([]);
    setScroll(0);
    loadTranscript(agent);
  }, [sel, agents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // poll the open conversation so someone else's reply shows up too
  useEffect(() => {
    const t = setInterval(() => {
      if (!busy && agents[selRef.current]) loadTranscript(agents[selRef.current], true);
    }, 6000);
    return () => clearInterval(t);
  }, [agents, busy, loadTranscript]);

  const ask = useCallback((text: string) => {
    const agent = agents[selRef.current];
    if (!agent || !text.trim()) return;
    append({ id: `me-${Date.now()}`, role: "you", text });
    setBusy(true);
    setStatus(`asking ${agent.name || agent.id.slice(0, 8)}…`);
    const prompt =
      `${text}\n\nWhen you have finished answering, write the line ${SENTINEL} on its own.`;
    gw.current!.send({ cmd: "ask", agent: agent.id, prompt, poll: 4 }, (e: Event) => {
      if (e.kind === "sent") setStatus("sent — waiting for the first chunk");
      if (e.kind === "chunk") {
        append({ id: `c-${Date.now()}-${Math.random()}`, role: "assistant", text: e.text, live: true });
        setScroll(0);
        setStatus("streaming…");
      }
      if (e.kind === "warn") setStatus(`! ${e.text}`);
      if (e.kind === "error") {
        append({ id: `e-${Date.now()}`, role: "error", text: e.text });
        setStatus(e.text);
      }
      if (e.kind === "end") setStatus(`${e.reason} (${e.chunks ?? 0} chunks)`);
      if (e.kind === "done") {
        setBusy(false);
        seen.current = new Set();
        setLines([]);
        loadTranscript(agents[selRef.current], true);
      }
    });
  }, [agents, append, loadTranscript]);

  /** Hand a task to the harness agent. It chooses which bot to ask; we only
   *  stream its steps into the transcript pane. It borrows this connection. */
  const task = useCallback((text: string) => {
    if (!text.trim()) return;
    setLines([]);
    seen.current = new Set();
    setScroll(0);
    append({ id: `task-${Date.now()}`, role: "you", text: `task: ${text}` });
    setBusy(true);
    setStatus("harness working…");

    setGateway(gw.current);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const log = new EventLog(`${import.meta.dir}/../harness/sessions/tui-${stamp}.jsonl`);
    const model = process.env.GROK_HARNESS_MODEL ?? "glm:glm-5.3";

    runHarness(log, text, {
      model,
      maxSteps: 12,
      onEvent: (kind, detail) => {
        const role = kind === "say" ? "assistant" : kind === "result" ? "note" : "user";
        append({ id: `h-${Date.now()}-${Math.random()}`, role, text: `${kind}: ${detail}` });
        setScroll(0);
        setStatus(`harness ${kind}`);
      },
    })
      .then((answer) => {
        setStatus(answer ? `harness done (${model})` : "harness hit its step budget");
        setBusy(false);
      })
      .catch((e: any) => {
        append({ id: `he-${Date.now()}`, role: "error", text: String(e?.message ?? e) });
        setStatus("harness failed");
        setBusy(false);
      });
  }, [append]);

  const find = useCallback((query: string) => {
    if (!query.trim()) return;
    setLines([]);
    seen.current = new Set();
    append({ id: "find", role: "note", text: `search: ${query}` });
    gw.current!.send({ cmd: "find", query, limit: 25 }, (e: Event) => {
      if (e.kind === "hit") {
        append({
          id: `${e.id}-${e.entry}`,
          role: "note",
          text: `${(e.name || e.id.slice(0, 8)).padEnd(18)} ${e.entry.padEnd(6)} ${e.snippet}`,
        });
      }
      if (e.kind === "error") setStatus(e.text);
      if (e.kind === "done") setStatus(`search done — enter to return to ${agents[selRef.current]?.name ?? "agent"}`);
    });
  }, [agents, append]);

  useInput((input, key) => {
    if (mode !== "list") {
      if (key.escape) setMode("list");
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) {
      gw.current?.stop();
      exit();
    } else if (key.downArrow || input === "j") {
      setSel((s) => Math.min(s + 1, Math.max(agents.length - 1, 0)));
    } else if (key.upArrow || input === "k") {
      setSel((s) => Math.max(s - 1, 0));
    } else if (key.tab) {
      setSel((s) => (agents.length ? (s + 1) % agents.length : 0));
    } else if (input === "r") {
      loadRoster();
      seen.current = new Set();
      setLines([]);
      if (agents[sel]) loadTranscript(agents[sel]);
    } else if (input === "/") {
      setDraft("");
      setMode("find");
    } else if (input === "a") {
      setDraft("");
      setMode("task");
    } else if (key.return || input === "i") {
      setDraft("");
      setMode("ask");
    }
  });

  const agent = agents[sel];
  const listWidth = Math.min(34, Math.max(22, Math.floor(cols * 0.28)));
  const bodyHeight = Math.max(6, rows - 6);
  const wrap = Math.max(20, cols - listWidth - 6);

  // wrap by hand so the visible slice is measured in real screen rows
  const flat: { role: string; text: string }[] = [];
  for (const l of lines) {
    for (const raw of l.text.split("\n")) {
      if (!raw.length) {
        flat.push({ role: l.role, text: "" });
        continue;
      }
      for (let i = 0; i < raw.length; i += wrap) {
        flat.push({ role: l.role, text: raw.slice(i, i + wrap) });
      }
    }
  }
  const clampedScroll = Math.min(scroll, Math.max(0, flat.length - bodyHeight));
  const end = flat.length - clampedScroll;
  const view = flat.slice(Math.max(0, end - bodyHeight), end);

  const listRows = Math.max(2, Math.floor((bodyHeight - 1) / 2)); // two rows per agent
  const listStart = Math.min(
    Math.max(0, sel - Math.floor(listRows / 2)),
    Math.max(0, agents.length - listRows),
  );
  const listSlice = agents.slice(listStart, listStart + listRows);
  const hidden = agents.length - listSlice.length;
  layout.current = { listStart, listWidth, listRows: listSlice.length, bodyHeight,
                     flatLen: flat.length, agentsLen: agents.length };

  return (
    <Box flexDirection="column" height={rows - 1}>
      <Box>
        <Text bold color="magenta"> grok </Text>
        <Text dimColor>{HOST}</Text>
        {busy ? <Text color="yellow"> ● working</Text> : <Text dimColor> ○ idle</Text>}
      </Box>

      <Box flexGrow={1}>
        <Box
          flexDirection="column"
          width={listWidth}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {agents.length === 0 && <Text dimColor>loading…</Text>}
          {/* a fixed-height pane silently drops rows, so slice the roster to what
              actually fits and keep the selection inside the window */}
          {listSlice.map((a) => {
            const stamp = when(a.updated);
            const room = Math.max(6, listWidth - 7 - stamp.length);
            const title = (a.name || a.id.slice(0, 8)).slice(0, room);
            return (
              <Box key={a.id} flexDirection="column">
                <Text inverse={a.i === sel} wrap="truncate">
                  <Text color={a.running ? "green" : a.harness === "temporal" ? "blue" : "gray"}>
                    {a.running ? "●" : "○"}
                  </Text>
                  {` ${title.padEnd(room)} ${stamp}`}
                </Text>
                <Text dimColor wrap="truncate">
                  {`  ${(a.preview || "—").slice(0, listWidth - 4)}`}
                </Text>
              </Box>
            );
          })}
          {hidden > 0 && <Text dimColor>{`  +${hidden} more`}</Text>}
        </Box>

        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={busy ? "yellow" : "gray"}
          paddingX={1}
        >
          <Text dimColor wrap="truncate">
            {agent
              ? `${agent.name || "(unnamed)"} · ${agent.id.slice(0, 8)} · ${agent.harness ?? "-"} · ${stateOf(agent)}`
              : "no agent"}
          </Text>
          {view.map((l, i) => (
            <Text key={i} color={ROLE_COLOUR[l.role] ?? "gray"} wrap="truncate-end">
              {l.text}
            </Text>
          ))}
        </Box>
      </Box>

      {mode === "list" ? (
        <Box>
          <Text dimColor wrap="truncate">
            {" "}click/j/k · enter ask · a agent · / search · r refresh · q quit —{" "}
            {clampedScroll > 0 ? `↑${clampedScroll} · ` : ""}{status}
          </Text>
        </Box>
      ) : (
        <Box>
          <Text color={mode === "ask" ? "cyan" : mode === "task" ? "magenta" : "yellow"}>
            {mode === "ask" ? " ask ❯ " : mode === "task" ? " agent ❯ " : " find ❯ "}
          </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(v) => {
              setMode("list");
              setDraft("");
              if (mode === "ask") ask(v);
              else if (mode === "task") task(v);
              else find(v);
            }}
          />
        </Box>
      )}
    </Box>
  );
}

render(<App />);
