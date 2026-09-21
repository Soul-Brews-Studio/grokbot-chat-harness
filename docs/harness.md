# grok-harness — an agent that drives the Grok bots

```sh
just harness "which bot already knows about NetBird, and what did it conclude?"
just harness-log netbird          # read a past run's event log
bun run tools/harness/cli.ts --model ollama:qwen3.6:latest --session jev "..."
```

A model runs in a loop with five tools — `grok_ls`, `grok_find`, `grok_ask`, `grok_tail`,
`grok_host` — and decides for itself which bot to talk to. You state the outcome; it
does the roster reading, the picking, the asking and the verifying.

```
   you ──task──▶ harness loop ──tools──▶ one ssh repl ──▶ gateway :1340 ──▶ Grok bots
                      │
                      └── every step appended to sessions/<name>.jsonl (never rewritten)
```

## Why an event log instead of a message array

Each turn projects the log into the messages the model sees. When the log outgrows
`compactAfter`, the harness appends a **`compact` marker** rather than dropping turns:
the projection starts after it and shows its summary instead. The originals stay in
the file and in `all()`. Compaction becomes a view, not a deletion — Rule 1 as
architecture rather than a policy nobody enforces.

It also means a run is **resumable**. Same `--session`, same log, history intact.

## Why the tool descriptions are long

The model writes the arguments, so a trap only helps if it is in the description the
model reads. `grok_ask` says a temporal agent goes silent for minutes mid-search, so
the model does not re-ask. `grok_find` says the search is lexical and a distinctive
term beats common words. `grok_ls` says ids are not guessable, so it is called first.

## Models

`provider:model` — `glm:glm-5.3` (default, z.ai over its Anthropic-compatible API,
key from `pass <your-entry>`) or `ollama:qwen3.6:latest` for local. `--smol` names a
cheap model for compaction summaries; without it the summary is mechanical, because
a failed summariser must not take down a run.

The two providers disagree in a way worth knowing: a tool result must carry the
`tool_use` id on the Anthropic shape, while ollama tolerates keying by name. Wiring
the second backend is what exposed it.

## Redaction happens on the way in

The Grok box keeps `SAND_GATEWAY_TOKEN` in Chrome's argv, so any transcript that ever
captured a `ps` listing carries it. This log is append-only — a secret written into it
cannot be removed — so `redact.ts` scrubs every tool result *before* it becomes an
event. The uppercase-UUID rule catches NetBird setup keys while leaving lowercase Grok
agent ids intact, which the model needs to address a bot.

## In the TUI

`just grok-tui`, then press **`a`** for an `agent ❯` prompt. The harness borrows the
TUI's open ssh connection rather than opening a second one, and its steps stream into
the transcript pane. `GROK_HARNESS_MODEL` overrides the model there.
