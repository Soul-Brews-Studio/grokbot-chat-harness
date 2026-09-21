/**
 * Append-only event log. The session IS the log; the messages the model sees are
 * a projection of it.
 *
 * Every harness eventually has to shrink context, and the usual move — mutate the
 * message array, drop or summarise old turns — destroys the record. Here the log
 * only grows and `deriveMessages()` decides what is visible, so compaction is a
 * marker rather than a deletion. That is Rule 1 as architecture instead of policy.
 *
 * Shape borrowed from the dsh-from-scratch chapter 5 pattern, by way of the
 * nexus-oracle harness lab (2026-09-20).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Event =
  | { t: "user"; text: string; at: string }
  | { t: "assistant"; text: string; at: string }
  | { t: "tool_call"; id: string; name: string; args: unknown; at: string }
  | { t: "tool_result"; id: string; name: string; result: string; at: string }
  | { t: "compact"; upto: number; summary: string; at: string };

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_name?: string;
  /** id of the tool_use this answers — required by the Anthropic shape */
  tool_call_id?: string;
};

export class EventLog {
  private events: Event[] = [];

  constructor(private path: string) {
    if (existsSync(path)) {
      this.events = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Event);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  append(e: Omit<Event, "at"> & { at?: string }): Event {
    const full = { ...e, at: e.at ?? new Date().toISOString() } as Event;
    this.events.push(full);
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }

  all(): readonly Event[] {
    return this.events;
  }

  /** Events at or before the newest `compact` marker become its summary — they
   *  stay in the log and in `all()`, they just leave the model's view. */
  deriveMessages(system: string): Message[] {
    const msgs: Message[] = [{ role: "system", content: system }];

    let start = 0;
    let preamble: string | null = null;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t === "compact") {
        start = e.upto + 1;
        preamble = e.summary;
        break;
      }
    }
    if (preamble) msgs.push({ role: "user", content: `[earlier turns, compacted]\n${preamble}` });

    for (const e of this.events.slice(start)) {
      switch (e.t) {
        case "user":
          msgs.push({ role: "user", content: e.text });
          break;
        case "assistant":
          if (e.text.trim()) msgs.push({ role: "assistant", content: e.text });
          break;
        case "tool_call":
          msgs.push({
            role: "assistant",
            content: "",
            tool_calls: [
              { id: e.id, function: { name: e.name, arguments: JSON.stringify(e.args) } },
            ],
          });
          break;
        case "tool_result":
          msgs.push({ role: "tool", content: e.result, tool_name: e.name, tool_call_id: e.id });
          break;
      }
    }
    return msgs;
  }

  head(): number {
    return this.events.length - 1;
  }
}
