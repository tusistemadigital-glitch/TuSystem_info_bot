import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramAdapter, resolveTelegramFileUrl, parseCallbackQuery, answerCallbackQuery, clearInlineKeyboard, sendPlainTelegramMessage } from "../../src/channels/telegram";
import type { Env } from "../../src/env";

function makeReq(body: unknown): Request {
  return new Request("https://bot.test/webhooks/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = { TELEGRAM_BOT_TOKEN: "test-token" } as Env;

// Telegram media (voice/photo) is NOT directly addressable by file_id — the
// adapter must call getFile to obtain a file_path, then build the download URL.
// So media tests mock fetch to stand in for that getFile call.
function mockGetFile(filePath: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }), {
      status: 200,
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramAdapter.parseIncoming", () => {
  it("parses a text message (no fetch needed)", async () => {
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          text: "hola",
        },
      }),
      env,
    );
    expect(msg.channel).toBe("telegram");
    expect(msg.channelUserId).toBe("555");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("Ana");
  });

  it("resolves voice notes to a real download URL via getFile", async () => {
    mockGetFile("voice/file_5.oga");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          voice: { file_id: "voice-abc", duration: 5 },
        },
      }),
      env,
    );
    // The resolved URL is the downloadable HTTPS path, not the raw file_id.
    expect(msg.audioUrl).toBe(
      "https://api.telegram.org/file/bottest-token/voice/file_5.oga",
    );
  });

  it("resolves photos to a real download URL + uses caption as text", async () => {
    mockGetFile("photos/file_9.jpg");
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 3,
        message: {
          message_id: 12,
          from: { id: 555, first_name: "Ana", is_bot: false },
          chat: { id: 555, type: "private" },
          date: 100,
          photo: [
            { file_id: "photo-small", width: 90, height: 90 },
            { file_id: "photo-large", width: 800, height: 800 },
          ],
          caption: "mira esto",
        },
      }),
      env,
    );
    expect(msg.imageUrl).toBe(
      "https://api.telegram.org/file/bottest-token/photos/file_9.jpg",
    );
    expect(msg.text).toBe("mira esto");
  });

  it("flags the owner's own message via OWNER_TELEGRAM_CHAT_ID", async () => {
    const ownerEnv = { TELEGRAM_BOT_TOKEN: "t", OWNER_TELEGRAM_CHAT_ID: "999" } as Env;
    const msg = await telegramAdapter.parseIncoming(
      makeReq({
        update_id: 4,
        message: {
          message_id: 13,
          from: { id: 999, first_name: "Dueño", is_bot: false },
          chat: { id: 999, type: "private" },
          date: 100,
          text: "yo me encargo",
        },
      }),
      ownerEnv,
    );
    expect(msg.isOwnerMessage).toBe(true);
  });
});

describe("resolveTelegramFileUrl", () => {
  it("returns null when getFile fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 400 }));
    const url = await resolveTelegramFileUrl("x", "tok");
    expect(url).toBeNull();
  });
});

describe("telegram — documentos y duración de la nota de voz (Contrato v3 §A)", () => {
  it("un document se resuelve a fileUrl con nombre y mime (antes moría vacío)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: { file_path: "documents/file_1.pdf" } })),
      ),
    );
    const req = new Request("https://bot.example.com/webhooks/telegram", {
      method: "POST",
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 9,
          from: { id: 42, first_name: "Ana", is_bot: false },
          chat: { id: 42, type: "private" },
          date: 1,
          caption: "aquí está",
          document: { file_id: "FID", file_name: "plano.pdf", mime_type: "application/pdf" },
        },
      }),
    });
    const msg = await telegramAdapter.parseIncoming(req, { TELEGRAM_BOT_TOKEN: "TOK" } as any);
    expect(msg.fileUrl).toBe("https://api.telegram.org/file/botTOK/documents/file_1.pdf");
    expect(msg.fileName).toBe("plano.pdf");
    expect(msg.fileMime).toBe("application/pdf");
    expect(msg.text).toBe("aquí está");
    vi.unstubAllGlobals();
  });

  it("la nota de voz viaja con su duración (Telegram la trae en el webhook)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: { file_path: "voice/v.oga" } })),
      ),
    );
    const req = new Request("https://bot.example.com/webhooks/telegram", {
      method: "POST",
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 10,
          from: { id: 42, first_name: "Ana", is_bot: false },
          chat: { id: 42, type: "private" },
          date: 1,
          voice: { file_id: "VID", duration: 12 },
        },
      }),
    });
    const msg = await telegramAdapter.parseIncoming(req, { TELEGRAM_BOT_TOKEN: "TOK" } as any);
    expect(msg.audioDurationS).toBe(12);
    vi.unstubAllGlobals();
  });
});

