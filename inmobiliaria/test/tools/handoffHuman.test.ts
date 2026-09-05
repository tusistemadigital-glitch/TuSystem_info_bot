import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { handoffHumanTool, handoffNotifyStatus } from "../../src/tools/handoffHuman";
import { __resetComposioCacheForTests } from "../../src/integrations/composio";

let env: any;
let tickets: TicketsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  tickets = new TicketsRepo(db);
  // The tickets table FKs conversation_id -> conversations(id), so we need a
  // real conversation row before the tool can attach a ticket to it.
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = {
    DB: d1,
    OWNER_EMAIL: "hugo@hugohair.com",
    RESEND_API_KEY: "fake_key",
    BUSINESS_NAME: "Hugo Hair",
    DASHBOARD_BASE_URL: "https://dash.test",
    BOT_TIER: "free",
  };
});

describe("handoffHumanTool", () => {
  it("creates a ticket row in D1 even without Resend key", async () => {
    const envNoResend = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoResend, () => convId);
    const result = await tool.execute!(
      {
        reason: "complejo",
        summary: "María pregunta sobre shampoo sin sulfatos",
        category: "product",
      },
      {} as any,
    );
    expect((result as { ticketId: string }).ticketId).toBeTruthy();
    const list = await tickets.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toContain("María");
  });

  describe("aviso al dueño por email vía Composio Gmail (sin Resend)", () => {
    const realFetch = global.fetch;
    beforeEach(() => __resetComposioCacheForTests());
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("handoffNotifyStatus reporta el canal Email cuando hay Composio + OWNER_EMAIL, sin RESEND_API_KEY", () => {
      const envComposio = { ...env, RESEND_API_KEY: undefined, COMPOSIO_API_KEY: "ck_test" };
      const status = handoffNotifyStatus(envComposio);
      expect(status.ok).toBe(true);
      expect(status.channels).toContain("Email");
    });

    it("manda el aviso del ticket por Composio Gmail cuando no hay Resend configurado", async () => {
      const envComposio = { ...env, RESEND_API_KEY: undefined, COMPOSIO_API_KEY: "ck_test" };
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

      const tool = handoffHumanTool(envComposio, () => convId);
      await tool.execute!({ reason: "complejo", summary: "Cliente pide hablar con alguien", category: "other" }, {} as any);

      expect(sentTo).toBe(envComposio.OWNER_EMAIL);
      expect(sentSubject).toContain("complejo");
    });
  });
});
