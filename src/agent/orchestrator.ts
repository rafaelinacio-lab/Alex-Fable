/**
 * Orquestrador: carrega o prompt de sistema (fonte única em prompts/), expõe o contrato
 * de ferramentas ao Claude via tool-use, e executa o loop de conversa.
 *
 * Este módulo NÃO decide política de negócio — isso vive inteiramente no prompt de
 * sistema. O código aqui só garante mecânica segura: schema de ferramentas, dispatch,
 * e repasse de resultados de volta ao modelo.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DESCRIPTIONS, dispatchTool, type AgentContext, type ToolName } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "movidesk-agent-system-prompt.md");

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

let cachedSystemPrompt: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = await readFile(SYSTEM_PROMPT_PATH, "utf8");
  }
  return cachedSystemPrompt;
}

// Schemas JSON simplificados para o tool-use da Anthropic API (zod é usado na validação
// real dentro de dispatchTool; aqui só descrevemos a forma para o modelo).
const TOOL_INPUT_SCHEMAS: Record<ToolName, Anthropic.Tool.InputSchema> = {
  get_authenticated_user: { type: "object", properties: {} },
  find_movidesk_contact_by_email: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
  search_ad_users: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    required: ["query"],
  },
  list_customer_organizations: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
  },
  get_flow_config: {
    type: "object",
    properties: {
      flow_name: {
        type: "string",
        enum: ["comite_ia", "voors_escola_negocios", "oracle_cloud", "gcc", "sistemas_internos"],
      },
    },
    required: ["flow_name"],
  },
  movidesk_get_ticket: {
    type: "object",
    properties: {
      id: { type: "integer" },
      select: { type: "array", items: { type: "string" } },
      expand: { type: "string" },
    },
    required: ["id"],
  },
  movidesk_search_tickets: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      orderby: { type: "string" },
      top: { type: "integer" },
      skip: { type: "integer" },
    },
    required: ["filter", "select"],
  },
  movidesk_create_ticket: {
    type: "object",
    properties: {
      idempotency_key: { type: "string" },
      payload: { type: "object" },
      return_all_properties: { type: "boolean" },
    },
    required: ["idempotency_key", "payload"],
  },
  movidesk_patch_ticket: {
    type: "object",
    properties: {
      id: { type: "integer" },
      payload: { type: "object" },
      intent: { type: "string" },
    },
    required: ["id", "payload", "intent"],
  },
  movidesk_get_person: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  movidesk_search_persons: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      orderby: { type: "string" },
      top: { type: "integer" },
      skip: { type: "integer" },
    },
    required: ["filter", "select"],
  },
  movidesk_get_service: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  movidesk_search_services: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      orderby: { type: "string" },
      top: { type: "integer" },
      skip: { type: "integer" },
    },
    required: ["filter", "select"],
  },
};

function buildTools(): Anthropic.Tool[] {
  return (Object.keys(TOOL_DESCRIPTIONS) as ToolName[]).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: TOOL_INPUT_SCHEMAS[name],
  }));
}

export class MovideskAgentSession {
  private readonly client: Anthropic;
  private readonly tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];

  constructor(private readonly ctx: AgentContext) {
    this.client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente
    this.tools = buildTools();
  }

  /** Envia uma mensagem do usuário e roda o loop de tool-use até obter uma resposta final em texto. */
  async send(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const system = await loadSystemPrompt();

    // Limite de segurança para não entrar em loop infinito de tool-calls.
    for (let round = 0; round < 20; round++) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system,
        tools: this.tools,
        messages: this.messages,
      });

      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        return response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const toolName = block.name as ToolName;
        try {
          const result = await dispatchTool(toolName, block.input, this.ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.messages.push({ role: "user", content: toolResults });
    }

    return "Não consegui concluir dentro do limite de passos de ferramenta. Tente reformular a solicitação.";
  }
}
