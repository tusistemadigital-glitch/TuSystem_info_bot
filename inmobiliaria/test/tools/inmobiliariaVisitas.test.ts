import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { __resetComposioCacheForTests } from "../../src/integrations/composio";
import {
  agendarVisitaPropiedadTool,
  moverVisitaPropiedadTool,
  cancelarVisitaPropiedadTool,
} from "../../src/tools/inmobiliariaVisitas";

// Martes 2026-09-01, dentro del horario L-V 9-14 y 17-20 a las 18:00.
const FECHA_OK = "el próximo martes";
const HORA_OK = "18:00";

let env: any;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  // Sin GOOGLE_SERVICE_ACCOUNT_JSON/GOOGLE_CALENDAR_ID ni mailer: las tools
  // deben seguir funcionando en modo "solo local" y decirlo honestamente.
  env = { DB: d1, BOT_TIER: "pro", BOT_TIMEZONE: "Europe/Madrid", OWNER_EMAIL: "" };
});

describe("agendarVisitaPropiedadTool", () => {
  it("agenda una visita válida sin calendario ni mailer conectados", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      {
        propiedad: "ID 101",
        fecha: FECHA_OK,
        hora: HORA_OK,
        nombre: "María López",
        telefono: "600123456",
      },
      {} as any,
    )) as any;
    expect(result.ok).toBe(true);
    expect(result.propiedad).toBe("ID 101");
    expect(result.hora).toBe("18:00");
    expect(result.enCalendario).toBe(false);
    expect(result.emailCliente).toBe("sin_correo");
    expect(["Diego", "Alfonso", "Ismael"]).toContain(result.vendedor);
  });

  it("respeta el vendedor pedido si es válido", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, vendedor: "Alfonso", nombre: "Ana", telefono: "600" },
      {} as any,
    )) as any;
    expect(result.vendedor).toBe("Alfonso");
  });

  it("con clienteEmail pero sin mailer configurado, emailCliente es 'fallo' (no 'enviado' inventado)", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nombre: "Ana", telefono: "600", clienteEmail: "ana@example.com" },
      {} as any,
    )) as any;
    expect(result.emailCliente).toBe("fallo");
  });

  it("rechaza una fecha que no entiende, sin adivinar", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: "la semana que viene", hora: HORA_OK, nombre: "Ana", telefono: "600" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fecha_no_entendida");
  });

  it("rechaza un horario fuera de rango (L-V 9-14 y 17-20, Sáb 10-14)", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: "16:00", nombre: "Ana", telefono: "600" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("horario_fuera_rango");
  });

  it("rota el vendedor entre Diego/Alfonso/Ismael cuando no hay preferencia", async () => {
    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const vendedores: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await tool.execute!(
        { propiedad: `ID ${i}`, fecha: FECHA_OK, hora: HORA_OK, nombre: "Ana", telefono: "600" },
        {} as any,
      )) as any;
      vendedores.push(r.vendedor);
    }
    expect(vendedores).toEqual(["Diego", "Alfonso", "Ismael"]);
  });
});

