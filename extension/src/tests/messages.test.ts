import { describe, it, expect } from "vitest";
import {
  AnyMessageSchema,
  parseMessage,
  GetPageInfoRequestSchema,
  GetPageInfoResponseSchema,
  PingRequestSchema,
  PongResponseSchema,
  PageInfoSchema,
} from "../shared/messages";

describe("message schema", () => {
  it("validates GET_PAGE_INFO request", () => {
    const msg = { type: "GET_PAGE_INFO" };
    expect(GetPageInfoRequestSchema.safeParse(msg).success).toBe(true);
  });

  it("validates PAGE_INFO response", () => {
    const msg = {
      type: "PAGE_INFO",
      payload: {
        hostname: "example.com",
        url: "https://example.com/path",
        title: "Example",
      },
    };
    expect(GetPageInfoResponseSchema.safeParse(msg).success).toBe(true);
  });

  it("validates PING request", () => {
    expect(PingRequestSchema.safeParse({ type: "PING" }).success).toBe(true);
  });

  it("validates PONG response", () => {
    const msg = { type: "PONG", version: "0.0.1" };
    expect(PongResponseSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects unknown message type", () => {
    const msg = { type: "UNKNOWN_TYPE" };
    expect(AnyMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("rejects PAGE_INFO with invalid url", () => {
    const msg = {
      type: "PAGE_INFO",
      payload: {
        hostname: "example.com",
        url: "not-a-url",
        title: "Example",
      },
    };
    expect(GetPageInfoResponseSchema.safeParse(msg).success).toBe(false);
  });

  it("parseMessage returns null for unknown messages", () => {
    const result = parseMessage({ type: "GARBAGE" });
    expect(result).toBeNull();
  });

  it("parseMessage returns typed message for valid input", () => {
    const result = parseMessage({ type: "PING" });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("PING");
  });

  it("PageInfo schema rejects missing fields", () => {
    expect(PageInfoSchema.safeParse({ hostname: "x.com" }).success).toBe(false);
  });

  it("discriminated union covers all 4 types", () => {
    const messages = [
      { type: "GET_PAGE_INFO" },
      { type: "PAGE_INFO", payload: { hostname: "x.com", url: "https://x.com", title: "X" } },
      { type: "PING" },
      { type: "PONG", version: "1.0.0" },
    ];
    for (const msg of messages) {
      expect(AnyMessageSchema.safeParse(msg).success).toBe(true);
    }
  });
});
