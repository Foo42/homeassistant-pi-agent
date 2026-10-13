# ha-pi-agent: project context and handoff

This file seeds a new Claude Code session. It summarises the goal, the decisions made, what is built and verified, and what is still open. Read it first.

## Goal

A headless TypeScript/Node agent that Home Assistant (HA) voice assistants call as their conversation agent. HA's custom integration [webhook-conversation](https://github.com/EuleMitKeule/webhook-conversation) POSTs the conversation to our HTTP server. Our server runs it through an agent built on Pi's `pi-agent-core`, with custom tools and loadable skills, and replies with text that HA speaks via TTS.

The author started out considering a Python app calling a harness, then chose TypeScript/Node for the whole service.

## Key decisions and why

- **Pi (`pi-mono`, Mario Zechner's agent harness), lower-level `@earendil-works/pi-agent-core` plus `pi-ai`, not `pi-coding-agent`.** agent-core ships with no tools at all, so there is no bash or file access unless we add it. The coding-agent package is a coding harness with bash/read/write/edit by default. Package scope appears as both `@mariozechner/*` and `@earendil-works/*` in different sources; this project uses `@earendil-works/*`. The API is evolving, so versions are pinned in `package-lock.json` (all 1.1.0 when built).
- **A new `Agent` per request.** `HomeAssistantAgent.run()` builds a fresh Pi `Agent` each call, so concurrent HTTP requests share no conversation state. History comes from HA's `messages` array.
- **Skills are our own ~50-line loader.** agent-core has no skill discovery (that lives in pi-coding-agent's `ResourceLoader`). We scan `skills/*/SKILL.md`, put a name/description index in the system prompt, and expose a `read_skill` tool that returns the full body on demand.
- **Home Assistant control via HA's built-in MCP server**, wrapped as Pi `AgentTool`s using `@earendil-works/pi-mcp` (`src/ha-mcp.ts`).

## The webhook contract (from the webhook-conversation README, release 1.12.0)

Request (POST, JSON), conversation agent variant:

```json
{
  "conversation_id": "abc123", "user_id": "...", "user_name": "...",
  "language": "de-DE", "agent_id": "conversation.webhook_agent",
  "device_id": "...", "device_info": {"name": "...", "manufacturer": "...", "model": "..."},
  "messages": [{"role": "assistant|system|tool_result|user", "content": "..."}],
  "query": "latest user message",
  "exposed_entities": [{"entity_id": "...", "name": "...", "state": "on", "aliases": [], "area_id": "...", "area_name": "..."}],
  "system_prompt": "optional extra instructions",
  "stream": false
}
```

Response:

- Non-streaming: `{"output": "reply text"}`. The field name is configurable in HA (default `output`).
- Streaming (when HA's "Enable Response Streaming" is on and `stream: true`): newline-delimited JSON, `{"type":"item","content":"chunk"}` repeated, then `{"type":"end"}`.
- Always return an `output`. An empty or missing one makes HA show "Unable to get a response" (confirmed in forum reports).
- Auth: optional HTTP basic auth configured in the integration. HA timeout defaults to 30 s (range 1-300).
- The README does not document tool-call chunk types. Release 1.12.0 notes mention "tool/function call support" and "begin/end blocks" for n8n streaming, but I found no spec. Check the integration's source if streaming misbehaves.

## What is built (all in this folder)

| File | Purpose |
|---|---|
| `src/server.ts` | HTTP server. `POST /conversation`, `GET /health`. Basic auth (timing-safe), 1 MB body cap, payload validation, streaming and non-streaming, aborts the agent if the client disconnects. Returns `{output:"Sorry, something went wrong."}` on agent errors. |
| `src/ha-agent.ts` | `HomeAssistantAgent`: wraps Pi `Agent`. Builds the system prompt (base prompt + HA `system_prompt` + HA system messages + skills index + time/language/user), maps HA history to Pi messages, 25 s default timeout, abort wiring, extracts final text. |
| `src/tools.ts` | Made-up demo tools: `get_weather` (fake), `add_shopping_item`/`list_shopping_items` (in-memory, sequential), and per-request `get_entity_state` (searches the `exposed_entities` snapshot from the payload). |
| `src/skills.ts` | Skill loader, system-prompt index, `read_skill` tool. |
| `src/ha-mcp.ts` | Connects to HA's MCP server at `<HA_URL>/api/mcp/assist` with a bearer token and wraps each MCP tool as an `AgentTool` (sequential execution, errors thrown). |
| `src/define-tool.ts` | `defineTool()` helper giving typed `params` from the typebox schema and erasing the generic so mixed tools fit in `AgentTool<any>[]`. |
| `src/types.ts` | TypeScript types for the HA request. |
| `skills/voice-style`, `skills/shopping-list` | Example skills. |
| `test/smoke.ts` | Offline smoke test using Pi's scripted "faux" provider (no API key). |

Run: `npm install`, `npm test`, then `ANTHROPIC_API_KEY=... npm start`.
Env vars: `PORT` (8787), `WEBHOOK_USER`/`WEBHOOK_PASSWORD` (basic auth, disabled if unset), `PI_MODEL` (default `claude-sonnet-4-6`), `SKILLS_DIR`, `HA_URL`/`HA_TOKEN` (enable the HA MCP tools; token is a long-lived access token).
In HA, the webhook URL is `http://<host>:8787/conversation`.

## Verified vs not verified

Verified (in a cloud sandbox):

- `tsc --noEmit` passes.
- `npm test` passes. It drives the agent with scripted responses and checks tool calls, tool results reaching the model, history ordering, and streamed text.
- The server starts, `/health` returns ok, a request without auth gets 401, and a bad payload gets 400.

Not verified:

- Any call to a real model (no API key was available).
- Any request from a real Home Assistant, including the streaming format.
- The HA MCP connection (`ha-mcp.ts` typechecks but was never run against HA).
- Whether the model id `claude-sonnet-4-6` resolves in `getModel`; the server throws at startup if not.

## Home Assistant MCP facts (from HA docs)

- Add the "Model Context Protocol Server" integration. Transport is Streamable HTTP, stateless. `/api/mcp` serves all LLM APIs; `/api/mcp/assist` serves the Assist API only (always available).
- Auth: long-lived token (profile > Security) or OAuth (IndieAuth). Non-admin users can use only the Assist API; other APIs need an admin.
- Only entities exposed to the voice assistant are reachable. Assist tools are limited to what Assist intents can do (HassTurnOn, HassTurnOff, HassLightSet, HassSetPosition, media, lists, `GetLiveContext`, ...). The assist `GetLiveContext` tool answers state questions.
- The MCP tool list is fetched once at startup in our code.

## Open items / next steps

1. **Add device-control rules to the base system prompt** in `src/ha-agent.ts` (`DEFAULT_PROMPT`), not to a skill: a skill costs an extra model round trip on the most common voice path. Suggested rules: for one device pass `name` + `domain`; for an area pass `area` + `domain` (e.g. `light`); don't combine `name`, `area` and `floor`; ask which one if ambiguous; use `GetLiveContext` for state questions rather than memory. Basis: a forum user's local model (gpt-oss via Ollama) failed light control until tool usage was spelled out, and HA's own default prompt gives similar guidance. Unknown whether a Claude model needs it, so test first.
2. **MCP reconnect.** If HA restarts, the cached connection and tools can break until this process restarts. Add reconnect or per-request connection.
3. **Test against a real HA.** Check that streaming works, that a spoken pre-tool phrase ("let me check") is acceptable (text before a tool call also streams to the speaker), and that the 25 s timeout is right (HA's default is 30 s).
4. **Decide about the demo tools.** Replace `get_weather` (fake) and the in-memory shopping list with real implementations (HA todo entity or REST API). `get_entity_state` may become redundant once `GetLiveContext` works.
5. **Persistent shopping/other state** if kept: currently process-wide in-memory.
6. **Security:** keep the service on the LAN, keep basic auth on, use HTTPS if it leaves the LAN (basic auth is cleartext otherwise). The HA MCP token can control doors and locks.
7. Optional: a Dockerfile / systemd unit; run via compiled JS (`tsc`) instead of `tsx`.

## Conventions

- ESM TypeScript, `NodeNext` module resolution, `strict`. Imports use `.js` suffixes.
- Tools are defined with `defineTool({...})` and typebox (`Type.Object`) schemas. Throw to signal tool errors (the agent loop reports them as `isError`).
- Tools that change state set `executionMode: "sequential"`.
- Pi `Agent` details that matter: `agent.prompt()` settles only when the run (including awaited subscribers) is done; `beforeToolCall`/`afterToolCall` hooks can block or rewrite tool calls; `agent.abort()` cancels.

## Sources

- Pi agent-core README: https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/agent/README.md
- Pi SDK docs: https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/sdk.md
- webhook-conversation README: https://raw.githubusercontent.com/EuleMitKeule/webhook-conversation/master/README.md
- webhook-conversation forum thread: https://community.home-assistant.io/t/webhook-conversation/917228
- HA MCP server: https://www.home-assistant.io/integrations/mcp_server/
