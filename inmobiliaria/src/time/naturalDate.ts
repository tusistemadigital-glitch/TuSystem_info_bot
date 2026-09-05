import { botTimezone } from "./dateAnchor";
import type { Env } from "../env";

// Resuelve fechas en lenguaje natural en ESPAÑOL para las tools de visitas de
// inmobiliaria (agendarVisitaPropiedad, moverVisitaPropiedad,
// cancelarVisitaPropiedad). A propósito estas tools NO dejan que el modelo
// resuelva la fecha (ver system prompt del giro): un LLM contando días de la
// semana se equivoca de fecha; este parser es determinista.
//
// Devuelve { ok:false } ante cualquier ambigüedad — el caller NUNCA debe
// adivinar, debe pedirle al cliente un día concreto.

export interface NaturalDateResult {
  ok: true;
  /** YYYY-MM-DD, listo para Date/Calendar. */
  iso: string;
  /** Frase legible para repetírsela al cliente EXACTA, ej. "el próximo martes 1 de septiembre". */
  display: string;
}

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function quitarAcentos(s: string): string {
  // Rango Unicode de "Combining Diacritical Marks" (U+0300–U+036F), explícito
  // por code point para no depender de que el archivo transporte bien los
  // glifos combinantes literales.
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** "YYYY-MM-DD" construido a partir de y/m/d (m: 1-12), ancla a mediodía UTC
 *  para que sumar/restar días nunca cruce un borde de DST. */
function fromYMD(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** "Hoy" (fecha-only, mediodía UTC) en la zona horaria del bot. */
function hoyEnTz(tz: string, now: Date): Date {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = iso.split("-").map(Number);
  return fromYMD(y, m, d);
}

function displayFor(date: Date, prefix: string): string {
  const dow = DIAS_SEMANA[date.getUTCDay()];
  const dia = date.getUTCDate();
  const mes = MESES[date.getUTCMonth()];
  return `${prefix}${dow} ${dia} de ${mes}`.trim();
}

/** Índice de día de semana (0=domingo) a partir de un nombre en español, con o sin acentos. */
function diaSemanaIndex(nombre: string): number | null {
  const n = quitarAcentos(nombre.toLowerCase());
  const idx = DIAS_SEMANA.findIndex((d) => quitarAcentos(d) === n);
  return idx >= 0 ? idx : null;
}

function mesIndex(nombre: string): number | null {
  const n = quitarAcentos(nombre.toLowerCase());
  const idx = MESES.findIndex((m) => quitarAcentos(m) === n);
  return idx >= 0 ? idx : null;
}

/**
 * Resuelve una fecha dicha en lenguaje natural (o ya en dígitos exactos)
 * contra "hoy" en la zona horaria del bot. `now` inyectable para tests.
 */
export function resolveNaturalDate(env: Env, texto: string, now: Date = new Date()): NaturalDateResult | { ok: false } {
  const tz = botTimezone(env);
  const hoy = hoyEnTz(tz, now);
  const t = quitarAcentos(texto.trim().toLowerCase());

  // Dígitos exactos: AAAA-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const fecha = fromYMD(Number(m[1]), Number(m[2]), Number(m[3]));
    if (Number.isNaN(fecha.getTime())) return { ok: false };
    return { ok: true, iso: toIso(fecha), display: displayFor(fecha, "") };
  }

  // Dígitos exactos: DD/MM/AAAA (convención hispana)
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const fecha = fromYMD(Number(m[3]), Number(m[2]), Number(m[1]));
    if (Number.isNaN(fecha.getTime())) return { ok: false };
    return { ok: true, iso: toIso(fecha), display: displayFor(fecha, "") };
  }

  if (t === "hoy") return { ok: true, iso: toIso(hoy), display: displayFor(hoy, "hoy ") };
  if (t === "manana" || t === "mañana") {
    const fecha = addDays(hoy, 1);
    return { ok: true, iso: toIso(fecha), display: displayFor(fecha, "mañana ") };
  }
  if (t === "pasado manana" || t === "pasado mañana") {
    const fecha = addDays(hoy, 2);
    return { ok: true, iso: toIso(fecha), display: displayFor(fecha, "pasado mañana ") };
  }

  // "el 3 de septiembre" / "3 de septiembre de 2026" / "el 3 de septiembre del 2026"
  m = t.match(/^(?:el\s+)?(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?$/);
  if (m) {
    const dia = Number(m[1]);
    const mes = mesIndex(m[2]);
    if (mes === null || dia < 1 || dia > 31) return { ok: false };
    let anio = m[3] ? Number(m[3]) : hoy.getUTCFullYear();
    let fecha = fromYMD(anio, mes + 1, dia);
    if (Number.isNaN(fecha.getTime())) return { ok: false };
    // Sin año explícito y ya pasó este año → año en curso siguiente (nunca al pasado).
    if (!m[3] && fecha.getTime() < hoy.getTime()) {
      anio += 1;
      fecha = fromYMD(anio, mes + 1, dia);
    }
    return { ok: true, iso: toIso(fecha), display: displayFor(fecha, "") };
  }

  // Día de semana + fecha explícita combinados, ej. "el lunes 7 de septiembre"
  // o "el próximo lunes 7 de septiembre de 2026" (frecuente al confirmar una
  // cita que ya se dijo antes). La fecha explícita manda; el nombre del día
  // solo decide el prefijo mostrado, nunca se usa para calcular ni se exige
  // que coincida — si el cliente se equivocó de día de semana, la fecha exacta
  // sigue siendo inequívoca.
  m = t.match(/^(?:el\s+|este\s+)?(proximo\s+|proxima\s+)?([a-z]+)\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?$/);
  if (m && diaSemanaIndex(m[2]) !== null) {
    const dia = Number(m[3]);
    const mes = mesIndex(m[4]);
    if (mes !== null && dia >= 1 && dia <= 31) {
      let anio = m[5] ? Number(m[5]) : hoy.getUTCFullYear();
      let fecha = fromYMD(anio, mes + 1, dia);
      if (!Number.isNaN(fecha.getTime())) {
        if (!m[5] && fecha.getTime() < hoy.getTime()) {
          anio += 1;
          fecha = fromYMD(anio, mes + 1, dia);
        }
        const prefix = m[1] ? "el próximo " : "el ";
        return { ok: true, iso: toIso(fecha), display: displayFor(fecha, prefix) };
      }
    }
  }

  // Día de la semana, con "el"/"este"/"próximo"/"próxima"/"que viene" opcionales.
  m = t.match(/^(?:el\s+|este\s+)?(proximo|proxima)?\s*([a-z]+?)(?:\s+que\s+viene)?$/);
  if (m) {
    const dow = diaSemanaIndex(m[2]);
    if (dow !== null) {
      const esProximo = Boolean(m[1]) || /que\s+viene/.test(t);
      const hoyDow = hoy.getUTCDay();
      let diff = (dow - hoyDow + 7) % 7;
      if (diff === 0 && esProximo) diff = 7;
      const fecha = addDays(hoy, diff);
      const prefix = esProximo ? "el próximo " : diff === 0 ? "hoy " : "el ";
      return { ok: true, iso: toIso(fecha), display: displayFor(fecha, prefix) };
    }
  }

  return { ok: false };
}

/** 0=domingo..6=sábado para una fecha YYYY-MM-DD ya resuelta (fecha-only, sin hora). */
export function weekdayOf(fechaIso: string): number {
  const [y, m, d] = fechaIso.split("-").map(Number);
  return fromYMD(y, m, d).getUTCDay();
}
