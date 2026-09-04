import { describe, it, expect } from "vitest";
import { calendarConfigured } from "../../src/integrations/googleCalendar";

describe("calendarConfigured", () => {
  it("false sin GOOGLE_SERVICE_ACCOUNT_JSON ni GOOGLE_CALENDAR_ID", () => {
    expect(calendarConfigured({} as any)).toBe(false);
  });

  it("false con solo una de las dos vars", () => {
    expect(calendarConfigured({ GOOGLE_SERVICE_ACCOUNT_JSON: "eyJ9" } as any)).toBe(false);
    expect(calendarConfigured({ GOOGLE_CALENDAR_ID: "primary" } as any)).toBe(false);
  });

  it("true con ambas vars presentes", () => {
    expect(calendarConfigured({ GOOGLE_SERVICE_ACCOUNT_JSON: "eyJ9", GOOGLE_CALENDAR_ID: "primary" } as any)).toBe(true);
  });
});
