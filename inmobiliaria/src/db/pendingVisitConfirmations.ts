import { Db } from "./client";

// Repo de confirmaciones pendientes de citas — ver esquema en src/db/schema.sql
// (tabla pending_visit_confirmations). Existe porque el modelo (Haiku) a veces
// confirma cancelar/mover/cambiar vendedor SIN haber llamado la tool real (visto
// en vivo varias veces). En vez de confiar en que el modelo llame la tool
// correcta con los argumentos correctos, el flujo de citas "peligrosas" ahora
// es: 1) el modelo pide confirmación (guarda aquí los argumentos YA resueltos),
// 2) la ejecución real solo pasa por el tap de un botón inline (Telegram
// callback_query, sin LLM de por medio) o por confirmarAccionPendiente — nunca
// por el modelo reconstruyendo argumentos de memoria.

export type PendingVisitAction = "cancelar" | "mover" | "cambiarVendedor";
export type PendingVisitStatus = "pendiente" | "confirmada" | "rechazada";

export interface PendingVisitConfirmation {
  id: string;
  conversation_id: string;
  action: PendingVisitAction;
  args: string; // JSON — argumentos exactos para ejecutarCancelarVisita/ejecutarMoverVisita/ejecutarCambiarVendedorVisita
  resumen: string;
  status: PendingVisitStatus;
  created_at: number;
  resolved_at: number | null;
}

export class PendingVisitConfirmationsRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    conversationId: string;
    action: PendingVisitAction;
    args: unknown;
    resumen: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO pending_visit_confirmations (id, conversation_id, action, args, resumen, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pendiente', ?)`,
      [id, input.conversationId, input.action, JSON.stringify(input.args ?? {}), input.resumen, Date.now()],
    );
    return id;
  }

  async get(id: string): Promise<PendingVisitConfirmation | null> {
    return this.db.first<PendingVisitConfirmation>(`SELECT * FROM pending_visit_confirmations WHERE id = ?`, [id]);
  }

  /** Marca resuelta (confirmada/rechazada) — idempotente: si ya no está "pendiente", no hace nada. */
  async resolve(id: string, status: "confirmada" | "rechazada"): Promise<boolean> {
    const row = await this.get(id);
    if (!row || row.status !== "pendiente") return false;
    await this.db.run(`UPDATE pending_visit_confirmations SET status = ?, resolved_at = ? WHERE id = ?`, [
      status,
      Date.now(),
      id,
    ]);
    return true;
  }
}
