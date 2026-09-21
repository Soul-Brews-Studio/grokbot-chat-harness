# `grok` — a direct line to the Grok Bot agents

```sh
grok ls                            # who is on the box
grok ask 3 "what is new in X?"     # send, watch the reply arrive
grok ask 3 -q "..." > answer.txt   # answer only, nothing else on stdout
grok watch 3                       # follow a conversation live
grok find netbird                  # full-text search across every bot's transcript
grok raw listAgents                # any gateway RPC, unfiltered
```

`just grok-ls`, `just grok-ask <agent> "..."`, `just grok-watch <agent>` and
`just grok-doctor` wrap the same thing; `~/.local/bin/grok` symlinks here, so the bare
`grok` works from any directory.

`<agent>` is an index from `ls`, an id prefix, or a name substring. Ambiguity is an
error that lists the candidates rather than a guess.

The roster is ordered **newest conversation first**, the same as the Grok Bot app's
chat list, and `grok ls -p` adds each agent's last line the way that list previews it.
The index and the sort are computed in the same place on the box, so `grok ask 0` is
always the agent printed as `0`.

## The TUI

```sh
just grok-tui                # or: cd tools/tui && bun run grok-tui.tsx
```

Ink + Bun, one screen: roster on the left with live state dots, the selected
agent's transcript on the right, a prompt line at the bottom. It polls the open
conversation every 6s, so a reply someone else triggered shows up too.

```
keys    j/k or arrows select · enter/i ask · / search · r refresh · tab cycle · q quit
mouse   click a row to select · wheel scrolls the roster or the transcript
```

Mouse tracking (SGR 1006) means the terminal sends clicks to the app rather than
selecting text — hold shift when you want to select and copy instead. The modes are
turned off on exit, including on ^C, or the terminal keeps eating clicks afterwards.

There is still **no server**: `tools/tui/gateway.ts` spawns one `ssh` running
`grok_remote.py` in repl mode and multiplexes every request over it by `rid`. The
repl dies with the socket.

## Trendy Bot — a standing Jev sweep

`Trendy Bot` (`758c2177`, temporal harness) is asked what moved in Jev-land every
three hours from 06:00, and its answer is appended to
`ψ/memory/logs/trendy/<date>.md`.

```sh
just trendy-install      # load the launchd timer (06 09 12 15 18 21)
just trendy-run          # one sweep now
just trendy-status       # loaded? last exit code? which logs exist?
just trendy-log          # today's sweeps
just trendy-uninstall    # stop it; the logs stay
```

The prompt demands a date and a source URL per bullet, says to mark vendor-run
numbers as vendor-run, and to answer `NOTHING NEW` rather than pad — the failure
mode of a recurring research bot is inventing movement on a quiet day.

A run that cannot reach the box writes *why* into the log (wrong NetBird profile,
ssh failure) instead of leaving a silent gap. Night coverage: add `0` and `3` to
the hours in `tools/com.laris.grok-trendy.plist` and reinstall.

## What it talks to

```
 m5 (this Mac)                    your-box  (Cursor sandbox container)
 ───────────────                  ────────────────────────────────────────────────
 tools/grok  ──ssh, stdin JSON──▶ python3 -c <hex payload>
                                        │
                                        ▼  127.0.0.1:1340   Bearer from
                                   Grok gateway            /home/box/sand-data/gateway.json
                                        │
                                        ▼
                                   listAgents · sendPrompt · getAgentTranscriptTail
```

Reachability needs m5 on the **commu** NetBird profile (`netbird profile select
your-mesh.example && netbird up`), or a `ProxyJump your-jump-host` block for the
host. `the retired box` is the dead predecessor; `your-box` (198.51.100.20) is
the live box.

Override the target with `GROK_HOST=box@somewhere ./tools/grok ls`.

## The two things it gets right

**Replies are bound to a turn.** Transcript ids are turn-scoped — `t41u` is the user
message, `t41s0..N` are the agent's replies to it. After `sendPrompt` we find our own
user entry by its correlation marker, take the `t41` prefix, and read only that turn.
A neighbouring conversation cannot be mistaken for our answer.

**Completion is a sentinel, not silence.** Every prompt gets `=== END ===` appended as
a finishing instruction (suppress with `--raw-prompt`). Nearly every agent on the box
runs `harness: temporal` — 11 of the 12 on your box, measured 2026-09-21 — does a live
web search, and goes silent for minutes mid-answer; a quiet timer walks away with a
preamble and calls it the reply. The quiet window is a backstop only, at 240s
(`--quiet-after`).

## Where the credentials stay

The token lives on the box in `/home/box/sand-data/gateway.json` and is read there.
Nothing is passed as an argv word on the remote side: the payload is hex-embedded in
`python3 -c` and the request rides in on stdin, the same seam `server/remote.ts` uses.
`/proc/<pid>/cmdline` is world-readable, which is how the gateway token leaked into
plain `ps` output on the retired box.

## Traps worth not rediscovering

- `~/sand-data` is **seed + upload-only sync**. Its `store.db` files are frozen at
  2026-09-16 while the agents are perfectly alive — a stale store is not a dead agent.
  This is what made a verification bug look like "the gateway drops prompts".
- Temporal agents **never write local `store.db`** at all; their replies exist only
  server-side, reachable through `getAgentTranscriptTail`. Reading SQLite to confirm
  delivery can only ever fail for them.
- Ports `1337/1338/136xx/140xx` belong to Cursor's computer-use plane. `1340` is the
  only Grok gateway.
- The box is an ephemeral container — overlay fs, no volumes, systemd offline. A
  rebuild loses netbird, sshd and `authorized_keys`; re-run the enrollment gist.
