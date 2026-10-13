// Offline smoke test: drives HomeAssistantAgent with the scripted "faux" provider (no API key needed).
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { HomeAssistantAgent } from "../src/ha-agent.js";
import { loadSkills } from "../src/skills.js";
import type { HaConversationRequest } from "../src/types.js";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const skills = await loadSkills(new URL("../skills", import.meta.url).pathname);

let seenContext: any;
faux.setResponses([
  // turn 1: model reads a skill and looks up a device
  fauxAssistantMessage([
    fauxToolCall("read_skill", { name: "voice-style" }),
    fauxToolCall("get_entity_state", { query: "couch" }),
  ], { stopReason: "toolUse" }),
  // turn 2: inspect what the model was sent, then answer
  (context) => {
    seenContext = context;
    return fauxAssistantMessage([fauxText("The couch light is on.")]);
  },
]);

const agent = new HomeAssistantAgent({ model, streamFn: models.streamSimple.bind(models), skills });

const req: HaConversationRequest = {
  conversation_id: "c1",
  language: "en",
  query: "Is the couch light on?",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello! How can I help?" },
    { role: "user", content: "Is the couch light on?" },
  ],
  exposed_entities: [{ entity_id: "light.couch", name: "Couch light", state: "on", area_name: "Living room" }],
};

const deltas: string[] = [];
const out = await agent.run(req, { onTextDelta: (d) => deltas.push(d) });

const toolResults = seenContext.messages.filter((m: any) => m.role === "toolResult");
console.log("output:", JSON.stringify(out));
console.log("streamed:", JSON.stringify(deltas.join("")));
console.log("tool results seen by model:", toolResults.map((m: any) => `${m.toolName} -> ${m.content?.[0]?.text?.slice(0, 40)}`));
console.log("history length before prompt (expect user,assistant,user,...):", seenContext.messages.map((m: any) => m.role).join(","));

const ok = out === "The couch light is on." && deltas.join("") === out && toolResults.length === 2;
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
