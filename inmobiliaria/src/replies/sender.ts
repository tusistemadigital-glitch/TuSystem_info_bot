import type { ChannelAdapter, ChannelId, InlineButton, ReplyButton, ReplyMedia } from "../channels/shared";
import { BUTTON_CHANNELS, INLINE_BUTTON_CHANNELS, MEDIA_CHANNELS } from "../channels/shared";
import type { Env } from "../env";
import { telegramAdapter } from "../channels/telegram";
import { webAdapter } from "../channels/web";
import { manychatAdapter } from "../channels/manychat";
import { twilioAdapter } from "../channels/twilio";
import { metaAdapter } from "../channels/meta";
import { whatsappAdapter } from "../channels/whatsapp";
import { kapsoAdapter } from "../channels/kapso";
import { ycloudAdapter } from "../channels/ycloud";
import { zernioAdapter } from "../channels/zernio";

const MIN_DELAY_MS = 800;
const MAX_DELAY_MS = 1500;
const MS_PER_CHAR = 30;

// Human-like inter-chunk delay: proportional to chunk length (~30ms/char),
// clamped to [800, 1500]ms so replies feel typed, not dumped.
export function chunkDelayMs(chunk: string): number {
  const proportional = chunk.length * MS_PER_CHAR;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, proportional));
}

// ── Botones (opt-in, ver skill/botones.md) ───────────────────────────────────
// El modelo puede terminar su respuesta con el marcador
//   [[botones: Sí, agendar | Ver precios | Otra duda]]
// (se le enseña en el prompt SOLO si buttons_enabled está prendido, pero el
// parser siempre lo honra — así un prompt override también puede usarlo).
// Máx 3 opciones, títulos a 20 chars (límite de WhatsApp). En canales sin
// soporte nativo el marcador se convierte en lista numerada — jamás se ve crudo.

const MARCADOR_RE = /\[\[\s*(?:botones|buttons)\s*:\s*([^\]]+)\]\]/gi;

export function extraeBotones(chunks: string[]): { chunks: string[]; buttons?: ReplyButton[] } {
  let buttons: ReplyButton[] | undefined;
  const limpios = chunks
    .map((c) => {
      let out = c;
      for (const m of c.matchAll(MARCADOR_RE)) {
        // Si el modelo mandara dos marcadores, el último gana.
        const titulos = m[1]
          .split("|")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 3);
        if (titulos.length) {
          buttons = titulos.map((t) => ({ title: t.slice(0, 20), payload: `btn:${t.slice(0, 40)}` }));
        }
        out = out.replace(m[0], "");
      }
      return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    })
    .filter((c) => c.length > 0);
  return { chunks: limpios, buttons };
}

function botonesATexto(buttons: ReplyButton[]): string {
  return buttons.map((b, i) => `${i + 1}) ${b.title}`).join("\n");
}

// ── Confirmación de citas con botones inline REALES (Sí/No) ─────────────────
// El modelo termina su respuesta con [[confirmar_visita: <confirmationId>]]
// (lo pone solicitarConfirmacionCancelar/Mover/CambiarVendedor en
// src/tools/inmobiliariaVisitas.ts). A diferencia de [[botones: …]], el tap
// de ESTOS botones NO vuelve como texto — dispara un callback_query que
// src/index.ts atiende aparte, ejecutando la acción sin pasar por el LLM.
// En canales sin callback_query nativo (INLINE_BUTTON_CHANNELS) el marcador
// simplemente se limpia: el texto ya trae la pregunta en palabras, el
// cliente responde "sí"/"no" y el modelo llama confirmarAccionPendiente.

// Mismo charset amplio que confirmMarkerGuard.ts (el id real es un UUID, pero
// esto no debe fallar en extraer/limpiar el marcador aunque el contenido no
// tenga esa forma — la validez del id la decide ese guard, no este parser).
const CONFIRM_VISITA_RE = /\[\[\s*confirmar_visita\s*:\s*([^\]\r\n]{1,500}?)\s*\]\]/gi;

export function extraeConfirmarVisita(chunks: string[]): { chunks: string[]; confirmationId?: string } {
  let confirmationId: string | undefined;
  const limpios = chunks
    .map((c) => {
      let out = c;
      for (const m of c.matchAll(CONFIRM_VISITA_RE)) {
        confirmationId = m[1];
        out = out.replace(m[0], "");
      }
      return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    })
    .filter((c) => c.length > 0);
  return { chunks: limpios, confirmationId };
}

// ── Galería (superpoder, ver skill/galeria.md) ───────────────────────────────
// El modelo referencia un archivo del negocio con [[media: img_x…]] / [[media: aud_x…]] / [[media: vid_x…]].
// Igual que botones: se enseña en el prompt solo con la Galería prendida, pero el
// parser SIEMPRE limpia el marcador — nunca llega crudo al cliente.

