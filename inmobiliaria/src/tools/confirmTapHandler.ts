import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { PendingVisitConfirmationsRepo } from "../db/pendingVisitConfirmations";
import {
  ejecutarCancelarVisita,
  ejecutarMoverVisita,
  ejecutarCambiarVendedorVisita,
  type EjecutarCancelarVisitaArgs,
  type EjecutarMoverVisitaArgs,
  type EjecutarCambiarVendedorVisitaArgs,
} from "./inmobiliariaVisitas";

// Resuelve el tap de un botón de confirmación de citas (Sí/No) SIN pasar por
// el LLM — el camino determinista que existe porque Haiku confirmaba
// cancelar/mover/cambiar vendedor sin haber llamado nunca la tool real
// (visto en vivo repetidas veces; el Blindaje lo atrapaba, pero la cita
// nunca cambiaba de verdad). Lo llama SOLO el handler de callback_query de
// Telegram (src/index.ts) — nunca el agente del chat normal.

/**
 * Ejecuta (o descarta) la confirmación pendiente y devuelve el texto a
 * mandarle al cliente. Persiste ambos lados (el tap y el resultado) como
 * mensajes normales, para que el hilo en el dashboard se lea completo.
 */
export async function resolverConfirmacionPendiente(
  env: Env,
  confirmationId: string,
  decision: "yes" | "no",
): Promise<string> {
  const db = new Db(env.DB);
  const repo = new PendingVisitConfirmationsRepo(db);
  const msgs = new MessagesRepo(db);
  const pending = await repo.get(confirmationId);

  if (!pending) {
    return "Esta confirmación ya no está disponible (puede que haya caducado). Pídele al bot que lo intente de nuevo.";
  }

  await msgs.append(pending.conversation_id, "user", decision === "yes" ? "[botón] Sí" : "[botón] No");

  if (pending.status !== "pendiente") {
    const texto = "Esta confirmación ya se había resuelto antes.";
    await msgs.append(pending.conversation_id, "assistant", texto);
    return texto;
  }

  if (decision === "no") {
    await repo.resolve(confirmationId, "rechazada");
    const texto = "De acuerdo, no hice ningún cambio.";
    await msgs.append(pending.conversation_id, "assistant", texto);
    return texto;
  }

  const resuelto = await repo.resolve(confirmationId, "confirmada");
  if (!resuelto) {
    // Carrera con el flujo de texto (confirmarAccionPendiente) — rarísimo,
    // pero no hay que ejecutar dos veces.
    const texto = "Esta confirmación ya se había resuelto antes.";
    await msgs.append(pending.conversation_id, "assistant", texto);
    return texto;
  }

  const args = JSON.parse(pending.args);
  const getConversationId = () => pending.conversation_id;
  let resultado: { ok: boolean; message?: string; [k: string]: unknown };
  if (pending.action === "cancelar") {
    resultado = await ejecutarCancelarVisita(env, getConversationId, args as EjecutarCancelarVisitaArgs);
  } else if (pending.action === "mover") {
    resultado = await ejecutarMoverVisita(env, getConversationId, args as EjecutarMoverVisitaArgs);
  } else {
    resultado = await ejecutarCambiarVendedorVisita(env, getConversationId, args as EjecutarCambiarVendedorVisitaArgs);
  }

  const texto = formatearResultado(pending.action, resultado);
  await msgs.append(pending.conversation_id, "assistant", texto);
  return texto;
}

function formatearResultado(action: string, r: { ok: boolean; message?: string; [k: string]: unknown }): string {
  if (!r.ok) {
    return typeof r.message === "string" ? r.message : "No se pudo completar la acción. Contacta con el equipo si el problema sigue.";
  }
  const emailNota = r.emailCliente === "enviado" ? " Te envié la confirmación por email." : "";
  if (action === "cancelar") {
    return `Tu visita a ${r.propiedad} el ${r.fecha} a las ${r.hora} ha sido cancelada ✅.`;
  }
  if (action === "mover") {
    return `Tu visita quedó movida ✅ para el ${r.fecha} a las ${r.hora} en ${r.propiedad}.${emailNota}`;
  }
  return `Listo ✅ tu visita del ${r.fecha} a las ${r.hora} en ${r.propiedad} ahora es con ${r.vendedor}.${emailNota}`;
}
