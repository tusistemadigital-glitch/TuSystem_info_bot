import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { PropertyVisitsRepo, VENDEDORES, type PropertyVisit } from "../db/propertyVisits";
import { resolveNaturalDate, weekdayOf } from "../time/naturalDate";
import { botTimezone } from "../time/dateAnchor";
import { aHora24 } from "./servicios";
import {
  calendarConfigured,
  vendorCalendarId,
  isVendorBusy,
  createCalendarEvent,
  patchCalendarEvent,
  deleteCalendarEvent,
} from "../integrations/googleCalendar";
import { mailerConfigured, sendMail } from "../mailer";
import { composioEnabled, executeComposioTool } from "../integrations/composio";

// Tools de CITAS del nicho inmobiliaria — agendarVisitaPropiedad,
// moverVisitaPropiedad, cancelarVisitaPropiedad. A diferencia de
// registrarVisita (tools/inmobiliaria.ts, sin fecha concreta), estas SÍ
// resuelven fecha/hora en CÓDIGO (nunca confían en que el modelo cuente días
// de la semana — ver src/time/naturalDate.ts) y, si el dueño conectó
// GOOGLE_SERVICE_ACCOUNT_JSON + la agenda del vendedor asignado, crean/mueven/
// cancelan el evento DIRECTO en SU Google Calendar (sin pasar por Composio ni
// por ninguna hoja de cálculo) y validan ahí mismo que no tenga ya una cita.

const DURACION_VISITA_MIN = 30;

/** Horario de atención de la inmobiliaria — L-V 9-14 y 17-20, Sáb 10-14, domingo cerrado.
 *  Coincide con el texto que cita el prompt del giro; si ese horario cambia, actualiza aquí también. */
function dentroDeHorario(fechaIso: string, hora24: string): boolean {
  const dow = weekdayOf(fechaIso); // 0=domingo..6=sábado
  if (dow === 0) return false;
  const franjas = dow === 6 ? [["10:00", "14:00"]] : [["09:00", "14:00"], ["17:00", "20:00"]];
  return franjas.some(([ini, fin]) => hora24 >= ini && hora24 < fin);
}

