import { describe, it, expect, vi } from "vitest";
import {
  sendChunkedReply,
  pickAdapter,
  chunkDelayMs,
  extraeConfirmarVisita,
  extraeFotosDirectas,
} from "../../src/replies/sender";
import type { ChannelAdapter } from "../../src/channels/shared";

describe("sendChunkedReply", () => {
  it("invokes adapter.sendReply with all chunks", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "user_1", ["a", "b", "c"], {} as any);
    expect(sendReply).toHaveBeenCalledOnce();
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.chunks).toEqual(["a", "b", "c"]);
    expect(arg.channelUserId).toBe("user_1");
  });

  it("passes channel and env through to the adapter", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    const env = { BOT_NAME: "horizontes" } as any;
    await sendChunkedReply(adapter, "twilio", "+5215555", ["hola"], env);
    const [reply, passedEnv] = sendReply.mock.calls[0] as any[];
    expect(reply.channel).toBe("twilio");
    expect(passedEnv).toBe(env);
  });

  it("respects an explicit interChunkDelayMs", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "manychat", "u", ["one", "two"], {} as any, 2222);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBe(2222);
  });

  it("defaults to a clamped, length-proportional delay for multi-chunk replies", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "u", ["short", "next"], {} as any);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBeGreaterThanOrEqual(800);
    expect(arg.interChunkDelayMs).toBeLessThanOrEqual(1500);
  });

  it("does not set a default delay for a single-chunk reply", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "telegram", "u", ["only one"], {} as any);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.interChunkDelayMs).toBeUndefined();
  });
});

describe("extraeConfirmarVisita", () => {
  it("extrae el confirmationId y limpia el marcador del texto", () => {
    const r = extraeConfirmarVisita(["¿Confirmas que quieres cancelar tu visita?\n\n[[confirmar_visita: abc-123]]"]);
    expect(r.confirmationId).toBe("abc-123");
    expect(r.chunks).toEqual(["¿Confirmas que quieres cancelar tu visita?"]);
  });

  it("sin marcador, deja los chunks intactos y confirmationId undefined", () => {
    const r = extraeConfirmarVisita(["hola, ¿en qué te ayudo?"]);
    expect(r.confirmationId).toBeUndefined();
    expect(r.chunks).toEqual(["hola, ¿en qué te ayudo?"]);
  });
});

describe("sendChunkedReply con [[confirmar_visita: …]]", () => {
  it("en Telegram, adjunta botones inline Sí/No con el callback_data correcto y limpia el marcador del texto", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(
      adapter,
      "telegram",
      "u1",
      ["¿Confirmas que quieres cancelar tu visita?\n\n[[confirmar_visita: abc-123]]"],
      {} as any,
    );
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.chunks).toEqual(["¿Confirmas que quieres cancelar tu visita?"]);
    expect(arg.inlineButtons).toEqual([
      { title: "✅ Sí", data: "visitconf:abc-123:yes" },
      { title: "❌ No", data: "visitconf:abc-123:no" },
    ]);
  });

  it("en un canal sin callback_query nativo, limpia el marcador pero NO manda inlineButtons", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(
      adapter,
      "whatsapp",
      "u1",
      ["¿Confirmas que quieres cancelar tu visita?\n\n[[confirmar_visita: abc-123]]"],
      {} as any,
    );
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.chunks).toEqual(["¿Confirmas que quieres cancelar tu visita?"]);
    expect(arg.inlineButtons).toBeUndefined();
  });
});

describe("extraeFotosDirectas", () => {
  it("extrae una URL directa con caption y limpia el marcador del texto", () => {
    const r = extraeFotosDirectas(["ID 3495, piso en alquiler.\n\n[[foto: https://ejemplo.com/casa.jpg | Fachada]]"]);
    expect(r.fotos).toEqual([{ kind: "image", url: "https://ejemplo.com/casa.jpg", caption: "Fachada" }]);
    expect(r.chunks).toEqual(["ID 3495, piso en alquiler."]);
  });

  it("sin caption, funciona igual", () => {
    const r = extraeFotosDirectas(["[[foto: https://ejemplo.com/casa.jpg]]"]);
    expect(r.fotos).toEqual([{ kind: "image", url: "https://ejemplo.com/casa.jpg" }]);
  });

  it("dedupea URLs repetidas y respeta el máximo de 3", () => {
    const texto = [
      "[[foto: https://a.com/1.jpg]]",
      "[[foto: https://a.com/1.jpg]]", // repetida
      "[[foto: https://a.com/2.jpg]]",
      "[[foto: https://a.com/3.jpg]]",
      "[[foto: https://a.com/4.jpg]]", // se descarta, ya hay 3
    ].join(" ");
    const r = extraeFotosDirectas([texto]);
    expect(r.fotos).toHaveLength(3);
    expect(r.fotos.map((f) => f.url)).toEqual(["https://a.com/1.jpg", "https://a.com/2.jpg", "https://a.com/3.jpg"]);
  });

  it("sin marcador, deja los chunks intactos", () => {
    const r = extraeFotosDirectas(["hola, ¿en qué te ayudo?"]);
    expect(r.fotos).toEqual([]);
    expect(r.chunks).toEqual(["hola, ¿en qué te ayudo?"]);
  });
});

describe("sendChunkedReply con [[foto: url]]", () => {
  it("en un canal con soporte de media, manda la foto como OutgoingReply.media (no como link en texto)", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(
      adapter,
      "telegram",
      "u1",
      ["ID 3495, piso en alquiler.\n\n[[foto: https://ejemplo.com/casa.jpg | Fachada]]"],
      {} as any,
    );
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.chunks).toEqual(["ID 3495, piso en alquiler."]);
    expect(arg.media).toEqual([{ kind: "image", url: "https://ejemplo.com/casa.jpg", caption: "Fachada" }]);
  });

  it("en un canal SIN soporte de media, cae a un link en texto (nada se pierde)", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "web", "u1", ["Mira la foto:\n\n[[foto: https://ejemplo.com/casa.jpg | Fachada]]"], {} as any);
    const arg = (sendReply.mock.calls[0] as any[])[0];
    expect(arg.media).toBeUndefined();
    expect(arg.chunks[0]).toContain("https://ejemplo.com/casa.jpg");
    expect(arg.chunks[0]).toContain("Fachada");
  });
});

describe("chunkDelayMs", () => {
  it("clamps short chunks up to the minimum (800ms)", () => {
    expect(chunkDelayMs("hi")).toBe(800); // 2 * 30 = 60 -> clamped to 800
  });

  it("clamps long chunks down to the maximum (1500ms)", () => {
    const long = "x".repeat(200); // 200 * 30 = 6000 -> clamped to 1500
    expect(chunkDelayMs(long)).toBe(1500);
  });

  it("scales proportionally inside the band", () => {
    const mid = "y".repeat(40); // 40 * 30 = 1200, within [800, 1500]
    expect(chunkDelayMs(mid)).toBe(1200);
  });
});

describe("pickAdapter", () => {
  it("maps each channel to an adapter exposing sendReply", () => {
    for (const ch of ["telegram", "manychat", "twilio"] as const) {
      const adapter = pickAdapter(ch);
      expect(typeof adapter.sendReply).toBe("function");
      expect(typeof adapter.parseIncoming).toBe("function");
    }
  });

  it("throws on an unknown channel", () => {
    expect(() => pickAdapter("sms" as any)).toThrow(/unknown channel/);
  });
});
