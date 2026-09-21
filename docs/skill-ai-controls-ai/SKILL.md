---
name: ai-controls-ai
description: Build a harness so a program — or another model — can drive an AI agent that has no API, only a chat window. Covers turn binding, sentinel completion, append-only event logs, redaction on ingest, and tool descriptions written for a model reader. Use when the user says "control that bot", "drive the agent", "no API only chat", "harness", "agent loop", "คุมบอท", "ให้ AI คุม AI", or when an agent replies 2xx and then goes silent. Do NOT use for calling a normal model API (just call it), or for same-session subagents (use the Agent tool).
---

# /ai-controls-ai — drive an agent that has no API

> Proven 2026-09-21: Claude wrote the harness, GLM-5.3 drove the loop, Grok answered.
> Four-step task (find → read → ask → report) in 56s / 12 events.
> Code: github.com/laris-co/grokbot-chat-harness

## The problem this solves

An agent you want to drive has no API. It has a chat window meant for a human, and it
often lives on a machine that is not yours. Three questions have no obvious answer:

| question | why a program cannot just guess |
|---|---|
| **ask who?** | one runtime may hold many agents, each with its own memory |
| **which reply is mine?** | replies land in a shared stream, out of order, interleaved |
| **is it finished?** | "answered briefly then stopped" and "still thinking" look identical |

A human reading the screen solves all three instantly. A program solves none of them
unless you build for it. That is the whole job.

## Step 0 — name who talks to whom, before writing code

Write the chain down. Every later decision depends on which side owns which problem.

```text
you / a script
  -> transport (ssh, http, socket)
     -> the agent host (gateway, server, runtime)
        -> agent A, agent B, agent C ...
```

If a *model* will drive the loop rather than a fixed script, that is another layer, and
it is the one people forget to name:

```text
model M decides which tool to call and what to ask
  -> your tools
     -> the agent that M picked
```

Write which model plays which role, by name and vendor. "AI controls AI" is not a
slogan; it is a routing table, and vendors differ in ways that become bugs (below).

## Step 1 — reachability first, and prove it

Before any protocol work, get a shell or a request through, and record exactly what
worked. Traps that cost real time:

- **one name, two networks.** The same hostname can exist on two overlays and mean two
  machines. Compare the timestamp of the doc that names the host against the timestamp
  of the host itself.
- **client-wide profiles.** Many overlay VPNs hold one profile per *machine*, so
  switching to reach one host silently drops every other host.
- **ssh matches the name you typed**, not the `HostName` it resolves to. A `ProxyJump`
  under the resolved name never fires for the alias.
- **ephemeral boxes.** If the agent runs in a rebuildable container, assume the network
  client, sshd and keys vanish on rebuild. Script the enrolment.

Gate: a one-liner that proves reachability and prints the far side's identity.

## Step 2 — the three answers

### Ask who — never guess an id

List first, always. Resolve a user-supplied selector (index, id prefix, name substring)
**on the side that owns the roster**, and make ambiguity an error that lists candidates
rather than a guess. Sort the roster the same way the agent's own UI does, and compute
the index in the same place you sort — otherwise `ask 0` means a different agent than
the `0` you printed.

### Which reply is mine — bind to a turn, not to time

Transcript ids are usually turn-scoped (`t41u` for the user message, `t41s0..N` for the
replies to it). Send a **correlation marker** inside the prompt, find your own entry by
that marker, take its turn prefix, and read only that turn.

```python
def turn_of(entries, marker):
    for e in entries:
        if e.get("role") == "user" and marker in (e.get("content") or ""):
            m = re.match(r"(t\d+)u$", e.get("id") or "")
            if m:
                return m.group(1)
```

Reading "the newest assistant message" works until two turns overlap, and then it
silently attributes someone else's answer to your question.

### Is it finished — a sentinel, never silence

Ask the agent to print a fixed line when done, and stop on that line.

```
<your prompt>

When you have finished answering, write the line === END === on its own.
```

Measured: an agent doing a live web search goes quiet for **minutes**. A 45-second quiet
window returned four preambles and one real answer out of five. Keep a quiet timer only
as a backstop (240s worked), never as the primary stop condition.

## Step 3 — the loop, if a model is driving

```text
project the log into messages -> call the model -> append whatever came back
  -> run its tool calls -> append results -> repeat
stop when the model returns no tool calls, or the step budget runs out
```

