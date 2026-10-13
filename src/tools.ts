import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { defineTool } from "./define-tool.js";
import type { HaExposedEntity } from "./types.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

// Process-wide demo state. Replace with a database / HA todo entity in real use.
const shoppingList: string[] = [];

/**
 * Tools that don't depend on the request. Everything here is made up:
 * swap the bodies for real calls (HA REST API, a weather service, ...).
 */
export function createStaticTools(): AgentTool<any>[] {
  const getWeather = defineTool({
    name: "get_weather",
    label: "Get weather",
    description: "Get the current weather for a city.",
    parameters: Type.Object({
      city: Type.String({ description: "City name, e.g. 'Reykjavik'" }),
    }),
    execute: async (_id, params) => {
      // Fake data. A real implementation would call a weather API and honour `signal`.
      const temp = 4 + (params.city.length % 12);
      return { ...text(`${params.city}: ${temp} degrees Celsius, light rain, wind 5 metres per second.`), details: { city: params.city } };
    },
  });

  const addShoppingItem = defineTool({
    name: "add_shopping_item",
    label: "Add shopping item",
    description: "Add one item to the household shopping list.",
    parameters: Type.Object({ item: Type.String() }),
    // Mutates shared state, so don't run concurrently with other calls in the same batch.
    executionMode: "sequential",
    execute: async (_id, params) => {
      const item = params.item.trim().toLowerCase();
      if (!item) throw new Error("Item must not be empty");
      if (!shoppingList.includes(item)) shoppingList.push(item);
      return { ...text(`Added "${item}". The list now has ${shoppingList.length} item(s).`), details: { item } };
    },
  });

  const listShoppingItems = defineTool({
    name: "list_shopping_items",
    label: "List shopping items",
    description: "Read the current shopping list.",
    parameters: Type.Object({}),
    execute: async () => text(shoppingList.length ? shoppingList.join(", ") : "The shopping list is empty."),
  });

  return [getWeather, addShoppingItem, listShoppingItems];
}

/**
 * Tools built per request, closing over the context Home Assistant sent along.
 * Here: answer state questions from the `exposed_entities` snapshot in the payload.
 */
export function createRequestTools(entities: HaExposedEntity[]): AgentTool<any>[] {
  const getEntityState = defineTool({
    name: "get_entity_state",
    label: "Get entity state",
    description:
      "Look up the current state of a smart-home device or sensor by name, alias or area. Returns up to 5 matches.",
    parameters: Type.Object({
      query: Type.String({ description: "Device name, alias or area, e.g. 'living room light'" }),
    }),
    execute: async (_id, params) => {
      const q = params.query.toLowerCase();
      const hits = entities
        .filter((e) =>
          [e.name, e.entity_id, e.area_name ?? "", ...(e.aliases ?? [])].some((s) => s.toLowerCase().includes(q)),
        )
        .slice(0, 5);
      if (hits.length === 0) return text(`No device matching "${params.query}".`);
      return {
        ...text(hits.map((e) => `${e.name}${e.area_name ? ` (${e.area_name})` : ""}: ${e.state ?? "unknown"}`).join("\n")),
        details: { entityIds: hits.map((e) => e.entity_id) },
      };
    },
  });

  return [getEntityState];
}
