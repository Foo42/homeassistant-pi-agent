/** Request body sent by the webhook-conversation integration (conversation agent). */
export interface HaExposedEntity {
  entity_id: string;
  name: string;
  state?: string;
  aliases?: string[];
  area_id?: string;
  area_name?: string;
}

export interface HaMessage {
  role: "assistant" | "system" | "tool_result" | "user";
  content: string;
}

export interface HaConversationRequest {
  conversation_id?: string;
  user_id?: string;
  user_name?: string;
  language?: string;
  agent_id?: string;
  device_id?: string;
  device_info?: { name?: string; manufacturer?: string; model?: string };
  messages: HaMessage[];
  query: string;
  exposed_entities?: HaExposedEntity[];
  system_prompt?: string;
  stream?: boolean;
}
