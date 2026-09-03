// member/config.local.ts
// Business-specific configuration. Edited by the member (or by the skill
// /configurar-mi-chatbot). NEVER overwritten on template update.
//
// This is a stub with placeholder values. The skill (or the CLI --flags) fills
// it with the real business. A deploy with unresolved placeholders is blocked
// by scripts/forja-preflight.mjs.
import type { CommentFunnel } from "../src/channels/comment-funnel";

export const memberConfig = {
  businessName: "Mi Negocio",
  botName: "Asistente",
  language: "es" as "es" | "en",
  tier: "pro" as "free" | "pro",
  timezone: "America/Mexico_City",
  contactEmail: "contacto@minegocio.example",
};

export type MemberConfig = typeof memberConfig;

// Business context consumed by src/businessContext.ts to render the
// <business_context> section of the system prompt. Edit freely.
export const businessConfig = {
  hours: "",
  services: [] as { name: string; price: number }[],
  location: "",
  paymentMethods: [] as string[],
  contactPhone: "",
  customFields: {
    // member can add any string keys
  } as Record<string, string>,
};

// Product catalog consumed by src/tools/catalogQuery.ts (Pro tier).
// Member fills via skill. Example:
//   { name: "Pan dulce", price: 25, description: "Concha tradicional", sku: "PD-01" }
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];

// Comment-funnel rules consumed by src/channels/comment-funnel.ts (IG/FB comment
// auto-reply → DM). Empty = feature off. Member/skill fills if desired.
export const commentFunnels: CommentFunnel[] = [];