describe("telegramAdapter.sendReply — botones inline de confirmación", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("manda inline_keyboard con el callback_data exacto en el ÚLTIMO chunk", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await telegramAdapter.sendReply(
      {
        channel: "telegram",
        channelUserId: "555",
        chunks: ["¿Confirmas?"],
        inlineButtons: [
          { title: "✅ Sí", data: "visitconf:abc-123:yes" },
          { title: "❌ No", data: "visitconf:abc-123:no" },
        ],
      },
      env,
    );
    const sendMessageCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/sendMessage"));
    expect(sendMessageCall).toBeDefined();
    const body = JSON.parse((sendMessageCall![1] as any).body);
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Sí", callback_data: "visitconf:abc-123:yes" },
          { text: "❌ No", callback_data: "visitconf:abc-123:no" },
        ],
      ],
    });
  });
});

describe("parseCallbackQuery", () => {
  it("reconoce el tap de un botón de confirmación de citas (Sí)", () => {
    const tap = parseCallbackQuery({
      update_id: 1,
      callback_query: {
        id: "cbq_1",
        from: { id: 555 },
        message: { message_id: 99, chat: { id: 555 } },
        data: "visitconf:abc-123:yes",
      },
    } as any);
    expect(tap).toEqual({
      callbackQueryId: "cbq_1",
      chatId: "555",
      messageId: 99,
      confirmationId: "abc-123",
      decision: "yes",
    });
  });

  it("reconoce el tap de No", () => {
    const tap = parseCallbackQuery({
      update_id: 2,
      callback_query: { id: "cbq_2", from: { id: 555 }, data: "visitconf:abc-123:no" },
    } as any);
    expect(tap?.decision).toBe("no");
  });

  it("devuelve null para un update normal (sin callback_query)", () => {
    expect(parseCallbackQuery({ update_id: 3, message: { text: "hola" } } as any)).toBeNull();
  });

  it("devuelve null para un callback_query con data que no matchea el formato esperado", () => {
    expect(
      parseCallbackQuery({ update_id: 4, callback_query: { id: "cbq_4", from: { id: 1 }, data: "otra_cosa" } } as any),
    ).toBeNull();
  });
});

describe("answerCallbackQuery / clearInlineKeyboard / sendPlainTelegramMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answerCallbackQuery llama al endpoint correcto con el callback_query_id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await answerCallbackQuery(env, "cbq_1", "listo");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/answerCallbackQuery"),
      expect.objectContaining({ body: JSON.stringify({ callback_query_id: "cbq_1", text: "listo" }) }),
    );
  });

  it("clearInlineKeyboard llama a editMessageReplyMarkup con teclado vacío", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await clearInlineKeyboard(env, "555", 99);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/editMessageReplyMarkup"),
      expect.objectContaining({
        body: JSON.stringify({ chat_id: "555", message_id: 99, reply_markup: { inline_keyboard: [] } }),
      }),
    );
  });

  it("sendPlainTelegramMessage manda el texto tal cual", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await sendPlainTelegramMessage(env, "555", "hola de nuevo");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/sendMessage"),
      expect.objectContaining({ body: JSON.stringify({ chat_id: "555", text: "hola de nuevo" }) }),
    );
  });
});
