/**
 * Configuração conhecida deste tenant (VIASOFT / Movidesk).
 *
 * Estes valores foram confirmados por código local e chamados reais (ver seção 6 do
 * prompt de sistema em prompts/movidesk-agent-system-prompt.md). São a ÚNICA fonte de
 * verdade para IDs de serviço/campo/regra — o agente nunca deve inventar ou "lembrar"
 * esses números; ele chama `get_flow_config(flow_name)`, que lê daqui.
 *
 * Antes de alterar um valor em produção, compare com ao menos um chamado recente correto
 * do mesmo fluxo. Uma mudança aqui é uma mudança de comportamento confirmado do tenant —
 * trate como tal (revisão, não só merge).
 */

export type FlowName =
  | "comite_ia"
  | "voors_escola_negocios"
  | "oracle_cloud"
  | "gcc"
  | "sistemas_internos";

/** Campo adicional comum de classificação, usado por múltiplos fluxos. */
export const CLASSIFICATION_FIELD = {
  customFieldId: 23946,
  customFieldRuleId: 11397,
  /** Opções confirmadas para este campo. Não envie um valor fora desta lista. */
  options: ["Suporte Técnico"] as const,
};

export interface CustomFieldRef {
  customFieldId: number;
  customFieldRuleId: number;
}

export interface FlowConfig {
  flow: FlowName;
  label: string;
  serviceFirstLevelId: number | "dynamic";
  serviceFull: string[] | "dynamic";
  ownerTeam: string;
  contactForm?: string;
  /** Regra (customFieldRuleId) do formulário do fluxo, quando aplicável. */
  formRuleId?: number;
  /**
   * Categoria nativa do Movidesk (propriedade `category`, não confundir com o campo
   * adicional de classificação). `"omit"` significa: NÃO envie `category` no payload —
   * comportamento confirmado neste tenant para evitar
   * "There is no match for the Category value entered".
   */
  nativeCategory: string | "omit" | "dynamic";
  /** Campos adicionais específicos do fluxo, com anotação de uso (value vs items). */
  customFields: Record<string, CustomFieldRef & { usage: "value" | "items"; options?: readonly string[] }>;
  /** Notas de comportamento confirmado que não cabem em um campo estruturado. */
  notes: string[];
}

