/**
 * Orquestrador: carrega o prompt de sistema (fonte única em prompts/), expõe o contrato
 * de ferramentas ao modelo via function calling da OpenAI, e executa o loop de conversa.
 *
 * Este módulo NÃO decide política de negócio — isso vive inteiramente no prompt de
 * sistema. O código aqui só garante mecânica segura: schema de ferramentas, dispatch,
 * e repasse de resultados de volta ao modelo.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import { TOOL_DESCRIPTIONS, dispatchTool, type AgentContext, type ToolName } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "movidesk-agent-system-prompt.md");

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";
/**
 * Alguns modelos de raciocínio (ex: a série gpt-5.x) recusam function calling em
 * /v1/chat/completions quando "reasoning" está ativo — a API responde 400 pedindo para
 * usar /v1/responses OU setar reasoning_effort como 'none'. Como nem todo modelo aceita
 * este parâmetro, ele só é enviado se `OPENAI_REASONING_EFFORT` estiver definido no
 * ambiente (ver .env.example). Valores aceitos pela API:
 * none | minimal | low | medium | high | xhigh | max.
 */
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || undefined;

let cachedSystemPrompt: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = await readFile(SYSTEM_PROMPT_PATH, "utf8");
  }
  return cachedSystemPrompt;
}

// Schemas JSON (formato "function calling" da OpenAI) para cada ferramenta. A validação
// de verdade acontece dentro de dispatchTool (zod) — isto aqui só orienta o modelo.
const TOOL_PARAMETERS: Record<ToolName, Record<string, unknown>> = {
  get_authenticated_user: { type: "object", properties: {}, additionalProperties: false },
  find_movidesk_contact_by_email: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
    additionalProperties: false,
  },
  search_ad_users: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    required: ["query"],
    additionalProperties: false,
  },
  list_customer_organizations: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    additionalProperties: false,
  },
  movidesk_search_organizations: {
    type: "object",
    properties: { query: { type: "string" }, top: { type: "integer" } },
    required: ["query"],
    additionalProperties: false,
  },
  list_known_services: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer" } },
    additionalProperties: false,
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
    additionalProperties: false,
  },
  movidesk_get_ticket: {
    type: "object",
    properties: {
      id: { type: "integer" },
      select: { type: "array", items: { type: "string" } },
      expand: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  movidesk_get_ticket_by_protocol: {
    type: "object",
    properties: {
      protocol: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      expand: { type: "string" },
    },
    required: ["protocol"],
    additionalProperties: false,
  },
  movidesk_get_ticket_action_html: {
    type: "object",
    properties: {
      id: { type: "integer" },
      protocol: { type: "string" },
      action_id: { type: "integer" },
    },
    additionalProperties: false,
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
    additionalProperties: false,
  },
  movidesk_search_tickets_past: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      orderby: { type: "string" },
      top: { type: "integer" },
      skip: { type: "integer" },
    },
    required: ["filter", "select"],
    additionalProperties: false,
  },
  movidesk_search_tickets_exhaustive: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      source: { type: "string", enum: ["current", "past"] },
      page_size: { type: "integer" },
      max_pages: { type: "integer" },
      only_open: { type: "boolean" },
    },
    required: ["filter", "select"],
    additionalProperties: false,
  },
  export_tickets_to_excel: {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object" } },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { header: { type: "string" }, key: { type: "string" } },
          required: ["header", "key"],
        },
      },
      filename_hint: { type: "string" },
    },
    required: ["rows", "filename_hint"],
    additionalProperties: false,
  },
  export_tickets_search_to_excel: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      source: { type: "string", enum: ["current", "past"] },
      page_size: { type: "integer" },
      max_pages: { type: "integer" },
      only_open: { type: "boolean" },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { header: { type: "string" }, key: { type: "string" } },
          required: ["header", "key"],
        },
      },
      filename_hint: { type: "string" },
    },
    required: ["filter", "select", "filename_hint"],
    additionalProperties: false,
  },
  export_tickets_to_pdf: {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object" } },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { header: { type: "string" }, key: { type: "string" }, width: { type: "number" } },
          required: ["header", "key"],
        },
      },
      filename_hint: { type: "string" },
      title: { type: "string" },
    },
    required: ["rows", "filename_hint"],
    additionalProperties: false,
  },
  export_tickets_search_to_pdf: {
    type: "object",
    properties: {
      filter: { type: "string" },
      select: { type: "array", items: { type: "string" } },
      source: { type: "string", enum: ["current", "past"] },
      page_size: { type: "integer" },
      max_pages: { type: "integer" },
      only_open: { type: "boolean" },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { header: { type: "string" }, key: { type: "string" }, width: { type: "number" } },
          required: ["header", "key"],
        },
      },
      filename_hint: { type: "string" },
      title: { type: "string" },
    },
    required: ["filter", "select", "filename_hint"],
    additionalProperties: false,
  },
  movidesk_create_ticket: {
    type: "object",
    properties: {
      idempotency_key: { type: "string" },
      payload: { type: "object" },
      return_all_properties: { type: "boolean" },
    },
    required: ["idempotency_key", "payload"],
    additionalProperties: false,
  },
  movidesk_patch_ticket: {
    type: "object",
    properties: {
      id: { type: "integer" },
      payload: { type: "object" },
      intent: { type: "string" },
    },
    required: ["id", "payload", "intent"],
    additionalProperties: false,
  },
  movidesk_get_person: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
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
    additionalProperties: false,
  },
  movidesk_get_service: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
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
    additionalProperties: false,
  },
};

function buildTools(): ChatCompletionTool[] {
  return (Object.keys(TOOL_DESCRIPTIONS) as ToolName[]).map((name) => ({
    type: "function",
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: TOOL_PARAMETERS[name],
    },
  }));
}

export class MovideskAgentSession {
  private readonly client: OpenAI;
  private readonly tools: ChatCompletionTool[];
  private messages: ChatCompletionMessageParam[] = [];
  private systemLoaded = false;

  constructor(private readonly ctx: AgentContext) {
    this.client = new OpenAI(); // lê OPENAI_API_KEY do ambiente
    this.tools = buildTools();
  }

  private async ensureSystemPrompt(): Promise<void> {
    if (this.systemLoaded) return;
    const system = await loadSystemPrompt();
    this.messages.unshift({ role: "system", content: system });
    this.systemLoaded = true;
  }

  /** Envia uma mensagem do usuário e roda o loop de function-calling até obter uma resposta final em texto. */
  async send(userText: string): Promise<string> {
    await this.ensureSystemPrompt();
    this.messages.push({ role: "user", content: userText });

    // Limite de segurança para não entrar em loop infinito de tool-calls.
    for (let round = 0; round < 20; round++) {
      const response = await this.client.chat.completions.create({
        model: MODEL,
        messages: this.messages,
        tools: this.tools,
        ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT as ReasoningEffort } : {}),
      });

      const choice = response.choices[0];
      if (!choice?.message) {
        return "O modelo não retornou nenhuma resposta.";
      }

      this.messages.push(choice.message);

      const toolCalls = choice.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return choice.message.content ?? "";
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const toolName = call.function.name as ToolName;
        let parsedArgs: unknown;
        try {
          parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Erro: argumentos inválidos (JSON malformado): ${String(err)}`,
          });
          continue;
        }

        try {
          const result = await dispatchTool(toolName, parsedArgs, this.ctx);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Erro: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    return "Não consegui concluir dentro do limite de passos de ferramenta. Tente reformular a solicitação.";
  }
}
