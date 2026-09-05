import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { PropertyVisitsRepo } from "../../src/db/propertyVisits";
import { PendingVisitConfirmationsRepo } from "../../src/db/pendingVisitConfirmations";
import {
  agendarVisitaPropiedadTool,
  solicitarConfirmacionCancelarTool,
  solicitarConfirmacionMoverTool,
  solicitarConfirmacionCambiarVendedorTool,
  confirmarAccionPendienteTool,
} from "../../src/tools/inmobiliariaVisitas";
import { resolverConfirmacionPendiente } from "../../src/tools/confirmTapHandler";

// Prueba el flujo de "pedir confirmación primero, ejecutar después" que
// reemplaza a mover/cancelar/cambiarVendedor directos — Haiku los confirmaba
// sin haberlos llamado de verdad (visto en vivo repetidas veces). Aquí la
// ejecución real solo pasa por confirmarAccionPendiente (cliente responde en
// texto) o resolverConfirmacionPendiente (tap de un botón — nunca por el LLM).

const FECHA_OK = "el próximo martes"; // dentro del horario L-V 9-14/17-20 a las 18:00
const HORA_OK = "18:00";

let env: any;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = { DB: d1, BOT_TIER: "pro", BOT_TIMEZONE: "Europe/Madrid", OWNER_EMAIL: "" };
});

async function agendarBase(vendedor = "Diego") {
  const tool = agendarVisitaPropiedadTool(env, () => convId);
  return tool.execute!(
    { propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, vendedor, nombre: "Ana", telefono: "600" },
    {} as any,
  ) as any;
}

describe("solicitarConfirmacionCancelarTool", () => {
  it("encuentra la visita y devuelve un resumen con el marcador de confirmación", async () => {
    await agendarBase();
    const tool = solicitarConfirmacionCancelarTool(env, () => convId);
    const result = (await tool.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    expect(result.ok).toBe(true);
    expect(result.confirmationId).toBeTruthy();
    expect(result.resumen).toContain("ID 101");
    expect(result.resumen).toContain(`[[confirmar_visita: ${result.confirmationId}]]`);

    const pending = await new PendingVisitConfirmationsRepo(new Db(env.DB)).get(result.confirmationId);
    expect(pending?.action).toBe("cancelar");
    expect(pending?.status).toBe("pendiente");
  });

  it("no_encontrada si no hay ninguna cita que coincida — y NO crea ninguna confirmación pendiente", async () => {
    const tool = solicitarConfirmacionCancelarTool(env, () => convId);
    const result = (await tool.execute!({ propiedad: "ID 999", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_encontrada");
    expect(result.confirmationId).toBeUndefined();
  });
});

describe("solicitarConfirmacionMoverTool", () => {
  it("devuelve un resumen citando la fecha actual y la nueva", async () => {
    await agendarBase();
    const tool = solicitarConfirmacionMoverTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fechaActual: FECHA_OK, horaActual: HORA_OK, fechaNueva: "el sábado", horaNueva: "11:00" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(true);
    expect(result.resumen).toContain("ID 101");
    expect(result.resumen).toContain("sábado");
  });

  it("horario_fuera_rango para la fecha nueva", async () => {
    await agendarBase();
    const tool = solicitarConfirmacionMoverTool(env, () => convId);
    const result = (await tool.execute!(
      { propiedad: "ID 101", fechaActual: FECHA_OK, horaActual: HORA_OK, fechaNueva: "el domingo", horaNueva: "11:00" },
      {} as any,
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("horario_fuera_rango");
  });
});

describe("solicitarConfirmacionCambiarVendedorTool", () => {
  it("devuelve un resumen citando el vendedor actual y el nuevo", async () => {
    await agendarBase("Alfonso");
    const tool = solicitarConfirmacionCambiarVendedorTool(env, () => convId);
    const result = (await tool.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nuevoVendedor: "Diego" }, {} as any)) as any;
    expect(result.ok).toBe(true);
    expect(result.resumen).toContain("Alfonso");
    expect(result.resumen).toContain("Diego");
  });

  it("mismo_vendedor si ya está asignada a ese vendedor", async () => {
    await agendarBase("Diego");
    const tool = solicitarConfirmacionCambiarVendedorTool(env, () => convId);
    const result = (await tool.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nuevoVendedor: "Diego" }, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("mismo_vendedor");
  });

  it("vendedor_invalido si el nombre no es uno de los 3 vendedores", async () => {
    await agendarBase("Diego");
    const tool = solicitarConfirmacionCambiarVendedorTool(env, () => convId);
    const result = (await tool.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK, nuevoVendedor: "Roberto" }, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("vendedor_invalido");
  });
});

describe("confirmarAccionPendienteTool (el cliente responde en TEXTO)", () => {
  it("confirma:true ejecuta la cancelación real (cambia el status en la BD)", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const confirmar = confirmarAccionPendienteTool(env, () => convId);
    const result = (await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: true }, {} as any)) as any;

    expect(result.ok).toBe(true);
    expect(result.propiedad).toBe("ID 101");

    const [visita] = await new PropertyVisitsRepo(new Db(env.DB)).findActive(convId, {});
    expect(visita).toBeUndefined(); // findActive excluye 'cancelada'
  });

  it("confirma:false NO ejecuta nada y marca la confirmación como rechazada", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const confirmar = confirmarAccionPendienteTool(env, () => convId);
    const result = (await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: false }, {} as any)) as any;

    expect(result).toEqual({ ok: true, cancelado: true });
    const [visita] = await new PropertyVisitsRepo(new Db(env.DB)).findActive(convId, {});
    expect(visita.status).toBe("confirmada"); // sigue activa, nada cambió
  });

  it("no_encontrada para un confirmationId inexistente", async () => {
    const confirmar = confirmarAccionPendienteTool(env, () => convId);
    const result = (await confirmar.execute!({ confirmationId: "no-existe", confirma: true }, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_encontrada");
  });

  it("ya_resuelta si se llama dos veces con confirma:true (no ejecuta la acción dos veces)", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const confirmar = confirmarAccionPendienteTool(env, () => convId);
    await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: true }, {} as any);
    const segunda = (await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: true }, {} as any)) as any;

    expect(segunda.ok).toBe(false);
    expect(segunda.error).toBe("ya_resuelta");
  });

  it("no_encontrada si el confirmationId es de OTRA conversación", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const confirmar = confirmarAccionPendienteTool(env, () => "otra-conversacion");
    const result = (await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: true }, {} as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_encontrada");
  });
});

