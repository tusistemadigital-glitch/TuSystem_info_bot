import { describe, it, expect } from "vitest";
import { calendarConfigured, vendorCalendarId } from "../../src/integrations/googleCalendar";

describe("calendarConfigured", () => {
  it("false sin GOOGLE_SERVICE_ACCOUNT_JSON", () => {
    expect(calendarConfigured({ GOOGLE_CALENDAR_ID_DIEGO: "diego@group.calendar.google.com" } as any)).toBe(false);
  });

  it("false con GOOGLE_SERVICE_ACCOUNT_JSON pero SIN ninguna agenda de vendedor", () => {
    expect(calendarConfigured({ GOOGLE_SERVICE_ACCOUNT_JSON: "eyJ9" } as any)).toBe(false);
  });

  it("true con GOOGLE_SERVICE_ACCOUNT_JSON y AL MENOS una agenda de vendedor", () => {
    expect(
      calendarConfigured({ GOOGLE_SERVICE_ACCOUNT_JSON: "eyJ9", GOOGLE_CALENDAR_ID_DIEGO: "diego@group.calendar.google.com" } as any),
    ).toBe(true);
    expect(
      calendarConfigured({ GOOGLE_SERVICE_ACCOUNT_JSON: "eyJ9", GOOGLE_CALENDAR_ID_ISMAEL: "ismael@group.calendar.google.com" } as any),
    ).toBe(true);
  });
});

describe("vendorCalendarId", () => {
  const env = {
    GOOGLE_CALENDAR_ID_DIEGO: "diego@group.calendar.google.com",
    GOOGLE_CALENDAR_ID_ALFONSO: "alfonso@group.calendar.google.com",
  } as any;

  it("devuelve el calendario configurado de ese vendedor", () => {
    expect(vendorCalendarId(env, "Diego")).toBe("diego@group.calendar.google.com");
    expect(vendorCalendarId(env, "Alfonso")).toBe("alfonso@group.calendar.google.com");
  });

  it("undefined si ese vendedor no tiene agenda configurada", () => {
    expect(vendorCalendarId(env, "Ismael")).toBeUndefined();
  });

  it("undefined para un nombre que no es uno de los 3 vendedores", () => {
    expect(vendorCalendarId(env, "Roberto")).toBeUndefined();
  });
});
