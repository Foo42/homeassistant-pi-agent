import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { HomeAssistantAgent } from "./ha-agent.js";
import { connectHomeAssistantMcp } from "./ha-mcp.js";
import { loadSkills } from "./skills.js";
import type { HaConversationRequest } from "./types.js";
import { DEBUG, debug } from "./debug.js";

const PORT = Number(process.env.PORT ?? 8787);
const AUTH_USER = process.env.WEBHOOK_USER;
const AUTH_PASS = process.env.WEBHOOK_PASSWORD;
const SKILLS_DIR = process.env.SKILLS_DIR ?? fileURLToPath(new URL("../skills", import.meta.url));
const MODEL_ID = process.env.PI_MODEL ?? "claude-sonnet-4-6";
const MAX_BODY_BYTES = 1_000_000;

// --- model + agent -----------------------------------------------------------
// Needs ANTHROPIC_API_KEY in the environment. To use another provider, import its
// provider factory from "@earendil-works/pi-ai/providers/<name>" and change the two lines below.
const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", MODEL_ID);
if (!model) throw new Error(`Model not found: anthropic/${MODEL_ID}`);

// Skills are re-read from disk on every request; this startup load is just for the log line.
const skills = await loadSkills(SKILLS_DIR);
console.log(`Found ${skills.length} skill(s) in ${SKILLS_DIR}: ${skills.map((s) => s.name).join(", ") || "none"}`);

// Optional: Home Assistant MCP server as a tool source (set HA_URL and HA_TOKEN).
let haMcpTools: Awaited<ReturnType<typeof connectHomeAssistantMcp>>["tools"] = [];
if (process.env.HA_URL && process.env.HA_TOKEN) {
  const conn = await connectHomeAssistantMcp(process.env.HA_URL, process.env.HA_TOKEN);
  haMcpTools = conn.tools;
  console.log(`HA MCP tools: ${haMcpTools.map((t) => t.name).join(", ")}`);
  process.on("SIGTERM", () => void conn.close());
}

const agent = new HomeAssistantAgent({
  model,
  streamFn: models.streamSimple.bind(models),
  skills: () => loadSkills(SKILLS_DIR),
  extraTools: haMcpTools,
});

// --- http --------------------------------------------------------------------
function authorised(req: IncomingMessage): boolean {
  if (!AUTH_USER && !AUTH_PASS) return true; // auth disabled
  const header = req.headers.authorization ?? "";
  const expected = `Basic ${Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function validate(body: any): HaConversationRequest {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages) || typeof body.query !== "string") {
    throw new HttpError(400, "Expected a conversation payload with `messages` and `query`");
  }
  return body as HaConversationRequest;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  debug(`${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  try {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/conversation") throw new HttpError(404, "Not found");
    if (!authorised(req)) {
      debug(`auth failed (Authorization header ${req.headers.authorization ? "present" : "missing"})`);
      res.setHeader("WWW-Authenticate", 'Basic realm="ha-pi-agent"');
      throw new HttpError(401, "Unauthorized");
    }

    const body = await readJson(req);
    debug("request payload", body);
    const payload = validate(body);

    // Abort the agent run if HA hangs up (e.g. its own timeout fired).
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });

    if (payload.stream) {
      // Newline-delimited JSON: {"type":"item","content":"..."} ... {"type":"end"}
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      let streamed = "";
      try {
        await agent.run(payload, {
          signal: ac.signal,
          onTextDelta: (delta) => {
            streamed += delta;
            res.write(JSON.stringify({ type: "item", content: delta }) + "\n");
          },
        });
        debug(`streamed response (${Date.now() - started} ms)`, streamed);
      } catch (err) {
        console.error("agent error", err);
        res.write(JSON.stringify({ type: "item", content: "Sorry, something went wrong." }) + "\n");
      }
      res.end(JSON.stringify({ type: "end" }) + "\n");
      return;
    }

    try {
      const output = await agent.run(payload, { signal: ac.signal });
      debug(`response (${Date.now() - started} ms)`, { output });
      sendJson(res, 200, { output });
    } catch (err) {
      console.error("agent error", err);
      // Always return an `output`, otherwise HA reports "unable to get response".
      sendJson(res, 200, { output: "Sorry, something went wrong." });
    }
  } catch (err) {
    if (err instanceof HttpError) {
      debug(`-> ${err.status} ${err.message}`);
      return sendJson(res, err.status, { error: err.message });
    }
    console.error(err);
    sendJson(res, 500, { error: "Internal error" });
  }
});

server.listen(PORT, () =>
  console.log(`ha-pi-agent listening on :${PORT} (POST /conversation)${DEBUG ? " [debug logging on]" : ""}`),
);
