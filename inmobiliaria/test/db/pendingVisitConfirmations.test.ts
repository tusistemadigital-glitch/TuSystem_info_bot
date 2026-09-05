import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { PendingVisitConfirmationsRepo } from "../../src/db/pendingVisitConfirmations";

let db: Db;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
});

describe("PendingVisitConfirmationsRepo", () => {
  it("create + get redondea el registro tal cual, con status inicial 'pendiente'", async () => {
    const repo = new PendingVisitConfirmationsRepo(db);
    const id = await repo.create({
      conversationId: convId,
      action: "cancelar",
      args: { propiedad: "ID 101", fecha: "el próximo martes", hora: "18:00" },
      resumen: "¿Confirmas?",
    });

    const row = await repo.get(id);
    expect(row?.status).toBe("pendiente");
    expect(row?.action).toBe("cancelar");
    expect(row?.resolved_at).toBeNull();
    expect(JSON.parse(row!.args)).toEqual({ propiedad: "ID 101", fecha: "el próximo martes", hora: "18:00" });
  });

  it("get devuelve null para un id que no existe", async () => {
    const repo = new PendingVisitConfirmationsRepo(db);
    expect(await repo.get("no-existe")).toBeNull();
  });

  it("resolve marca el status y resolved_at, y devuelve true", async () => {
    const repo = new PendingVisitConfirmationsRepo(db);
    const id = await repo.create({ conversationId: convId, action: "mover", args: {}, resumen: "x" });

    const ok = await repo.resolve(id, "confirmada");
    expect(ok).toBe(true);

    const row = await repo.get(id);
    expect(row?.status).toBe("confirmada");
    expect(row?.resolved_at).not.toBeNull();
  });

  it("resolve es idempotente: la segunda llamada no cambia nada y devuelve false", async () => {
    const repo = new PendingVisitConfirmationsRepo(db);
    const id = await repo.create({ conversationId: convId, action: "cambiarVendedor", args: {}, resumen: "x" });

    await repo.resolve(id, "confirmada");
    const segunda = await repo.resolve(id, "rechazada");
    expect(segunda).toBe(false);

    const row = await repo.get(id);
    expect(row?.status).toBe("confirmada"); // no se pisó con "rechazada"
  });

  it("resolve devuelve false para un id inexistente", async () => {
    const repo = new PendingVisitConfirmationsRepo(db);
    expect(await repo.resolve("no-existe", "confirmada")).toBe(false);
  });
});