function addMinutes(hora24: string, minutos: number): string {
  const [h, m] = hora24.split(":").map(Number);
  const total = Math.min(h * 60 + m + minutos, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type EmailEstado = "enviado" | "sin_correo" | "fallo";

/**
 * Manda un correo por Gmail vía Composio (GMAIL_SEND_EMAIL: recipient_email,
 * subject, body — confirmado en docs.composio.dev/toolkits/faq/gmail). Es el
 * camino PRINCIPAL cuando el dueño ya conectó Gmail en Composio (no necesita
 * Resend ni el binding de Cloudflare Email aparte). `true` = enviado.
 */
async function enviarPorComposioGmail(env: Env, to: string, subject: string, body: string): Promise<boolean> {
  if (!composioEnabled(env)) return false;
  const r = await executeComposioTool(env, "GMAIL_SEND_EMAIL", { recipient_email: to, subject, body });
  if (!r.ok) {
    console.warn(`[inmobiliaria] envío por Composio Gmail falló: ${r.error}`);
    return false;
  }
  return true;
}

async function enviarConfirmacion(
  env: Env,
  args: { to?: string; nombre: string; propiedad: string; fechaDisplay: string; hora: string; vendedor: string; telefono?: string },
): Promise<EmailEstado> {
  if (!args.to) return "sin_correo";
  const asunto = `Confirmación de visita - ${args.propiedad} - ${args.fechaDisplay} a las ${args.hora}`;
  const cuerpo = `Hola ${args.nombre},

Tu visita está confirmada para el ${args.fechaDisplay} a las ${args.hora} en ${args.propiedad}.

Vendedor asignado: ${args.vendedor}.
Teléfono de contacto: ${args.telefono ?? "-"}.
ID propiedad: ${args.propiedad}.

Si necesitas cambiar o cancelar, responde a este email o contacta con nosotros.

Saludos,
Equipo de la inmobiliaria`;

  if (await enviarPorComposioGmail(env, args.to, asunto, cuerpo)) return "enviado";
  if (!mailerConfigured(env)) return "fallo";
  const r = await sendMail(env, { to: args.to, subject: asunto, html: cuerpo.replace(/\n/g, "<br>"), text: cuerpo });
  return r.ok ? "enviado" : "fallo";
}

/** Aviso interno al equipo — best-effort, nunca cambia el resultado de la tool. */
async function avisarEquipo(env: Env, resumen: string): Promise<void> {
  if (!env.OWNER_EMAIL) return;
  if (await enviarPorComposioGmail(env, env.OWNER_EMAIL, "Nueva actividad de visitas", resumen)) return;
  if (!mailerConfigured(env)) return;
  try {
    await sendMail(env, { to: env.OWNER_EMAIL, subject: "Nueva actividad de visitas", html: resumen.replace(/\n/g, "<br>"), text: resumen });
  } catch (e) {
    console.warn("[inmobiliaria] aviso al equipo falló:", e);
  }
}

interface VendorPick {
  vendedor: string;
  calendarId?: string;
}

/**
 * Prueba los candidatos EN ORDEN (uno solo si el cliente pidió un vendedor
 * específico) y devuelve el primero libre. Un vendedor sin agenda configurada
 * se trata como "libre" (no hay forma de checar) — degrada, no bloquea.
 * `null` = todos los candidatos con agenda configurada están ocupados.
 */
async function elegirVendedorLibre(
  env: Env,
  candidatos: string[],
  start: string,
  end: string,
  tz: string,
): Promise<VendorPick | null> {
  for (const vendedor of candidatos) {
    const calendarId = vendorCalendarId(env, vendedor);
    if (!calendarId) return { vendedor, calendarId: undefined };
    const estado = await isVendorBusy(env, calendarId, start, end, tz);
    if (!estado.ok) {
      console.warn(`[inmobiliaria] no se pudo consultar disponibilidad de ${vendedor}: ${estado.reason} — se asume libre`);
      return { vendedor, calendarId };
    }
    if (!estado.busy) return { vendedor, calendarId };
  }
  return null;
}

export function agendarVisitaPropiedadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      `Agenda una VISITA NUEVA a una propiedad. La fecha SIEMPRE en las palabras textuales del cliente ` +
      `(ej. "el próximo martes", "mañana") — NUNCA la conviertas tú a AAAA-MM-DD, esta tool tiene su propio ` +
      `calculador de fechas y se equivoca menos que contar días a mano. Vendedores disponibles: ${VENDEDORES.join(", ")} (o "indiferente").`,
    inputSchema: z.object({
      propiedad: z.string().describe("ID o descripción clara de la propiedad a visitar"),
      fecha: z.string().describe('Día TAL COMO LO DIJO el cliente, ej. "el próximo martes", "mañana", "el sábado", "el 3 de septiembre"'),
      hora: z.string().describe("Hora de la visita, ej. '18:00' o '6pm'"),
      vendedor: z.string().optional().describe(`Vendedor preferido (${VENDEDORES.join(", ")}) o "indiferente" si no le importa`),
      nombre: z.string().describe("Nombre de quien visita"),
      telefono: z.string().describe("Teléfono del cliente"),
      clienteEmail: z.string().optional().describe("Correo del cliente, para la confirmación (pídelo siempre antes de llamar esta tool)"),
    }),
    execute: async ({ propiedad, fecha, hora, vendedor, nombre, telefono, clienteEmail }) => {
      const resuelta = resolveNaturalDate(env, fecha);
      if (!resuelta.ok) {
        return {
          ok: false as const,
          error: "fecha_no_entendida" as const,
          message: "No entendí esa fecha. Pídele al cliente un día concreto (ej. 'el próximo martes', 'mañana', o una fecha exacta) y vuelve a intentar.",
        };
      }
      const hora24 = aHora24(hora);
      if (!hora24) {
        return {
          ok: false as const,
          error: "hora_no_entendida" as const,
          message: "No entendí esa hora. Pídele al cliente una hora concreta (ej. '18:00' o '6pm') y vuelve a intentar.",
        };
      }
      if (!dentroDeHorario(resuelta.iso, hora24)) {
        return {
          ok: false as const,
          error: "horario_fuera_rango" as const,
          message: "Esa hora está fuera del horario de atención (L-V 9-14 y 17-20, Sáb 10-14). Pide al cliente otro horario dentro de ese rango.",
        };
      }

      const db = new Db(env.DB);
      const repo = new PropertyVisitsRepo(db);
      const tz = botTimezone(env);
      const start = `${resuelta.iso}T${hora24}:00`;
      const end = `${resuelta.iso}T${addMinutes(hora24, DURACION_VISITA_MIN)}:00`;

      const candidatos = await repo.candidateOrder(vendedor === "indiferente" ? undefined : vendedor);
      const elegido = calendarConfigured(env) ? await elegirVendedorLibre(env, candidatos, start, end, tz) : { vendedor: candidatos[0] };
      if (!elegido) {
        return {
          ok: false as const,
          error: "vendedor_no_disponible" as const,
          message:
            candidatos.length === 1
              ? `${candidatos[0]} ya tiene una cita ese día y hora. Ofrece al cliente otro vendedor o buscar otro horario con ${candidatos[0]}.`
              : "Ningún vendedor está libre en ese horario. Ofrece al cliente otro día u hora.",
        };
      }
      const vendedorFinal = elegido.vendedor;

      let calendarEventId: string | undefined;
      if (elegido.calendarId) {
        const evento = await createCalendarEvent(env, elegido.calendarId, {
          summary: `Visita ${propiedad} — ${nombre}`,
          description: [`Vendedor: ${vendedorFinal}`, `Teléfono: ${telefono}`, clienteEmail ? `Email: ${clienteEmail}` : ""]
            .filter(Boolean)
            .join("\n"),
          startDateTime: start,
          endDateTime: end,
          timeZone: tz,
        });
        if (evento.ok) calendarEventId = evento.eventId;
        else console.warn(`[inmobiliaria] no se pudo crear el evento de calendario: ${evento.reason} — la visita queda registrada sin evento`);
      }

      const visitaId = await repo.create({
        conversationId: getConversationId(),
        propiedad,
        vendedor: vendedorFinal,
        nombre,
        telefono,
        email: clienteEmail,
        fechaIso: resuelta.iso,
        fechaTexto: resuelta.display,
        hora: hora24,
        calendarEventId,
      });

      const emailCliente = await enviarConfirmacion(env, {
        to: clienteEmail,
        nombre,
        propiedad,
        fechaDisplay: resuelta.display,
        hora: hora24,
        vendedor: vendedorFinal,
        telefono,
      });
      await avisarEquipo(
        env,
        `Nueva visita agendada.\nPropiedad: ${propiedad}\nCliente: ${nombre} (${telefono})\nFecha: ${resuelta.display} ${hora24}\nVendedor: ${vendedorFinal}`,
      );

      return {
        ok: true as const,
        visitaId,
        propiedad,
        fecha: resuelta.display,
        hora: hora24,
        vendedor: vendedorFinal,
        enCalendario: Boolean(calendarEventId),
        emailCliente,
      };
    },
  });
}

