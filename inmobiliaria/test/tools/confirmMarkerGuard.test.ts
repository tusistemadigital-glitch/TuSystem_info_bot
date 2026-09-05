import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { PendingVisitConfirmationsRepo } from "../../src/db/pendingVisitConfirmations";
import { guardVisitConfirmationMarker } from "../../src/tools/confirmMarkerGuard";

let env: any;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = { DB: d1 };
});

describe("guardVisitConfirmationMarker", () => {
  it("sin marcador, deja la respuesta intacta", async () => {
    const r = await guardVisitConfirmationMarker(env, convId, "Hola, ¿en qué te ayudo?");
    expect(r).toEqual({ finalText: "Hola, ¿en qué te ayudo?", blocked: false });
  });

  it("con un id REAL, pendiente, de esta conversación, deja la respuesta intacta", async () => {
    const id = await new PendingVisitConfirmationsRepo(new Db(env.DB)).create({
      conversationId: convId,
      action: "cancelar",
      args: {},
      resumen: "¿Confirmas?",
    });
    const texto = `¿Confirmas?\n\n[[confirmar_visita: ${id}]]`;
    const r = await guardVisitConfirmationMarker(env, convId, texto);
    expect(r).toEqual({ finalText: texto, blocked: false });
  });

  it("con un id FABRICADO (no existe en la BD) — bloquea con un mensaje seguro", async () => {
    const r = await guardVisitConfirmationMarker(env, convId, '¿Confirmas que quieres cancelar?\n\n[[confirmar_visita: conf_3]]');
    expect(r.blocked).toBe(true);
    expect(r.finalText).not.toContain("confirmar_visita");
    expect(r.finalText).not.toContain("conf_3");
  });

  it("con un id fabricado en base64 (con '/' y '=', fuera del charset de un UUID) — TAMBIÉN bloquea", async () => {
    // Visto en vivo: el modelo, en vez de llamar la tool real, inventó un
    // "id" codificando en base64 un JSON con los datos de la cita — con
    // caracteres ('/', '=') que un regex ajustado solo a UUIDs no capturaba,
    // dejando pasar el marcador crudo sin que este guard lo viera siquiera.
    const idFabricado =
      "eyJhY3Rpb24iOiAiY2FuY2VsYXIiLCAicHJvcGllZGFkIjogIklEIDM0OTUiLCAiY29uZmlybWF0aW9uSWQiOiAiY2MvY2VsXzM0OTVfMTAwMCJ9";
    const r = await guardVisitConfirmationMarker(env, convId, `x\n\n[[confirmar_visita: ${idFabricado}]]`);
    expect(r.blocked).toBe(true);
    expect(r.finalText).not.toContain("confirmar_visita");
  });

  it("con un id que existe pero ya fue resuelto — bloquea (evita reabrir una confirmación muerta)", async () => {
    const repo = new PendingVisitConfirmationsRepo(new Db(env.DB));
    const id = await repo.create({ conversationId: convId, action: "mover", args: {}, resumen: "x" });
    await repo.resolve(id, "confirmada");
    const r = await guardVisitConfirmationMarker(env, convId, `x\n\n[[confirmar_visita: ${id}]]`);
    expect(r.blocked).toBe(true);
  });

  it("con un id que existe pero es de OTRA conversación — bloquea", async () => {
    const otraConv = await new ConversationsRepo(new Db(env.DB)).getOrCreate("telegram", "u2");
    const id = await new PendingVisitConfirmationsRepo(new Db(env.DB)).create({
      conversationId: otraConv.id,
      action: "cambiarVendedor",
      args: {},
      resumen: "x",
    });
    const r = await guardVisitConfirmationMarker(env, convId, `x\n\n[[confirmar_visita: ${id}]]`);
    expect(r.blocked).toBe(true);
  });
});
