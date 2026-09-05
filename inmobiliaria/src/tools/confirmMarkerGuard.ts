import type { Env } from "../env";
import { Db } from "../db/client";
import { PendingVisitConfirmationsRepo } from "../db/pendingVisitConfirmations";

// Guarda determinista (sin LLM) contra un marcador [[confirmar_visita: id]]
// FABRICADO — visto en vivo: el modelo escribió una pregunta de confirmación
// con los datos REALES de la cita (los recordaba bien) pero sin haber llamado
// solicitarConfirmacionCancelar/Mover/CambiarVendedor, copiando literalmente
// el id de ejemplo del few-shot del prompt ("conf_3"). El marcador salió
// crudo al cliente (no correspondía a ninguna fila real) y, aun si no
// hubiera salido crudo, el botón habría sido un callejón sin salida (nada
// que confirmar del lado del servidor).
//
// Esto NO es un juicio de "¿está bien respaldado?" (eso es Blindaje) — es una
// comprobación binaria de que el id existe de verdad, así que corre SIEMPRE,
// sin importar BLINDAJE_MODE ni el tier del bot.

// El id real es un UUID (crypto.randomUUID()), pero esto captura CUALQUIER
// cosa entre los dos puntos y el cierre — visto en vivo: el modelo fabricó un
// "id" en base64 (con '/' y '=', fuera de un charset ajustado a UUIDs) para
// simular algo real. No hay que adivinar qué formato inventará la próxima
// vez: cualquier contenido no vacío que no sea un id real de verdad se
// bloquea igual.
const CONFIRM_MARKER_RE = /\[\[\s*confirmar_visita\s*:\s*([^\]\r\n]{1,500}?)\s*\]\]/i;

const REPLY_FABRICADA =
  "Dame un momento — antes de pedirte que confirmes algo quiero revisar bien los datos de tu cita. Vuelve a decirme qué quieres hacer.";

export interface ConfirmMarkerGuardResult {
  finalText: string;
  blocked: boolean;
}

/**
 * Si `replyText` trae el marcador de confirmación de citas, verifica que el
 * id apunte a una fila real, pendiente, de ESTA conversación. Si no —
 * fabricado, ya resuelta, o de otra conversación — reemplaza TODA la
 * respuesta por un mensaje seguro (no solo el marcador: la pregunta entera
 * puede ser fabricada, no solo el id). Nunca lanza.
 */
export async function guardVisitConfirmationMarker(
  env: Env,
  conversationId: string | null,
  replyText: string,
): Promise<ConfirmMarkerGuardResult> {
  const m = CONFIRM_MARKER_RE.exec(replyText);
  if (!m) return { finalText: replyText, blocked: false };

  const confirmationId = m[1];
  try {
    const pending = await new PendingVisitConfirmationsRepo(new Db(env.DB)).get(confirmationId);
    if (pending && pending.status === "pendiente" && pending.conversation_id === conversationId) {
      return { finalText: replyText, blocked: false };
    }
    console.error(
      `[inmobiliaria] marcador [[confirmar_visita: ${confirmationId}]] no corresponde a una confirmación pendiente real de esta conversación — respuesta bloqueada`,
    );
  } catch (e) {
    console.error("[inmobiliaria] guardVisitConfirmationMarker falló (se bloquea por seguridad):", e);
  }
  return { finalText: REPLY_FABRICADA, blocked: true };
}
