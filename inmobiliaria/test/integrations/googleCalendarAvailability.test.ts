import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { isVendorBusy, createCalendarEvent } from "../../src/integrations/googleCalendar";

// Genera un par de llaves RSA de verdad (no hace falta que sea de Google: solo
// necesitamos que crypto.subtle.importKey la acepte como PKCS8 válida) para
// poder firmar el JWT real del flujo de auth sin pegarle a la red de Google.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const fakeServiceAccount = {
  client_email: "bot-test@inmobiliaria-tusystem.iam.gserviceaccount.com",
  private_key: privateKey,
};
const env = {
  GOOGLE_SERVICE_ACCOUNT_JSON: btoa(JSON.stringify(fakeServiceAccount)),
} as any;

const CALENDAR_ID = "diego@group.calendar.google.com";

function mockFetchSequence(responses: Array<{ status?: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
}

describe("isVendorBusy", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("busy:true cuando freeBusy devuelve un rango ocupado", async () => {
    global.fetch = mockFetchSequence([
      { body: { access_token: "fake-token", expires_in: 3600 } }, // token exchange
      { body: { calendars: { [CALENDAR_ID]: { busy: [{ start: "2026-09-08T18:00:00Z", end: "2026-09-08T18:30:00Z" }] } } } },
    ]) as any;

    const r = await isVendorBusy(env, CALENDAR_ID, "2026-09-08T18:00:00", "2026-09-08T18:30:00", "Europe/Madrid");
    expect(r).toEqual({ ok: true, busy: true });
  });

  it("busy:false cuando freeBusy no devuelve rangos ocupados", async () => {
    global.fetch = mockFetchSequence([
      { body: { access_token: "fake-token", expires_in: 3600 } },
      { body: { calendars: { [CALENDAR_ID]: { busy: [] } } } },
    ]) as any;

    const r = await isVendorBusy(env, CALENDAR_ID, "2026-09-09T10:00:00", "2026-09-09T10:30:00", "Europe/Madrid");
    expect(r).toEqual({ ok: true, busy: false });
  });
});

describe("createCalendarEvent", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("crea el evento en el calendario del vendedor indicado (no en uno compartido)", async () => {
    let insertedUrl = "";
    let insertedBody: any = null;
    global.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      insertedUrl = String(url);
      insertedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "evt_123", htmlLink: "https://calendar.google.com/evt_123" }), { status: 200 });
    }) as any;

    const r = await createCalendarEvent(env, CALENDAR_ID, {
      summary: "Visita ID 101 — María López",
      startDateTime: "2026-09-08T18:00:00",
      endDateTime: "2026-09-08T18:30:00",
      timeZone: "Europe/Madrid",
    });

    expect(r).toEqual({ ok: true, eventId: "evt_123", htmlLink: "https://calendar.google.com/evt_123" });
    expect(insertedUrl).toContain(encodeURIComponent(CALENDAR_ID));
    expect(insertedBody.attendees).toBeUndefined();
  });
});