// Con caption opcional: [[media: img_x7k2m9q4fp | Aquí vive la sección]]
const MEDIA_MARCADOR_RE = /\[\[\s*media\s*:\s*((?:img|aud|vid)_[a-z0-9]{8,12})\s*(?:\|([^\]]{1,400}?))?\s*\]\]/gi;
const MAX_MEDIA_POR_RESPUESTA = 3;

export interface MediaPedida {
  id: string;
  caption?: string;
}

/** Extrae los media pedidos (dedupeados por id, máx 3, con caption opcional)
 *  y limpia los marcadores del texto. */
export function extraeMediaIds(chunks: string[]): { chunks: string[]; medias: MediaPedida[] } {
  const medias: MediaPedida[] = [];
  const limpios = chunks
    .map((c) => {
      let out = c;
      for (const m of c.matchAll(MEDIA_MARCADOR_RE)) {
        const id = m[1].toLowerCase();
        const caption = (m[2] ?? "").trim().slice(0, 300) || undefined;
        if (!medias.some((x) => x.id === id) && medias.length < MAX_MEDIA_POR_RESPUESTA) {
          medias.push({ id, ...(caption ? { caption } : {}) });
        }
        out = out.replace(m[0], "");
      }
      return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    })
    .filter((c) => c.length > 0);
  return { chunks: limpios, medias };
}

// ── Fotos directas por URL (ej. inventario de propiedades en Google Sheets) ──
// A diferencia de [[media: img_x…]] (catálogo pre-subido al panel), estas
// URLs vienen DIRECTO de la fuente de datos del negocio (una hoja de Sheets,
// consultada por una tool este mismo turno) — no hay nada que "registrar" de
// antemano, así que no pasan por SettingsRepo ni por ningún id: la URL misma
// ES el dato. Existe porque sin esto, el modelo solo podía poner el link como
// texto/markdown — el cliente lo veía como un enlace clicable, no como una
// foto adjunta.

// Con caption opcional: [[foto: https://ejemplo.com/casa.jpg | Fachada]]
const FOTO_MARCADOR_RE = /\[\[\s*foto\s*:\s*(https:\/\/[^\s\]|]{1,600})\s*(?:\|([^\]]{1,300}?))?\s*\]\]/gi;
const MAX_FOTOS_POR_RESPUESTA = 3;

/** Extrae las fotos por URL directa (dedupeadas, máx 3, con caption opcional)
 *  y limpia los marcadores del texto. Sin resolución async: la URL ya es el dato. */
export function extraeFotosDirectas(chunks: string[]): { chunks: string[]; fotos: ReplyMedia[] } {
  const fotos: ReplyMedia[] = [];
  const limpios = chunks
    .map((c) => {
      let out = c;
      for (const m of c.matchAll(FOTO_MARCADOR_RE)) {
        const url = m[1].trim();
        const caption = (m[2] ?? "").trim().slice(0, 300) || undefined;
        if (!fotos.some((f) => f.url === url) && fotos.length < MAX_FOTOS_POR_RESPUESTA) {
          fotos.push({ kind: "image", url, ...(caption ? { caption } : {}) });
        }
        out = out.replace(m[0], "");
      }
      return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    })
    .filter((c) => c.length > 0);
  return { chunks: limpios, fotos };
}

/**
 * Ids → ReplyMedia con URL pública, validando contra los assets REALES (un id
 * inventado por el modelo se descarta en silencio). Nunca lanza: sin base URL o
 * sin D1, la respuesta sale sin media (el texto siempre viaja).
 */
async function resolverMedia(pedidas: MediaPedida[], env: Env): Promise<ReplyMedia[]> {
  if (!pedidas.length) return [];
  try {
    const [{ selfOrigin }, { Db }, { SettingsRepo }, { MEDIA_META_PREFIX, kindFromId }] =
      await Promise.all([
        import("../lib/self-origin"),
        import("../db/client"),
        import("../db/settings"),
        import("../media-assets"),
      ]);
    const repo = new SettingsRepo(new Db(env.DB));
    // La base URL propia solo hace falta para assets self-hosted; se resuelve
    // perezosa para que un catálogo 100% por URL externa funcione aunque el
    // bot aún no haya aprendido su origin.
    let base: string | null = null;
    const out: ReplyMedia[] = [];
    for (const pedida of pedidas) {
      const { id, caption } = pedida;
      const metaRaw = await repo.get(MEDIA_META_PREFIX + id);
      if (!metaRaw) continue; // id inventado o asset borrado
      const kind = kindFromId(id);
      if (!kind) continue;
      let meta: { mime?: string; url?: string } = {};
      try { meta = JSON.parse(metaRaw); } catch { /* meta rara: defaults */ }
      const externa = typeof meta.url === "string" && /^https:\/\//i.test(meta.url) ? meta.url.trim() : "";
      let url = externa;
      if (!url) {
        if (base === null) base = await selfOrigin(env);
        if (!base) {
          console.warn("[galeria] sin base URL propia (DASHBOARD_BASE_URL/self_origin) — asset self-hosted omitido");
          continue;
        }
        url = `${base}/media/${id}`;
      }
      const voice =
        kind === "audio" &&
        (/audio\/ogg/i.test(meta.mime ?? "") || /\.ogg(\?|$)/i.test(url));
      out.push({ kind, url, ...(voice ? { voice: true } : {}), ...(caption ? { caption } : {}) });
    }
    return out;
  } catch (e) {
    console.error("[galeria] resolverMedia falló:", e);
    return [];
  }
}