Three rules that matter more than the loop itself:

**Errors go back as results, not as exceptions.** A model recovers from a failed call
far more often than a crashed process does.

**Tool descriptions are the UI, and the model is the reader.** The model writes the
arguments, so every trap must live in the description:

| trap | what the description must say |
|---|---|
| agent goes quiet mid-search | "silent for minutes is normal; this tool waits; do not re-ask" |
| lexical search dilutes | "prefer a distinctive term; common words return many weak hits" |
| ids are not guessable | "call the list tool first" |

**Cheap model for the cheap job.** Summaries and compaction can run on a small model;
the loop itself needs tool calling and judgement. Set the model **explicitly on every
call** — a framework that inherits a session default will quietly run everything on the
expensive one. Writing "use the small model" in your docs enforces nothing.

## Step 4 — append-only log, projection, compaction as a marker

The session **is** the log. Messages the model sees are a projection of it.

```ts
type Event =
  | { t: "user";        text: string }
  | { t: "assistant";   text: string }
  | { t: "tool_call";   id: string; name: string; args: unknown }
  | { t: "tool_result"; id: string; name: string; result: string }
  | { t: "compact";     upto: number; summary: string }
```

When the log outgrows the budget, **append a `compact` marker** instead of dropping
turns: the projection starts after the marker and shows its summary, while every
original stays in the file and stays addressable.

Measured on a real run: the log grew 8 → 9 events while the model's view shrank
9 → 6 messages. Resumability falls out for free — same log, same session, history intact.

## Step 5 — redact on ingest, because the log cannot be edited

A secret written into an append-only log cannot be removed from it. Scrub every tool
result **before** it becomes an event, not when something reads it later.

Patterns worth having: provider key shapes (`gsk_`, `sk-`, `ghp_`, `github_pat_`,
`AKIA`, `xox*`), JWTs, and `TOKEN=`/`SECRET=`/`API_KEY=` assignments. Case matters: if
enrolment keys are uppercase UUIDs and agent ids are lowercase UUIDs, redact only the
uppercase ones — the model needs the ids to address anything.

This is not theoretical. A gateway token living in a browser wrapper's argv means `ps`
prints it to any local account, and any transcript that captured a process listing
carries it forward.

## Step 6 — two providers disagree; wire the second one early

A tool result must carry the `tool_use` id on the Anthropic shape, while some local
runtimes tolerate keying by tool name. Code that works against one silently breaks on
the other. Wiring a second backend is what exposes assumptions — do it before you have
built a lot on top of the first.

## Step 7 — a human still needs to watch

Even when a model drives, build a view. A terminal UI that shows the roster on one side
and the live transcript on the other turns "it is thinking" into "it called `find`, got
three hits, and is now asking the second one".

If the UI and the headless tools share one connection, **lend** the connection rather
than opening a second one, and make the borrower close only what it opened.

## Step 8 — publishing checklist

Running this against a real system means your code carries real host names.

- [ ] no default host in the code — require an env var and **fail with a message that
      names it**, or the user sees the transport's confusing error instead
- [ ] host names, domains, IPs replaced with documentation values
      (`.internal`, RFC 5737 `198.51.100.x`, `203.0.113.x`)
- [ ] secret-store entry names configurable, not hard-coded
- [ ] **grep the built artifact, not the source** — a PDF, bundle or image built before
      the scrub still carries the old strings
- [ ] short forms as well as fully-qualified names (`host1` as well as `host1.example.net`)
- [ ] state plainly who wrote the code if an AI did

## Anti-patterns

| ❌ | why it fails |
|---|---|
| stop on silence | a searching agent is silent for minutes |
| newest message = my answer | two overlapping turns and you quote a stranger |
| guess the agent id | ids are opaque and the roster changes |
| secrets in argv | `/proc/<pid>/cmdline` is world-readable |
| redact on read | an append-only log cannot be cleaned afterwards |
| mutate the message array to shrink context | the record is the only thing that catches a wrong conclusion |
| trap written in a code comment | the model reads descriptions, not your comments |
| model left unset in agent calls | everything silently runs on the session default |
| scrub the markdown only | the shipped artifact keeps the old strings |

## Related

| skill | use when |
|---|---|
| `/herdr-pane-run` | run the long test where the human can watch it |
| `/oracle-prism` | choose between designs with measurable lenses |
| `/nat-technical-kien-thai` | write the Thai doc for it |
