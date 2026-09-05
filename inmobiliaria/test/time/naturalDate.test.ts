import { describe, it, expect } from "vitest";
import { resolveNaturalDate, weekdayOf } from "../../src/time/naturalDate";

const env = { BOT_TIMEZONE: "Europe/Madrid" } as any;
// Referencia fija: martes 2026-09-01.
const NOW = new Date("2026-09-01T12:00:00Z");

describe("resolveNaturalDate", () => {
  it("resuelve hoy/mañana/pasado mañana", () => {
    expect(resolveNaturalDate(env, "hoy", NOW)).toMatchObject({ ok: true, iso: "2026-09-01" });
    expect(resolveNaturalDate(env, "mañana", NOW)).toMatchObject({ ok: true, iso: "2026-09-02" });
    expect(resolveNaturalDate(env, "manana", NOW)).toMatchObject({ ok: true, iso: "2026-09-02" });
    expect(resolveNaturalDate(env, "pasado mañana", NOW)).toMatchObject({ ok: true, iso: "2026-09-03" });
  });

  it("resuelve un día de la semana simple a la próxima ocurrencia (incluye hoy)", () => {
    // Hoy es martes: "martes" a secas = hoy.
    expect(resolveNaturalDate(env, "martes", NOW)).toMatchObject({ ok: true, iso: "2026-09-01" });
    // "el sábado" (sin "próximo") = el sábado que viene esta semana.
    expect(resolveNaturalDate(env, "el sábado", NOW)).toMatchObject({ ok: true, iso: "2026-09-05" });
  });

  it('"próximo <día>" SIEMPRE salta al menos una semana, incluso si hoy es ese día', () => {
    const r = resolveNaturalDate(env, "el próximo martes", NOW);
    expect(r).toMatchObject({ ok: true, iso: "2026-09-08" });
    expect((r as any).display).toContain("próximo");
  });

  it('"<día> que viene" se comporta como "próximo <día>"', () => {
    expect(resolveNaturalDate(env, "el martes que viene", NOW)).toMatchObject({ ok: true, iso: "2026-09-08" });
  });

  it("resuelve día + mes en español, con o sin año", () => {
    expect(resolveNaturalDate(env, "el 3 de septiembre", NOW)).toMatchObject({ ok: true, iso: "2026-09-03" });
    expect(resolveNaturalDate(env, "3 de septiembre de 2026", NOW)).toMatchObject({ ok: true, iso: "2026-09-03" });
  });

  it("una fecha día+mes ya pasada este año rueda al año siguiente (nunca al pasado)", () => {
    // 15 de enero ya pasó respecto al 1 de septiembre 2026 → debe caer en 2027.
    const r = resolveNaturalDate(env, "el 15 de enero", NOW);
    expect(r).toMatchObject({ ok: true, iso: "2027-01-15" });
  });

  it("acepta dígitos exactos AAAA-MM-DD y DD/MM/AAAA", () => {
    expect(resolveNaturalDate(env, "2026-09-01", NOW)).toMatchObject({ ok: true, iso: "2026-09-01" });
    expect(resolveNaturalDate(env, "01/09/2026", NOW)).toMatchObject({ ok: true, iso: "2026-09-01" });
  });

  it("resuelve día de semana + fecha explícita combinados (ej. confirmando una cita ya dicha)", () => {
    expect(resolveNaturalDate(env, "el lunes 7 de septiembre", NOW)).toMatchObject({ ok: true, iso: "2026-09-07" });
    expect(resolveNaturalDate(env, "el próximo lunes 7 de septiembre", NOW)).toMatchObject({ ok: true, iso: "2026-09-07" });
    expect(resolveNaturalDate(env, "lunes 7 de septiembre de 2026", NOW)).toMatchObject({ ok: true, iso: "2026-09-07" });
  });

  it("con día de semana + fecha combinados, la fecha explícita manda aunque el día de semana esté mal dicho", () => {
    // El 7 de septiembre de 2026 es lunes, no martes — la fecha exacta gana.
    expect(resolveNaturalDate(env, "el martes 7 de septiembre", NOW)).toMatchObject({ ok: true, iso: "2026-09-07" });
  });

  it("no adivina frases que no entiende", () => {
    expect(resolveNaturalDate(env, "la semana que viene", NOW)).toEqual({ ok: false });
    expect(resolveNaturalDate(env, "no sé, cuando puedan", NOW)).toEqual({ ok: false });
  });

  it("repite EXACTO en `display` una frase citable (ej. 'el próximo martes 8 de septiembre')", () => {
    const r = resolveNaturalDate(env, "el próximo martes", NOW) as any;
    expect(r.display).toBe("el próximo martes 8 de septiembre");
  });
});

describe("weekdayOf", () => {
  it("calcula el día de la semana (0=domingo) de una fecha YYYY-MM-DD", () => {
    expect(weekdayOf("2026-09-01")).toBe(2); // martes
    expect(weekdayOf("2026-09-05")).toBe(6); // sábado
    expect(weekdayOf("2026-09-06")).toBe(0); // domingo
  });
});
