// member/config.local.ts
// Business-specific configuration. Edited by the member (or by the skill
// /configurar-mi-chatbot). NEVER overwritten on template update.
//
// This is a stub with placeholder values. The skill (or the CLI --flags) fills
// it with the real business. A deploy with unresolved placeholders is blocked
// by scripts/forja-preflight.mjs.
import type { CommentFunnel } from "../src/channels/comment-funnel";

export const memberConfig = {
  businessName: "Inmobiliaria TuSystem",
  botName: "Asistente de Inmobiliaria TuSystem",
  language: "es" as "es" | "en",
  tier: "pro" as "free" | "pro",
  timezone: "America/Mexico_City",
  contactEmail: "contacto@inmobiliariatusystem.example",
};

export type MemberConfig = typeof memberConfig;

// Business context consumed by src/businessContext.ts to render the
// <business_context> section of the system prompt. Edit freely.
export const businessConfig = {
  hours: "Lun-Vie 9am-7pm. Sábado 10am-3pm. Domingo solo visitas agendadas.",
  // En bienes raíces el precio de cada operación casi nunca es fijo (depende
  // de la propiedad): las comisiones van en 0 y la política real vive en la
  // KB (comisiones-y-costos.md) y se confirma con el asesor.
  services: [
    { name: "Asesoría de compra (sin costo)", price: 0 },
    { name: "Asesoría de renta (sin costo)", price: 0 },
    { name: "Comisión por venta (% sobre precio)", price: 0 },
    { name: "Comisión por renta (1 mes de renta)", price: 0 },
    { name: "Avalúo comercial", price: 1500 },
  ] as { name: string; price: number }[],
  location: "Av. Reforma 123, Col. Centro, Ciudad de México.",
  paymentMethods: ["transferencia", "depósito", "cheque", "efectivo"],
  contactPhone: "+52 55 5555 5555",
  customFields: {
    zonasQueCubrimos: "Centro, Polanco, Del Valle, Zona Norte (ejemplo — ajusta a tu mercado)",
    tiposDePropiedad: "casas, departamentos, terrenos, locales comerciales, oficinas",
    operaciones: "venta y renta",
    comisionDeVenta: "5% + IVA sobre el precio de venta (estándar; confirma con el dueño)",
    comisionDeRenta: "equivalente a 1 mes de renta",
    trabajamosConCreditos: "Infonavit, Fovissste, bancario y cofinanciamiento",
    moneda: "MXN",
    preguntasFrecuentes:
      "¿Cuánto cuesta una visita? Sin costo, solo agenda con tu asesor. | " +
      "¿Puedo comprar con crédito? Sí, trabajamos con Infonavit, Fovissste, bancario y cofinanciamiento. | " +
      "¿Negocian el precio de las propiedades? Eso lo ve directo el asesor, caso por caso.",
    reglasYEscalacion:
      "Nunca inventar precios de propiedades, comisiones ni disponibilidad que no esté en el catálogo o la KB. " +
      "Ante negociación de precio, comisión especial o un caso fuera de lo común, escalar a un asesor humano.",
  } as Record<string, string>,
};

// Product catalog consumed by src/tools/catalogQuery.ts (Pro tier).
// Demo de inventario — reemplaza con las propiedades reales del negocio.
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [
  {
    name: "Casa en Del Valle — 3 recámaras",
    price: 4200000,
    description: "Venta. Casa de 2 pisos, 3 recámaras, 2.5 baños, 180 m2, cochera para 2 autos.",
    sku: "CASA-DV-01",
  },
  {
    name: "Departamento en Polanco — 2 recámaras",
    price: 25000,
    description: "Renta. Depa de 90 m2, 2 recámaras, 2 baños, amenidades (gym, roof garden).",
    sku: "DEPA-POL-02",
  },
  {
    name: "Terreno en Zona Norte — 500 m2",
    price: 1800000,
    description: "Venta. Terreno plano, uso de suelo habitacional, listo para construir.",
    sku: "TERR-ZN-03",
  },
  {
    name: "Local comercial en Centro — 60 m2",
    price: 15000,
    description: "Renta. Planta baja, alto tránsito peatonal, baño y bodega.",
    sku: "LOCAL-CT-04",
  },
  {
    name: "Departamento en Del Valle — 1 recámara",
    price: 2650000,
    description: "Venta. Depa de estreno, 55 m2, 1 recámara, 1 baño, balcón.",
    sku: "DEPA-DV-05",
  },
];

// Comment-funnel rules consumed by src/channels/comment-funnel.ts (IG/FB comment
// auto-reply → DM). Empty = feature off. Member/skill fills if desired.
export const commentFunnels: CommentFunnel[] = [];
