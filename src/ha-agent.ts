import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createReadSkillTool, skillsPromptSection, type Skill } from "./skills.js";
import { createRequestTools, createStaticTools } from "./tools.js";
import type { HaConversationRequest } from "./types.js";
import { DEBUG, debug } from "./debug.js";

export interface HomeAssistantAgentOptions {
  model: Model<any>;
  /** The pi-ai stream function, e.g. `models.streamSimple.bind(models)`. Injectable for tests. */
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  /** Skills, or a loader called at the start of every run so SKILL.md edits apply without a restart. */
  skills: Skill[] | (() => Promise<Skill[]>);
  /** Extra tools added to every run, e.g. the Home Assistant MCP tools. */
  extraTools?: AgentTool<any>[];
  /** Hard cap on tool-call rounds etc. is up to the model; this caps wall-clock time. */
  timeoutMs?: number;
  basePrompt?: string;
}

export interface RunOptions {
  /** Called with each new chunk of assistant text (for streaming responses). */
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

const DEFAULT_PROMPT = [
  "You are a voice assistant for a smart home. Your replies are spoken aloud.",
  "Be brief and natural. Plain text only: no markdown, lists, emoji or URLs.",
  "Use tools to check device states or do things. Never guess a device state.",
].join("\n");

/**
 * One instance per process; each `run()` builds a fresh pi `Agent`, so concurrent
 * HTTP requests never share conversation state.
 */
export class HomeAssistantAgent {
  constructor(private readonly opts: HomeAssistantAgentOptions) {}

  async run(req: HaConversationRequest, run: RunOptions = {}): Promise<string> {
    const { model } = this.opts;
    const skills = typeof this.opts.skills === "function" ? await this.opts.skills() : this.opts.skills;

    // Static + per-request tools. Add or remove tools here; there is no bash unless you add one.
    const tools: AgentTool<any>[] = [
      ...createStaticTools(),
      ...createRequestTools(req.exposed_entities ?? []),
      ...(this.opts.extraTools ?? []),
      ...(skills.length ? [createReadSkillTool(skills)] : []),
    ];

    // HA may resend its own system messages in `messages`; fold them into the prompt.
    const haSystem = req.messages.filter((m) => m.role === "system").map((m) => m.content);
    const systemPrompt = [
      this.opts.basePrompt ?? DEFAULT_PROMPT,
      req.system_prompt,
      ...haSystem,
      skillsPromptSection(skills),
      `Current time: ${new Date().toISOString()}. Language: ${req.language ?? "en"}.`,
      req.user_name ? `The user is ${req.user_name}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Everything except the final user turn becomes history; the final turn is the prompt.
    const history = req.messages.filter((m) => m.role === "user" || m.role === "assistant");
    const last = history[history.length - 1];
    const prompt = last?.role === "user" ? last.content : req.query;
    const past = last?.role === "user" ? history.slice(0, -1) : history;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        messages: past.filter((m) => m.content).map((m) => this.toAgentMessage(m.role as "user" | "assistant", m.content)),
      },
      streamFn: this.opts.streamFn,
      sessionId: req.conversation_id,
    });

    debug("system prompt", systemPrompt);
    debug(`skills: ${skills.map((s) => s.name).join(", ") || "none"}`);
    debug(`tools: ${tools.map((t) => t.name).join(", ")}`);
    debug(`history: ${past.length} message(s); prompt: ${JSON.stringify(prompt)}`);

    let sawTextThisRun = false;
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        sawTextThisRun = true;
        run.onTextDelta?.(event.assistantMessageEvent.delta);
      }
      if (!DEBUG) return;
      if (event.type === "tool_execution_start") debug(`tool call ${event.toolName}`, event.args);
      if (event.type === "tool_execution_end") {
        debug(`tool ${event.isError ? "ERROR" : "result"} ${event.toolName} (${event.durationMs ?? "?"} ms)`, event.result);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const { stopReason, usage, errorMessage } = event.message as AssistantMessage;
        debug(`assistant turn: stop=${stopReason}`, { usage, ...(errorMessage ? { errorMessage } : {}) });
      }
    });

    // Abort on client disconnect or timeout.
    const abort = () => agent.abort();
    run.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.opts.timeoutMs ?? 25_000);
    try {
      await agent.prompt(prompt);
    } finally {
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", abort);
    }

    const finalMessage = [...agent.state.messages].reverse().find((m) => m.role === "assistant") as
      | AssistantMessage
      | undefined;
    if (!finalMessage) throw new Error("Agent produced no assistant message");
    if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
      throw new Error(finalMessage.errorMessage ?? `Agent run ${finalMessage.stopReason}`);
    }
    const text = finalMessage.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    if (!text && !sawTextThisRun) throw new Error("Agent returned an empty response");
    return text;
  }

  /** Rebuild pi messages from HA's plain-text history. Past tool calls are not replayed. */
  private toAgentMessage(role: "user" | "assistant", content: string): AgentMessage {
    const timestamp = Date.now();
    if (role === "user") return { role: "user", content, timestamp };
    const { model } = this.opts;
    return {
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    };
  }
}
