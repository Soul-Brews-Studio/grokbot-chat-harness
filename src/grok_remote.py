"""Runs ON the Grok box. Never imported locally -- it is hex-embedded into
`python3 -c` and fed its request on stdin, so no prompt and no token ever reaches
argv (which is world-readable through /proc/<pid>/cmdline).

Two modes, one protocol of NDJSON events:

* one-shot -- read a single request object from stdin, serve it, exit.
* repl     -- first request is {"cmd": "repl"}; every later line is a request
              carrying an "rid", answered with events tagged by that rid and
              closed by {"kind": "done"}. One ssh connection, many requests,
              nothing left running when the socket closes. This is what the TUI
              rides on, and why it needs no server.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

cfg = json.load(open(os.environ.get("GROK_GATEWAY_CONFIG", "/home/box/sand-data/gateway.json")))
PORT, TOKEN = cfg.get("port") or 1340, cfg["token"]
DEFAULT_SENTINEL = "=== END ==="


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _clean_traceback(kind, value, tb):
    """A real traceback would print the whole hex blob this file arrived as and
    bury the error inside it. Print the error."""
    sys.stderr.write("grok remote: %s: %s\n" % (kind.__name__, value))


sys.excepthook = _clean_traceback


class GatewayError(Exception):
    pass


def call(method, args=None, timeout=90):
    req = urllib.request.Request(
        "http://127.0.0.1:%s/api/%s" % (PORT, method),
        data=json.dumps(args or {}).encode(),
        headers={"Authorization": "Bearer " + TOKEN,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200].strip()
        raise GatewayError("%s: %s%s" % (method, exc.code, " " + detail if detail else ""))
    return json.loads(body) if body else None


def roster():
    return call("listAgents") or []


def resolve(sel):
    """index | id prefix | name substring -> one agent, or an error naming the ties.

    The index must mean what `ls` printed, so sort here exactly as `ls` does."""
    agents = sorted(roster(), key=lambda a: a.get("updatedAt") or 0, reverse=True)
    sel = str(sel)
    if sel.isdigit() and 0 <= int(sel) < len(agents):
        return agents[int(sel)]
    hits = [a for a in agents if a["id"].startswith(sel)]
    if not hits:
        low = sel.lower()
        hits = [a for a in agents if low in (a.get("name") or "").lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise GatewayError("no agent matches %r (%d on the box)" % (sel, len(agents)))
    raise GatewayError("%r matches %d agents:\n%s" % (
        sel, len(hits),
        "\n".join("  %s  %s" % (a["id"][:8], (a.get("name") or "")[:60]) for a in hits)))


def tail(agent_id, limit):
    return (call("getAgentTranscriptTail", {"id": agent_id, "limit": limit}) or {}).get("entries", [])


def turn_of(entries, marker):
    """Our own user entry's turn prefix, e.g. 't41' from 't41u'."""
    for e in entries:
        if e.get("kind") == "message" and e.get("role") == "user" and marker in (e.get("content") or ""):
            m = re.match(r"(t\d+)u$", e.get("id") or "")
            if m:
                return m.group(1)
    return None


def chunks_of(entries, turn):
    out = []
    for e in entries:
        if e.get("kind") != "send-message" or not (e.get("id") or "").startswith(turn + "s"):
            continue
        msg = e.get("message") or {}
        if msg.get("type") == "text" and msg.get("content"):
            out.append(msg["content"])
    return out


def entry_text(e):
    msg = e.get("message") or {}
    return (e.get("content") if e.get("kind") == "message" else msg.get("content")) or ""