export const TENANT_FLOWS: Record<FlowName, FlowConfig> = {
  comite_ia: {
    flow: "comite_ia",
    label: "Comitê de IA",
    serviceFirstLevelId: 1171844,
    serviceFull: ["Comitê de IA"],
    ownerTeam: "VIASOFT - Comitê de IA",
    contactForm: "Comitê de IA - VIASOFT",
    formRuleId: 96221,
    nativeCategory: "omit",
    customFields: {
      departamento: { customFieldId: 187763, customFieldRuleId: 96221, usage: "value" },
      ferramentasIa: { customFieldId: 187764, customFieldRuleId: 96221, usage: "value" },
      origemExemplosDados: { customFieldId: 187765, customFieldRuleId: 96221, usage: "value" },
    },
    notes: [
      'Omitir "category". Enviar category="Suporte Técnico" retornou ' +
        '"There is no match for the Category value entered". Sem a propriedade, o chamado ' +
        "foi criado e a categoria foi aplicada automaticamente depois.",
    ],
  },

  voors_escola_negocios: {
    flow: "voors_escola_negocios",
    label: "Voors Escola de Negócios",
    serviceFirstLevelId: 991087,
    serviceFull: ["HOK Cursos"],
    ownerTeam: "VIASOFT - HOK",
    contactForm: "Voors Escola de Negócios",
    formRuleId: 88153,
    nativeCategory: "omit",
    customFields: {
      liberacaoParaQuem: {
        customFieldId: 174020,
        customFieldRuleId: 88153,
        usage: "items",
        options: ["Cliente Implantação", "Cliente Trilha do Supervisor - CS", "Colaborador Viasoft"] as const,
      },
      clienteOuColaborador: { customFieldId: 174021, customFieldRuleId: 88153, usage: "value" },
      nomeDoCurso: { customFieldId: 174023, customFieldRuleId: 88153, usage: "value" },
    },
    notes: [
      "Para as opções de cliente, buscar na lista local de organizações e gravar a razão " +
        "social (já inclui o código do cliente quando disponível).",
      'Para "Colaborador Viasoft", buscar no Active Directory e gravar o nome do colaborador ' +
        'no campo "clienteOuColaborador" (174021); incluir usuário e e-mail apenas na descrição.',
      "Omitir a propriedade nativa category — deixar o serviço/formulário aplicar o padrão.",
    ],
  },

  oracle_cloud: {
    flow: "oracle_cloud",
    label: "Oracle Cloud",
    serviceFirstLevelId: 561055,
    serviceFull: ["Oracle Cloud"],
    ownerTeam: "VIASOFT - Suporte Oracle Cloud",
    nativeCategory: "Suporte Técnico",
    customFields: {
      tipoDeAtendimento: { customFieldId: 219375, customFieldRuleId: 114796, usage: "value" },
      colaborador: { customFieldId: 219376, customFieldRuleId: 114797, usage: "value" },
      supervisor: { customFieldId: 219377, customFieldRuleId: 114797, usage: "value" },
      ambiente: { customFieldId: 219378, customFieldRuleId: 114797, usage: "value" },
    },
    notes: ["Reutilizar busca de colaboradores do AD e organizações sincronizadas quando o passo exigir."],
  },

  gcc: {
    flow: "gcc",
    label: "GCC — Gestão de Combate ao Churn",
    serviceFirstLevelId: "dynamic",
    serviceFull: "dynamic",
    ownerTeam: "GCC - Gestão de Combate ao Churn",
    nativeCategory: "Controle Interno",
    customFields: {
      classificacao: {
        customFieldId: CLASSIFICATION_FIELD.customFieldId,
        customFieldRuleId: CLASSIFICATION_FIELD.customFieldRuleId,
        usage: "items",
        options: CLASSIFICATION_FIELD.options,
      },
    },
    notes: [
      "Serviço é dinâmico e deve vir do catálogo local sincronizado — não fixar um único ID.",
      "Organizações devem vir da lista local sincronizada.",
    ],
  },

  sistemas_internos: {
    flow: "sistemas_internos",
    label: "Sistemas Internos",
    serviceFirstLevelId: 216138,
    serviceFull: "dynamic",
    ownerTeam: "VIASOFT - Sistemas Internos",
    nativeCategory: "Suporte Técnico",
    customFields: {
      sistema: { customFieldId: 30853, customFieldRuleId: 120040, usage: "value" },
      tipoDeAtendimento: {
        customFieldId: 80757,
        customFieldRuleId: 119983,
        usage: "value",
        options: ["Cadastro de Usuários"] as const,
      },
      departamento: { customFieldId: 97141, customFieldRuleId: 120043, usage: "value" },
      caracteristica: { customFieldId: 180036, customFieldRuleId: 120039, usage: "value" },
      // Cadastro de usuários (regra 120031)
      nome: { customFieldId: 228812, customFieldRuleId: 120031, usage: "value" },
      cpf: { customFieldId: 228809, customFieldRuleId: 120031, usage: "value" },
      email: { customFieldId: 228810, customFieldRuleId: 120031, usage: "value" },
      telefone: { customFieldId: 146385, customFieldRuleId: 120031, usage: "value" },
      empresa: { customFieldId: 113382, customFieldRuleId: 120031, usage: "value" },
      cnpj: { customFieldId: 228945, customFieldRuleId: 120031, usage: "value" },
    },
    notes: [
      'O item "Cadastro de Usuários" no campo de tipo de atendimento implica urgência baixa ' +
        "no fluxo local aprovado.",
    ],
  },
};

export function getFlowConfig(flow: FlowName): FlowConfig {
  const config = TENANT_FLOWS[flow];
  if (!config) {
    throw new Error(`Fluxo desconhecido: "${flow}". Fluxos válidos: ${Object.keys(TENANT_FLOWS).join(", ")}`);
  }
  return config;
}
