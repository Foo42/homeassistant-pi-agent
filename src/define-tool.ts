import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

/**
 * Identity helper: infers `params` from the typebox schema so `execute` is fully typed,
 * and erases the generic so tools of different shapes fit in one `AgentTool[]`.
 */
export function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool<any> {
  return tool as unknown as AgentTool<any>;
}
