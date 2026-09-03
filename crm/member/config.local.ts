// member/config.local.ts
// Business-specific configuration. Edited by the member (or by the skill
// /configurar-mi-chatbot). NEVER overwritten on template update.
//
// This is a stub with placeholder values. The skill (or the CLI --flags) fills
// it with the real business. A deploy with unresolved placeholders is blocked
// by scripts/forja-preflight.mjs.
import type { CommentFunnel } from "../src/channels/comment-funnel";

export const memberConfig = {
  businessName: "TuSystem",
  botName: "Asistente de TuSystem",
  language: "es" as "es" | "en",
  tier: "pro" as "free" | "pro",
  timezone: "Europe/Madrid",
  contactEmail: "soporte@tusystem.es",
};

export type MemberConfig = typeof memberConfig;

// Business context consumed by src/businessContext.ts to render the
// <business_context> section of the system prompt. Edit freely.
export const businessConfig = {
  hours:
    "El bot atiende por chat 24/7. El equipo humano se contacta por correo y mediante cita previamente concertada.",
  // Sin precios fijos: se cotiza a medida según el alcance de cada proyecto
  // (ver customFields.precios). No forzar aquí un price numérico inventado.
  services: [] as { name: string; price: number }[],
  location: "Remoto (sin oficina de atención al público).",
  paymentMethods: [] as string[],
  contactPhone: "+34 641414390",
  customFields: {
    telefonoAlternativo: "+34 641525560",
    queHacemos:
      "Automatizamos procesos clave para pymes: captación y cualificación de leads, integración de WhatsApp con CRM, sincronización de datos (tienda, hojas de cálculo, contabilidad) y email marketing automatizado.",
    servicios:
      "Captación de leads; Integración WhatsApp-CRM; Sincronización de datos; Email marketing automatizado.",
    precios:
      "A medida según el alcance del proyecto. No se cotiza un precio cerrado por chat: el bot debe ofrecer agendar una llamada de diagnóstico para preparar una propuesta.",
    sitioWebYRedes: "https://tusystem.es",
    preguntasFrecuentes:
      "¿Cuánto cuesta? Depende del alcance del proyecto; agenda una llamada de diagnóstico gratuita y te preparamos una propuesta a medida. | " +
      "¿Cuánto tarda la implementación? Varía según la automatización; en la llamada de diagnóstico te damos un tiempo estimado. | " +
      "¿Necesito conocimientos técnicos? No, nosotros nos encargamos de toda la implementación técnica.",
    reglasYEscalacion:
      "No inventar precios, plazos ni información que no esté confirmada. Ante cualquier duda o falta de información, derivar la conversación a una persona del equipo en lugar de improvisar una respuesta.",
  } as Record<string, string>,
};

// Product catalog consumed by src/tools/catalogQuery.ts (Pro tier).
// Member fills via skill. Example:
//   { name: "Pan dulce", price: 25, description: "Concha tradicional", sku: "PD-01" }
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];

// Comment-funnel rules consumed by src/channels/comment-funnel.ts (IG/FB comment
// auto-reply → DM). Empty = feature off. Member/skill fills if desired.
export const commentFunnels: CommentFunnel[] = [];
