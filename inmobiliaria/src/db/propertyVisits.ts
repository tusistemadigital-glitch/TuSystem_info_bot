import { Db } from "./client";

// Repo de visitas a propiedades (nicho inmobiliaria) — ver esquema en
// src/db/schema.sql (tabla property_visits). Separado de leads.ts porque
// estas SÍ tienen fecha/hora resueltas y (opcional) un evento real de Google
// Calendar que hay que poder mover/cancelar por su id.

export const VENDEDORES = ["Diego", "Alfonso", "Ismael"] as const;
export type Vendedor = (typeof VENDEDORES)[number];

export interface PropertyVisit {
  id: string;
  conversation_id: string | null;
  propiedad: string;
  vendedor: string;
  nombre: string;
  telefono: string | null;
  email: string | null;
  fecha_iso: string;
  fecha_texto: string;
  hora: string;
  calendar_event_id: string | null;
  status: "confirmada" | "movida" | "cancelada";
  created_at: number;
  updated_at: number;
}

export interface CreatePropertyVisitInput {
  conversationId: string | null;
  propiedad: string;
  vendedor: string;
  nombre: string;
  telefono?: string;
  email?: string;
  fechaIso: string;
  fechaTexto: string;
  hora: string;
  calendarEventId?: string;
}

export class PropertyVisitsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Orden de candidatos a probar para asignar vendedor:
   *  - si el cliente pidió uno de los 3 nombres (case-insensitive), es el
   *    ÚNICO candidato — nunca se le asigna otro sin que él lo acepte
   *    (ver REGLA DE VENDEDOR del prompt del giro).
   *  - si no tiene preferencia, los 3 en orden rotado por el total de visitas
   *    activas ya registradas (reparto justo) — el caller (la tool) prueba
   *    cada uno en Google Calendar hasta encontrar uno libre.
   */
  async candidateOrder(preferido?: string): Promise<string[]> {
    if (preferido) {
      const match = VENDEDORES.find((v) => v.toLowerCase() === preferido.trim().toLowerCase());
      if (match) return [match];
    }
    const row = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) as n FROM property_visits WHERE status != 'cancelada'`,
    );
    const n = row?.n ?? 0;
    const start = n % VENDEDORES.length;
    return [...VENDEDORES.slice(start), ...VENDEDORES.slice(0, start)];
  }

  async create(input: CreatePropertyVisitInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO property_visits
        (id, conversation_id, propiedad, vendedor, nombre, telefono, email,
         fecha_iso, fecha_texto, hora, calendar_event_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmada', ?, ?)`,
      [
        id,
        input.conversationId,
        input.propiedad,
        input.vendedor,
        input.nombre,
        input.telefono ?? null,
        input.email ?? null,
        input.fechaIso,
        input.fechaTexto,
        input.hora,
        input.calendarEventId ?? null,
        now,
        now,
      ],
    );
    return id;
  }

  /**
   * Busca visitas ACTIVAS (no canceladas) de esta conversación que coincidan
   * con propiedad/fecha/hora dados (los que el cliente recuerde) — usado por
   * moverVisitaPropiedad/cancelarVisitaPropiedad para NUNCA adivinar cuál.
   * Cualquier filtro vacío no restringe.
   */
  async findActive(
    conversationId: string | null,
    filters: { propiedad?: string; fechaIso?: string; hora?: string },
  ): Promise<PropertyVisit[]> {
    if (!conversationId) return [];
    const rows = await this.db.all<PropertyVisit>(
      `SELECT * FROM property_visits
       WHERE conversation_id = ? AND status != 'cancelada'
       ORDER BY created_at DESC LIMIT 20`,
      [conversationId],
    );
    return rows.filter((r) => {
      if (filters.propiedad && !r.propiedad.toLowerCase().includes(filters.propiedad.toLowerCase())) return false;
      if (filters.fechaIso && r.fecha_iso !== filters.fechaIso) return false;
      if (filters.hora && r.hora !== filters.hora) return false;
      return true;
    });
  }

  async markMoved(id: string, changes: { fechaIso: string; fechaTexto: string; hora: string; calendarEventId?: string | null }): Promise<void> {
    await this.db.run(
      `UPDATE property_visits SET fecha_iso = ?, fecha_texto = ?, hora = ?, calendar_event_id = ?, status = 'movida', updated_at = ? WHERE id = ?`,
      [changes.fechaIso, changes.fechaTexto, changes.hora, changes.calendarEventId ?? null, Date.now(), id],
    );
  }

  async markCancelled(id: string): Promise<void> {
    await this.db.run(`UPDATE property_visits SET status = 'cancelada', updated_at = ? WHERE id = ?`, [Date.now(), id]);
  }

  /** Reasigna el vendedor de una visita (mismo día/hora) — cambiarVendedorVisitaPropiedad. */
  async reassignVendedor(id: string, changes: { vendedor: string; calendarEventId?: string | null }): Promise<void> {
    await this.db.run(
      `UPDATE property_visits SET vendedor = ?, calendar_event_id = ?, updated_at = ? WHERE id = ?`,
      [changes.vendedor, changes.calendarEventId ?? null, Date.now(), id],
    );
  }
}
