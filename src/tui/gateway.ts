/**
 * One ssh, many requests, no server.
 *
 * The far side is tools/grok_remote.py in repl mode: it reads one JSON request
 * per line and answers with NDJSON events tagged by that request's `rid`, closed
 * by {kind:"done"}. The payload is hex-embedded in `python3 -c` and the request
 * rides on stdin, so no prompt and no token ever lands in argv -- /proc/<pid>/cmdline
 * is world-readable, which is how the gateway token leaked into `ps` on the retired box.
 *
 * Nothing is left running on the box: the repl dies with the ssh socket.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Event = Record<string, any> & { kind: string; rid?: number };

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOST = process.env.GROK_HOST ?? "";
export const SENTINEL = "=== END ===";

export class Gateway {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = "";
  private rid = 0;
  private handlers = new Map<number, (e: Event) => void>();
  private onStatus: (s: string) => void;

  constructor(onStatus: (s: string) => void) {
    this.onStatus = onStatus;
  }

  start() {
    if (!HOST) {
      // ssh would fail with "Host key verification failed", which explains nothing
      this.onStatus("GROK_HOST is not set — export GROK_HOST=user@your-box");
      return;
    }
    const source = readFileSync(join(HERE, "..", "grok_remote.py"));
    const boot = `exec(bytes.fromhex('${source.toString("hex")}'),{'__name__':'__main__'})`;
    // ssh joins its remote words and hands them to the far shell, so the payload
    // is quoted for THAT shell
    const remote = `python3 -c '${boot.replaceAll("'", "'\\''")}'`;
    this.proc = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST, remote]);

    this.proc.stdout!.on("data", (b: Buffer) => this.feed(b.toString()));
    this.proc.stderr!.on("data", (b: Buffer) => this.onStatus(b.toString().trim()));
    this.proc.on("exit", (code) => this.onStatus(`ssh exited (${code}) — restart the TUI`));

    this.proc.stdin!.write(JSON.stringify({ cmd: "repl" }) + "\n");
  }

  private feed(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let event: Event;
      try {
        event = JSON.parse(line);
      } catch {
        this.onStatus(line);
        continue;
      }
      if (event.kind === "ready") {
        this.onStatus(`connected — gateway :${event.port} on ${HOST}`);
        continue;
      }
      const handler = event.rid != null ? this.handlers.get(event.rid) : undefined;
      if (!handler) continue;
      handler(event);
      if (event.kind === "done") this.handlers.delete(event.rid!);
    }
  }

  /** Fire a request; `onEvent` sees every event of that request, ending with `done`. */
  send(req: Record<string, unknown>, onEvent: (e: Event) => void) {
    const rid = ++this.rid;
    this.handlers.set(rid, onEvent);
    this.proc!.stdin!.write(JSON.stringify({ ...req, rid, sentinel: SENTINEL }) + "\n");
    return rid;
  }

  stop() {
    this.proc?.stdin?.end();
    this.proc?.kill();
  }
}