describe("moverVisitaPropiedadTool", () => {
  it("mueve una visita existente a fecha/hora nueva", async () => {
    const agendar = agendarVisitaPropiedadTool(env, () => convId);
    await agendar.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nombre: "María López", telefono: "600123456" },
      {} as any,
    );

    const mover = moverVisitaPropiedadTool(env, () => convId);
    const result = (await mover.execute!(
      { propiedad: "ID 101", fechaActual: FECHA_OK, horaActual: HORA_OK, fechaNueva: "el próximo miércoles", horaNueva: "18:00" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(true);
    expect(result.hora).toBe("18:00");
    expect(result.fecha).not.toContain("martes");
  });

  it("no encuentra ni inventa una cita que no existe", async () => {
    const mover = moverVisitaPropiedadTool(env, () => convId);
    // "el próximo lunes" es SIEMPRE día hábil (evita que el test dependa de
    // en qué día de la semana real se corra la suite).
    const result = (await mover.execute!(
      { propiedad: "ID 999", fechaActual: FECHA_OK, horaActual: HORA_OK, fechaNueva: "el próximo lunes", horaNueva: "18:00" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_encontrada");
  });
});

describe("cancelarVisitaPropiedadTool", () => {
  it("cancela una visita existente", async () => {
    const agendar = agendarVisitaPropiedadTool(env, () => convId);
    await agendar.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nombre: "María López", telefono: "600123456" },
      {} as any,
    );

    const cancelar = cancelarVisitaPropiedadTool(env, () => convId);
    const result = (await cancelar.execute!({ propiedad: "ID 101" }, {} as any)) as any;
    expect(result.ok).toBe(true);

    // Cancelar de nuevo la misma (ya cancelada) no debe encontrar nada.
    const otraVez = (await cancelar.execute!({ propiedad: "ID 101" }, {} as any)) as any;
    expect(otraVez.ok).toBe(false);
    expect(otraVez.error).toBe("no_encontrada");
  });

  it("pide desambiguar si hay varias visitas activas que coinciden", async () => {
    const agendar = agendarVisitaPropiedadTool(env, () => convId);
    // Dos días hábiles distintos y fijos ("próximo X" siempre cae Mon-Fri),
    // así el test no depende de en qué día real se corra la suite.
    await agendar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nombre: "Ana", telefono: "600" }, {} as any);
    await agendar.execute!({ propiedad: "ID 102", fecha: "el próximo jueves", hora: "18:00", nombre: "Ana", telefono: "600" }, {} as any);

    const cancelar = cancelarVisitaPropiedadTool(env, () => convId);
    const result = (await cancelar.execute!({}, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ambiguo");
    expect(result.candidatas).toHaveLength(2);
  });
});

describe("agendarVisitaPropiedadTool con Google Calendar conectado", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const fakeServiceAccount = { client_email: "bot-test@x.iam.gserviceaccount.com", private_key: privateKey };
  const DIEGO_CAL = "diego@group.calendar.google.com";

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    env.GOOGLE_SERVICE_ACCOUNT_JSON = btoa(JSON.stringify(fakeServiceAccount));
    env.GOOGLE_CALENDAR_ID_DIEGO = DIEGO_CAL;
  });

  it("no agenda ni confirma si el vendedor pedido ya tiene una cita en Google Calendar (vendedor_no_disponible)", async () => {
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({ access_token: "fake", expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes("/freeBusy")) {
        return new Response(
          JSON.stringify({ calendars: { [DIEGO_CAL]: { busy: [{ start: "x", end: "y" }] } } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as any;

    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, vendedor: "Diego", nombre: "Ana", telefono: "600" },
      {} as any,
    )) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("vendedor_no_disponible");
  });

  it("agenda y crea el evento en la agenda del vendedor cuando está libre", async () => {
    let eventCreated = false;
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/token")) return new Response(JSON.stringify({ access_token: "fake", expires_in: 3600 }), { status: 200 });
      if (u.includes("/freeBusy")) return new Response(JSON.stringify({ calendars: { [DIEGO_CAL]: { busy: [] } } }), { status: 200 });
      if (u.includes(`/calendars/${encodeURIComponent(DIEGO_CAL)}/events`)) {
        eventCreated = true;
        return new Response(JSON.stringify({ id: "evt_1" }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as any;

    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, vendedor: "Diego", nombre: "Ana", telefono: "600" },
      {} as any,
    )) as any;

    expect(result.ok).toBe(true);
    expect(result.enCalendario).toBe(true);
    expect(eventCreated).toBe(true);
  });
});

describe("confirmación por email vía Composio Gmail (sin Resend/Cloudflare Email)", () => {
  const realFetch = global.fetch;
  beforeEach(() => __resetComposioCacheForTests());
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("emailCliente:'enviado' cuando Gmail está conectado en Composio, aunque no haya mailer directo", async () => {
    env.COMPOSIO_API_KEY = "ck_test";
    let sentTo = "";
    let sentSubject = "";
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/connected_accounts")) {
        return new Response(JSON.stringify({ items: [{ id: "ca_gmail_1", user_id: "me", toolkit: { slug: "gmail" } }] }), { status: 200 });
      }
      if (u.includes("/tools?")) {
        return new Response(
          JSON.stringify({ items: [{ slug: "GMAIL_SEND_EMAIL", human_description: "Send an email", toolkit: { slug: "gmail" } }] }),
          { status: 200 },
        );
      }
      if (u.includes("/tools/execute/GMAIL_SEND_EMAIL")) {
        const body = JSON.parse(init.body);
        sentTo = body.arguments.recipient_email;
        sentSubject = body.arguments.subject;
        return new Response(JSON.stringify({ data: { id: "msg_1" }, successful: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as any;

    const tool = agendarVisitaPropiedadTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nombre: "Ana", telefono: "600", clienteEmail: "ana@example.com" },
      {} as any,
    )) as any;

    expect(result.emailCliente).toBe("enviado");
    expect(sentTo).toBe("ana@example.com");
    expect(sentSubject).toContain("ID 101");
  });
});