describe("resolverConfirmacionPendiente (tap de botón — sin pasar por el LLM)", () => {
  it("decision 'yes' ejecuta la cancelación real y devuelve un texto de confirmación", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const texto = await resolverConfirmacionPendiente(env, pedido.confirmationId, "yes");
    expect(texto).toContain("cancelada");

    const [visita] = await new PropertyVisitsRepo(new Db(env.DB)).findActive(convId, {});
    expect(visita).toBeUndefined();
  });

  it("decision 'no' no ejecuta nada", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const texto = await resolverConfirmacionPendiente(env, pedido.confirmationId, "no");
    expect(texto).toContain("no hice ningún cambio");

    const [visita] = await new PropertyVisitsRepo(new Db(env.DB)).findActive(convId, {});
    expect(visita.status).toBe("confirmada");
  });

  it("una confirmación ya resuelta (por texto) no se vuelve a ejecutar si además se toca el botón", async () => {
    await agendarBase();
    const solicitar = solicitarConfirmacionCancelarTool(env, () => convId);
    const pedido = (await solicitar.execute!({ propiedad: "ID 101", fecha: FECHA_OK, hora: HORA_OK }, {} as any)) as any;

    const confirmar = confirmarAccionPendienteTool(env, () => convId);
    await confirmar.execute!({ confirmationId: pedido.confirmationId, confirma: true }, {} as any);

    const texto = await resolverConfirmacionPendiente(env, pedido.confirmationId, "yes");
    expect(texto).toContain("ya se había resuelto");
  });

  it("confirmationId inexistente devuelve un mensaje claro, sin lanzar", async () => {
    const texto = await resolverConfirmacionPendiente(env, "no-existe", "yes");
    expect(texto).toContain("no está disponible");
  });
});
