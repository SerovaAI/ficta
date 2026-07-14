import { describe, expect, it } from "vitest";
import { MODEL_SURROGATE_TOKEN_PATTERN } from "@/components/chat/ProtectionReview";

describe("ProtectionReview model tokens", () => {
  it("matches complete tokens only at valid boundaries", () => {
    const literal = "FICTA_SECRET_0123456789abcdef0123456789abcdef";
    const family = "FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH";
    const text = `X${literal} ${literal}suffix ${literal}. ${family}_TAIL (${family})`;

    expect([...text.matchAll(MODEL_SURROGATE_TOKEN_PATTERN)].map((match) => match[0])).toEqual([literal, family]);
  });
});