export async function sendChunkedReply(
  adapter: ChannelAdapter,
  channel: ChannelId,
  channelUserId: string,
  chunks: string[],
  env: Env,
  interChunkDelayMs?: number,
): Promise<void> {
  // Marcador de botones → OutgoingReply.buttons (canal con soporte) o lista
  // numerada en texto (canal sin soporte). Si el modelo mandó SOLO el marcador,
  // los botones necesitan cuerpo: se usa la lista de títulos como texto base.
  const ext = extraeBotones(chunks);
  // Marcador de confirmación de citas → botones inline REALES (Telegram) o se
  // limpia sin más en el resto (la pregunta ya quedó en el texto). Antes de
  // extraeMediaIds porque comparte el mismo estilo de limpieza de chunks.
  const extConfirm = extraeConfirmarVisita(ext.chunks);
  // Marcador de media → OutgoingReply.media (canal con soporte) o el link en
  // texto (canal sin soporte). Se resuelve contra los assets reales: un id
  // inventado se descarta y el texto sale normal.
  const extMedia = extraeMediaIds(extConfirm.chunks);
  // Marcador de foto por URL directa (inventario en vivo, ej. Google Sheets)
  // — no necesita resolución async, la URL ya es el dato.
  const extFotos = extraeFotosDirectas(extMedia.chunks);
  let finales = extFotos.chunks;
  let media: ReplyMedia[] | undefined;
  const resueltos = [
    ...(extMedia.medias.length ? await resolverMedia(extMedia.medias, env) : []),
    ...extFotos.fotos,
  ].slice(0, MAX_MEDIA_POR_RESPUESTA);
  if (resueltos.length) {
    if (MEDIA_CHANNELS.has(channel)) {
      media = resueltos;
    } else {
      // Fallback: el link (con su caption si trae) pega al final del último
      // chunk — o solo, si no hay texto.
      const links = resueltos.map((m) => (m.caption ? `${m.caption}\n${m.url}` : m.url)).join("\n\n");
      finales = finales.length
        ? [...finales.slice(0, -1), `${finales[finales.length - 1]}\n\n${links}`]
        : [links];
    }
  }
  let buttons = ext.buttons;
  if (buttons) {
    if (!BUTTON_CHANNELS.has(channel)) {
      const lista = botonesATexto(buttons);
      finales = finales.length
        ? [...finales.slice(0, -1), `${finales[finales.length - 1]}\n\n${lista}`]
        : [lista];
      buttons = undefined;
    } else if (!finales.length) {
      finales = [buttons.map((b) => b.title).join(" · ")];
    }
  }
  let inlineButtons: InlineButton[] | undefined;
  if (extConfirm.confirmationId && INLINE_BUTTON_CHANNELS.has(channel)) {
    inlineButtons = [
      { title: "✅ Sí", data: `visitconf:${extConfirm.confirmationId}:yes` },
      { title: "❌ No", data: `visitconf:${extConfirm.confirmationId}:no` },
    ];
  }

  if (!finales.length && !media?.length) return;

  // Default to a human-like, length-proportional pause between chunks.
  const delay =
    interChunkDelayMs ??
    (finales.length > 1 ? chunkDelayMs(finales[0]) : undefined);
  await adapter.sendReply(
    { channel, channelUserId, chunks: finales, interChunkDelayMs: delay, buttons, inlineButtons, media },
    env,
  );
}

export function pickAdapter(channel: ChannelId): ChannelAdapter {
  // `test` reusa el adapter web: sendReply es no-op porque la respuesta ya
  // quedó en `messages` y la app la recoge con GET /api/test-chat/poll.
  if (channel === "web" || channel === "test") return webAdapter;
  if (channel === "telegram") return telegramAdapter;
  if (channel === "manychat") return manychatAdapter;
  if (channel === "twilio") return twilioAdapter;
  if (channel === "whatsapp") return whatsappAdapter;
  if (channel === "kapso") return kapsoAdapter;
  if (channel === "ycloud") return ycloudAdapter;
  if (channel === "zernio") return zernioAdapter;
  if (channel === "messenger" || channel === "instagram") return metaAdapter;
  throw new Error(`unknown channel: ${channel}`);
}
