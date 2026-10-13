import type { AgentTool } from "@earendil-works/pi-agent-core";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

export interface HaMcpConnection {
  tools: AgentTool<any>[];
  close(): Promise<void>;
}

/**
 * Connect to Home Assistant's built-in MCP server (Settings > Devices & services > "Model Context
 * Protocol Server") and expose its tools as pi AgentTools.
 *
 * `baseUrl` e.g. http://homeassistant.local:8123, `token` is a long-lived access token.
 * We use /api/mcp/assist: the Assist tools (HassTurnOn, HassLightSet, GetLiveContext, ...), limited to
 * entities exposed to Assist. Use /api/mcp instead to get every LLM API (needs an admin token).
 */
export async function connectHomeAssistantMcp(baseUrl: string, token: string): Promise<HaMcpConnection> {
  const client = new McpClient({ name: "ha-pi-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHttpTransport({
      url: `${baseUrl.replace(/\/$/, "")}/api/mcp/assist`,
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

  const tools: AgentTool<any>[] = (await client.listTools()).map((tool) => ({
    // Providers allow at most 64 chars of [A-Za-z0-9_-].
    name: tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    // Providers want an object schema; some reject one without `properties`.
    parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
    // Device control mutates state; keep calls ordered.
    executionMode: "sequential" as const,
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
      // MCP reports tool failures inside the result; surface them as thrown errors so the loop marks isError.
      const content = toLlmContent(result);
      if (result.isError) {
        throw new Error(content.map((c) => (c.type === "text" ? c.text : "")).join(" ") || "Tool failed");
      }
      return { content, details: undefined };
    },
  }));

  return { tools, close: () => client.close() };
}