/** Busca la visita objetivo por conversación + pistas dadas. Nunca adivina entre varias. */
async function buscarVisitaObjetivo(
  repo: PropertyVisitsRepo,
  conversationId: string | null,
  pistas: { propiedad?: string; fechaIso?: string; hora?: string },
): Promise<{ visita: PropertyVisit } | { error: "no_encontrada" | "ambiguo"; candidatas?: PropertyVisit[] }> {
  const candidatas = await repo.findActive(conversationId, pistas);
  if (candidatas.length === 0) return { error: "no_encontrada" };
  if (candidatas.length > 1) return { error: "ambiguo", candidatas };
  return { visita: candidatas[0] };
}

export function moverVisitaPropiedadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Cambia el día/hora de una visita YA agendada. Necesitas los datos EXACTOS de la cita original (fecha, hora, propiedad) para encontrarla — si no los tienes en el historial de ESTA conversación, pídeselos al cliente antes de llamar esta tool. Las 4 fechas/horas SIEMPRE en palabras textuales del cliente, nunca las conviertas tú a AAAA-MM-DD.",
    inputSchema: z.object({
      propiedad: z.string().describe("Propiedad de la cita a mover"),
      fechaActual: z.string().describe('Fecha ACTUAL de la cita, tal como la dijo el cliente, ej. "el viernes 28 de agosto"'),
      horaActual: z.string().describe("Hora ACTUAL de la cita"),
      fechaNueva: z.string().describe('Fecha NUEVA deseada, tal como la dijo el cliente, ej. "el lunes"'),
      horaNueva: z.string().describe("Hora NUEVA deseada"),
    }),
    execute: async ({ propiedad, fechaActual, horaActual, fechaNueva, horaNueva }) => {
      const actual = resolveNaturalDate(env, fechaActual);
      const horaActual24 = actual.ok ? aHora24(horaActual) : null;
      if (!actual.ok || !horaActual24) {
        return {
          ok: false as const,
          error: "no_encontrada" as const,
          message: "No entendí la fecha u hora ACTUAL de la cita. Pídele al cliente que confirme de nuevo fecha, hora y propiedad, y vuelve a intentar.",
        };
      }

      const nueva = resolveNaturalDate(env, fechaNueva);
      const horaNueva24 = nueva.ok ? aHora24(horaNueva) : null;
      if (!nueva.ok || !horaNueva24) {
        return {
          ok: false as const,
          error: "fecha_no_entendida" as const,
          message: "No entendí la fecha u hora NUEVA. Pídele al cliente un día y hora concretos y vuelve a intentar.",
        };
      }
      if (!dentroDeHorario(nueva.iso, horaNueva24)) {
        return {
          ok: false as const,
          error: "horario_fuera_rango" as const,
          message: "Esa hora nueva está fuera del horario de atención (L-V 9-14 y 17-20, Sáb 10-14). Pide otro horario.",
        };
      }

      const db = new Db(env.DB);
      const repo = new PropertyVisitsRepo(db);
      const encontrada = await buscarVisitaObjetivo(repo, getConversationId(), {
        propiedad,
        fechaIso: actual.iso,
        hora: horaActual24,
      });
      if ("error" in encontrada) {
        return {
          ok: false as const,
          error: encontrada.error,
          message:
            encontrada.error === "ambiguo"
              ? "Hay más de una cita que coincide. Pregúntale al cliente cuál es exactamente antes de mover ninguna."
              : "No encuentro esa cita con los datos que me dan. Pídele al cliente que confirme de nuevo fecha, hora y propiedad.",
        };
      }
      const visita = encontrada.visita;
      const tz = botTimezone(env);
      const nuevoStart = `${nueva.iso}T${horaNueva24}:00`;
      const nuevoEnd = `${nueva.iso}T${addMinutes(horaNueva24, DURACION_VISITA_MIN)}:00`;
      const calendarId = vendorCalendarId(env, visita.vendedor);

      if (calendarId) {
        const estado = await isVendorBusy(env, calendarId, nuevoStart, nuevoEnd, tz);
        if (estado.ok && estado.busy) {
          return {
            ok: false as const,
            error: "vendedor_no_disponible" as const,
            message: `${visita.vendedor} ya tiene otra cita en ese horario nuevo. Ofrece al cliente otro vendedor o buscar otro horario con ${visita.vendedor}.`,
          };
        }
        if (!estado.ok) {
          console.warn(`[inmobiliaria] no se pudo consultar disponibilidad de ${visita.vendedor} al mover: ${estado.reason} — se asume libre`);
        }
      }

      let calendarEventId = visita.calendar_event_id ?? undefined;
      if (calendarEventId && calendarId) {
        const r = await patchCalendarEvent(env, calendarId, calendarEventId, {
          startDateTime: nuevoStart,
          endDateTime: nuevoEnd,
          timeZone: tz,
        });
        if (!r.ok) {
          console.error(`[inmobiliaria] no se pudo mover el evento de calendario ${calendarEventId}: ${r.reason}`);
          return {
            ok: false as const,
            error: "calendar_failed" as const,
            message: "No pude mover el evento en el calendario. NO confirmes el cambio todavía — avisa que lo estás revisando y usa handoffHuman si insiste.",
          };
        }
      }

      await repo.markMoved(visita.id, { fechaIso: nueva.iso, fechaTexto: nueva.display, hora: horaNueva24, calendarEventId });

      const emailCliente = await enviarConfirmacion(env, {
        to: visita.email ?? undefined,
        nombre: visita.nombre,
        propiedad: visita.propiedad,
        fechaDisplay: nueva.display,
        hora: horaNueva24,
        vendedor: visita.vendedor,
        telefono: visita.telefono ?? undefined,
      });
      await avisarEquipo(
        env,
        `Visita movida.\nPropiedad: ${visita.propiedad}\nCliente: ${visita.nombre}\nNueva fecha: ${nueva.display} ${horaNueva24}\nVendedor: ${visita.vendedor}`,
      );

      return {
        ok: true as const,
        propiedad: visita.propiedad,
        fecha: nueva.display,
        hora: horaNueva24,
        vendedor: visita.vendedor,
        emailCliente,
      };
    },
  });
}

export function cancelarVisitaPropiedadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "CANCELA una visita ya agendada. Dale los datos que el cliente recuerde (propiedad, fecha y/o hora) para encontrarla — si hay varias que coinciden o ninguna, esta tool te lo dice; NUNCA canceles ni afirmes que cancelaste sin un ok:true de esta tool.",
    inputSchema: z.object({
      propiedad: z.string().optional().describe("Propiedad de la cita a cancelar, si el cliente la dio"),
      fecha: z.string().optional().describe("Fecha de la cita tal como la dijo el cliente, si la dio"),
      hora: z.string().optional().describe("Hora de la cita, si la dio"),
    }),
    execute: async ({ propiedad, fecha, hora }) => {
      const fechaIso = fecha ? (() => { const r = resolveNaturalDate(env, fecha); return r.ok ? r.iso : undefined; })() : undefined;
      const horaResuelta = hora ? aHora24(hora) ?? undefined : undefined;

      const db = new Db(env.DB);
      const repo = new PropertyVisitsRepo(db);
      const encontrada = await buscarVisitaObjetivo(repo, getConversationId(), { propiedad, fechaIso, hora: horaResuelta });
      if ("error" in encontrada) {
        return {
          ok: false as const,
          error: encontrada.error,
          candidatas: encontrada.candidatas?.map((v) => `${v.propiedad} · ${v.fecha_texto} ${v.hora}`),
          message:
            encontrada.error === "ambiguo"
              ? "Hay más de una cita que coincide. Muéstrale la lista al cliente y pregúntale cuál quiere cancelar."
              : "No encuentro ninguna cita con esos datos. NO afirmes que cancelaste nada; pídele al cliente los datos exactos de su cita.",
        };
      }
      const visita = encontrada.visita;

      const calendarId = vendorCalendarId(env, visita.vendedor);
      if (visita.calendar_event_id && calendarId) {
        const r = await deleteCalendarEvent(env, calendarId, visita.calendar_event_id);
        if (!r.ok) {
          console.error(`[inmobiliaria] no se pudo cancelar el evento de calendario ${visita.calendar_event_id}: ${r.reason}`);
          return {
            ok: false as const,
            error: "calendar_failed" as const,
            message: "No pude cancelar el evento en el calendario. NO confirmes la cancelación todavía — avisa que lo estás revisando y usa handoffHuman si insiste.",
          };
        }
      }

      await repo.markCancelled(visita.id);
      await avisarEquipo(env, `Visita cancelada.\nPropiedad: ${visita.propiedad}\nCliente: ${visita.nombre}\nEra: ${visita.fecha_texto} ${visita.hora}`);

      return { ok: true as const, propiedad: visita.propiedad, fecha: visita.fecha_texto, hora: visita.hora };
    },
  });
}