def dispatch(req, out):
    cmd = req["cmd"]
    sentinel = req.get("sentinel") or DEFAULT_SENTINEL

    if cmd == "ls":
        # newest conversation first, the way the Grok Bot app itself orders them
        agents = sorted(roster(), key=lambda a: a.get("updatedAt") or 0, reverse=True)
        for i, a in enumerate(agents):
            preview = ""
            if req.get("preview"):
                try:
                    for e in reversed(tail(a["id"], 4)):
                        text = " ".join(entry_text(e).split())
                        if text:
                            preview = text[:160]
                            break
                except Exception:                     # one unreadable agent must not
                    preview = ""                      # cost the whole roster
            out(kind="agent", i=i, id=a["id"], harness=a.get("harness"),
                running=bool(a.get("isRunning")), active=bool(a.get("isActive")),
                updated=a.get("updatedAt"), name=a.get("name") or "", preview=preview)

    elif cmd == "raw":
        out(kind="raw", result=call(req["method"], req.get("args") or {}))

    elif cmd == "find":
        # searchAgents is full-text over every agent's transcript, not a name
        # lookup: it returns {agentId, entryId, role, timestampMs, snippet}
        res = call("searchAgents", {"query": req["query"], "limit": req.get("limit", 20)})
        hits = res if isinstance(res, list) else (res or {}).get("results") or []
        names = {a["id"]: (a.get("name") or "") for a in roster()}
        for h in hits:
            aid = h.get("agentId", "")
            out(kind="hit", id=aid, name=names.get(aid, ""), entry=h.get("entryId", ""),
                role=h.get("role", ""), ts=h.get("timestampMs"), snippet=h.get("snippet", ""))

    elif cmd == "new":
        # name AND description are required; harness temporal is the one that can
        # run a live web search
        out(kind="raw", result=call("createAgent", {
            "name": req["name"],
            "description": req.get("description") or req["name"],
            "harness": req.get("harness", "temporal"),
            "clientNonce": "GK_new_%d" % int(time.time() * 1000)}))

    elif cmd in ("tail", "watch"):
        a = resolve(req["agent"])
        out(kind="agent", id=a["id"], name=a.get("name") or "", harness=a.get("harness"))
        seen = set()
        deadline = time.time() + (req.get("deadline", 900) if cmd == "watch" else 0)
        while True:
            for e in tail(a["id"], req.get("limit", 20)):
                eid = e.get("id") or ""
                if eid in seen:
                    continue
                seen.add(eid)
                out(kind="entry", id=eid, ts=e.get("timestampMs"),
                    role=e.get("role") or (e.get("message") or {}).get("type") or e.get("kind"),
                    text=entry_text(e))
            if cmd == "tail" or time.time() > deadline:
                break
            time.sleep(req.get("poll", 5))

    elif cmd == "ask":
        a = resolve(req["agent"])
        marker = "GK_%d" % int(time.time() * 1000)
        poll, quiet = req.get("poll", 5), req.get("quiet", 240)
        deadline = req.get("deadline", 1800)
        out(kind="agent", id=a["id"], name=a.get("name") or "",
            harness=a.get("harness"), marker=marker)
        call("sendPrompt", {"agentId": a["id"],
                            "prompt": req["prompt"] + "\n\n[correlation: %s]" % marker,
                            "clientNonce": marker})
        out(kind="sent")

        start = last = time.time()
        turn, n = None, 0
        while time.time() - start < deadline:
            time.sleep(poll)
            try:
                entries = tail(a["id"], 200)
            except Exception as exc:                  # transient blip: report, keep going
                out(kind="warn", text=str(exc))
                continue
            if not turn:
                turn = turn_of(entries, marker)
                if not turn:
                    if time.time() - last > quiet:
                        out(kind="end", reason="prompt never appeared in the transcript")
                        return
                    continue
                out(kind="turn", turn=turn)
                last = time.time()
            chunks = chunks_of(entries, turn)
            if len(chunks) > n:
                for c in chunks[n:]:
                    out(kind="chunk", text=c)
                n, last = len(chunks), time.time()
            if any(sentinel in c for c in chunks):
                out(kind="end", reason="sentinel", chunks=n)
                return
            if time.time() - last > quiet:
                out(kind="end", reason="quiet %ds after %d chunks" % (quiet, n), chunks=n)
                return
        out(kind="end", reason="deadline %ds after %d chunks" % (deadline, n), chunks=n)

    else:
        raise GatewayError("unknown command %r" % cmd)


def serve_repl():
    """One ssh, many requests. Each is answered under its own rid and closed with
    `done`, so a caller can multiplex without a second connection."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("rid")

        def out(**kw):
            kw["rid"] = rid
            emit(**kw)

        try:
            dispatch(req, out)
        except (GatewayError, SystemExit) as exc:
            out(kind="error", text=str(exc))
        except Exception as exc:                      # never take the session down
            out(kind="error", text="%s: %s" % (type(exc).__name__, exc))
        out(kind="done")


first = json.loads(sys.stdin.readline())
if first.get("cmd") == "repl":
    emit(kind="ready", host=cfg.get("host") or "", port=PORT)
    serve_repl()
else:
    try:
        dispatch(first, emit)
    except (GatewayError, SystemExit) as exc:
        emit(kind="error", text=str(exc))
        sys.exit(1)
