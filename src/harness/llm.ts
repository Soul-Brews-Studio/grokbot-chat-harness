/**
 * Model providers: local ollama, and z.ai (GLM) over its Anthropic-compatible API.
 *
 * Two roles, following the split omp uses:
 *   main   drives the loop — needs tool calling and enough reasoning to choose a bot
 *   smol   cheap, quality-tolerant work (compaction summaries)
 *
 * A model string is "provider:model" — `glm:glm-5.3`, `ollama:qwen3.6:latest`.
 * A bare string means ollama.
 *
 * Non-streaming, deliberately: the loop only acts on a complete reply, and the
 * live view the human watches is the herdr pane, not a token stream.
 */
import type { Message } from "./events.ts";
import type { Tool } from "./tools.ts";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const ZAI = "https://api.z.ai/api/anthropic/v1/messages";

export type ToolCall = { id: string; name: string; args: any };
export type Reply = { text: string; toolCalls: ToolCall[] };

export function parseModel(spec: string): { provider: "ollama" | "glm"; model: string } {
  if (spec.startsWith("glm:")) return { provider: "glm", model: spec.slice(4) };
  if (spec.startsWith("ollama:")) return { provider: "ollama", model: spec.slice(7) };
  return { provider: "ollama", model: spec };
}

/** z.ai key from the password store. Read once, never logged. */
let cachedKey: string | null = null;
async function glmKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (process.env.GLM_API_KEY) return (cachedKey = process.env.GLM_API_KEY);
  const proc = Bun.spawn(["pass", process.env.GLM_PASS_ENTRY ?? "glm/api-key"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).split("\n")[0].trim();
  if ((await proc.exited) !== 0 || !out) {
    throw new Error("no GLM key: set GLM_API_KEY or store one at pass <your-entry>");
  }
  return (cachedKey = out);
}

async function chatOllama(model: string, messages: Message[], tools: Tool[]): Promise<Reply> {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: messages.map((m) => {
        const o: any = { role: m.role, content: m.content };
        if (m.tool_calls) {
          o.tool_calls = m.tool_calls.map((tc) => ({
            function: { name: tc.function.name, arguments: JSON.parse(tc.function.arguments) },
          }));
        }
        if (m.tool_name) o.tool_name = m.tool_name;
        return o;
      }),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const j: any = await r.json();
  const msg = j.message ?? {};
  return {
    text: msg.content ?? "",
    toolCalls: (msg.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `c${Date.now()}_${i}`,
      name: tc.function.name,
      args: tc.function.arguments ?? {},
    })),
  };
}

async function chatGlm(model: string, messages: Message[], tools: Tool[]): Promise<Reply> {
  const key = await glmKey();

  // Anthropic shape: system is top-level, tool results are user-role blocks, and
  // a tool_result must carry the id of the tool_use it answers — keying by name
  // works on ollama and fails here. That mismatch is why a second provider is
  // worth wiring earlier than it feels necessary.
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const body: any = {
    model,
    max_tokens: 4096,
    system,
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: m.tool_call_id ?? m.tool_name ?? "t",
                content: m.content,
              },
            ],
          };
        }
        if (m.tool_calls?.length) {
          return {
            role: "assistant",
            content: m.tool_calls.map((tc) => ({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const r = await fetch(ZAI, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`z.ai ${r.status}: ${(await r.text()).slice(0, 500)}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`z.ai: ${JSON.stringify(j.error).slice(0, 200)}`);

  const blocks: any[] = j.content ?? [];
  return {
    text: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
    toolCalls: blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
  };
}

export async function chat(spec: string, messages: Message[], tools: Tool[]): Promise<Reply> {
  const { provider, model } = parseModel(spec);
  return provider === "glm" ? chatGlm(model, messages, tools) : chatOllama(model, messages, tools);
}
