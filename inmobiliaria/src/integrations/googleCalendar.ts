import type { Env } from "../env";
import { VENDEDORES, type Vendedor } from "../db/propertyVisits";

// Cliente directo de Google Calendar API v3 para las tools de visitas de
// inmobiliaria (agendarVisitaPropiedad, moverVisitaPropiedad,
// cancelarVisitaPropiedad) — SIN pasar por Composio. Usa un service account
// (GOOGLE_SERVICE_ACCOUNT_JSON, base64 del JSON que descargas en Google Cloud
// Console). CADA VENDEDOR tiene SU PROPIA agenda (GOOGLE_CALENDAR_ID_<VENDEDOR>),
// compartida con el service account con permiso "Realizar cambios en los
// eventos" — así el bot valida disponibilidad y agenda/mueve/cancela en la
// agenda real de quien atiende la visita, sin depender de ninguna hoja de
// cálculo para saber quién está libre.
//
// Flujo: firma un JWT (RS256) con la private_key del service account, lo
// cambia por un access_token OAuth2 (grant_type jwt-bearer), y llama la API
// REST de Calendar con ese Bearer. El access_token se cachea en memoria del
// isolate (dura ~1h) para no pedir uno nuevo en cada tool call.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { accessToken: string; expiresAt: number; clientEmail: string } | null = null;

const VENDOR_CALENDAR_ENV: Record<Vendedor, keyof Env> = {
  Diego: "GOOGLE_CALENDAR_ID_DIEGO",
  Alfonso: "GOOGLE_CALENDAR_ID_ALFONSO",
  Ismael: "GOOGLE_CALENDAR_ID_ISMAEL",
};

/** ID del calendario de ESE vendedor, o undefined si no está configurado. */
export function vendorCalendarId(env: Env, vendedor: string): string | undefined {
  const key = VENDOR_CALENDAR_ENV[vendedor as Vendedor];
  const id = key ? (env[key] as string | undefined) : undefined;
  return id?.trim() || undefined;
}

/** ¿Hay al menos UN vendedor con agenda configurada? (service account + su calendario). */
export function calendarConfigured(env: Env): boolean {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return false;
  return VENDEDORES.some((v) => Boolean(vendorCalendarId(env, v)));
}

function parseServiceAccount(base64Json: string): ServiceAccountJson | null {
  try {
    const json = atob(base64Json);
    const obj = JSON.parse(json) as Partial<ServiceAccountJson>;
    if (!obj.client_email || !obj.private_key) return null;
    return obj as ServiceAccountJson;
  } catch {
    return null;
  }
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

/** PEM ("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n") -> DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(sa: ServiceAccountJson): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** Access token OAuth2 para el service account, cacheado en memoria del isolate. */
async function getAccessToken(env: Env): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  if (!sa) return { ok: false, reason: "service_account_invalido" };

  if (cachedToken && cachedToken.clientEmail === sa.client_email && cachedToken.expiresAt > Date.now() + 30_000) {
    return { ok: true, token: cachedToken.accessToken };
  }

  try {
    const jwt = await signJwt(sa);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!res.ok) {
      console.error(`[google-calendar] token http_${res.status} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) return { ok: false, reason: "sin_access_token" };
    cachedToken = {
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      clientEmail: sa.client_email,
    };
    return { ok: true, token: body.access_token };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  /** ISO local sin zona, ej. "2026-09-01T18:00:00" — se combina con timeZone. */
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
}

export type CalendarResult =
  | { ok: true; eventId: string; htmlLink?: string }
  | { ok: false; reason: string };

async function callCalendarApi(
  env: Env,
  calendarId: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<CalendarResult | { ok: true; empty: true }> {
  const auth = await getAccessToken(env);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  try {
    const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      console.error(`[google-calendar] ${method} ${path} http_${res.status} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    if (method === "DELETE") return { ok: true, empty: true };
    const data = (await res.json()) as { id: string; htmlLink?: string };
    return { ok: true, eventId: data.id, htmlLink: data.htmlLink };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/**
 * ¿El vendedor ya tiene algo agendado en su calendario en ese rango?
 * Usa freeBusy (un solo request, sin listar eventos completos). `timeZone`
 * deja mandar las horas LOCALES tal cual (sin convertir a offset UTC a mano).
 */
/**
 * Convierte una hora LOCAL de pared en `timeZone` (ej. "2026-09-08T18:00:00"
 * en "Europe/Madrid") a un instante UTC real (con "Z"). A diferencia de
 * events.insert/patch (que sí aceptan {dateTime, timeZone} por separado),
 * la API freeBusy EXIGE que timeMin/timeMax vengan en RFC3339 completo con
 * offset — mandarle la hora local pelada devuelve 400 "Bad Request".
 */
function zonedTimeToUtcIso(localDateTime: string, timeZone: string): string {
  const asIfUtc = new Date(`${localDateTime}Z`);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(asIfUtc)) p[part.type] = part.value;
  // "24" a medianoche en formato de 24h sin AM/PM: normaliza a 0.
  const hour = Number(p.hour) % 24;
  const readingAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  const offsetMs = asIfUtc.getTime() - readingAsUtc;
  return new Date(asIfUtc.getTime() + offsetMs).toISOString();
}

export async function isVendorBusy(
  env: Env,
  calendarId: string,
  startDateTime: string,
  endDateTime: string,
  timeZone: string,
): Promise<{ ok: true; busy: boolean } | { ok: false; reason: string }> {
  const auth = await getAccessToken(env);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  try {
    const res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: zonedTimeToUtcIso(startDateTime, timeZone),
        timeMax: zonedTimeToUtcIso(endDateTime, timeZone),
        timeZone,
        items: [{ id: calendarId }],
      }),
    });
    if (!res.ok) {
      console.error(`[google-calendar] freeBusy http_${res.status} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const data = (await res.json()) as { calendars?: Record<string, { busy?: unknown[]; errors?: unknown[] }> };
    const cal = data.calendars?.[calendarId];
    if (cal?.errors?.length) {
      console.error(`[google-calendar] freeBusy errors para ${calendarId}:`, JSON.stringify(cal.errors));
      return { ok: false, reason: "calendar_error" };
    }
    return { ok: true, busy: Boolean(cal?.busy?.length) };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

export async function createCalendarEvent(env: Env, calendarId: string, input: CalendarEventInput): Promise<CalendarResult> {
  // NO se manda `attendees`: un service account sin Domain-Wide Delegation
  // (imposible en una cuenta de Gmail normal, solo existe en Google Workspace)
  // no puede invitar asistentes — Google responde 403 "forbiddenForServiceAccounts"
  // y el evento ni se crea. El email del cliente ya va en la descripción.
  const result = await callCalendarApi(env, calendarId, "POST", "", {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startDateTime, timeZone: input.timeZone },
    end: { dateTime: input.endDateTime, timeZone: input.timeZone },
  });
  return result as CalendarResult;
}

export async function patchCalendarEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  input: Pick<CalendarEventInput, "startDateTime" | "endDateTime" | "timeZone">,
): Promise<CalendarResult> {
  const result = await callCalendarApi(env, calendarId, "PATCH", `/${encodeURIComponent(eventId)}`, {
    start: { dateTime: input.startDateTime, timeZone: input.timeZone },
    end: { dateTime: input.endDateTime, timeZone: input.timeZone },
  });
  return result as CalendarResult;
}

export async function deleteCalendarEvent(
  env: Env,
  calendarId: string,
  eventId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await callCalendarApi(env, calendarId, "DELETE", `/${encodeURIComponent(eventId)}`);
  if (!result.ok) return result;
  return { ok: true };
}
