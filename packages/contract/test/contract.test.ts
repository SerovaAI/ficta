import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  capabilitiesSchema,
  FICTA_CONTROL_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
  PROTECTION_PREVIEW_TEXT_MAX_BYTES,
  protectionPreviewInputSchema,
  protectionStatusSchema,
} from "../src/index.js";

describe("Ficta control-plane schemas", () => {
  it("accepts added capability names within the same protocol version", () => {
    expect(
      capabilitiesSchema.parse({
        ok: true,
        service: "ficta",
        protocolVersion: FICTA_CONTROL_PROTOCOL_VERSION,
        capabilities: [...FICTA_CONTROL_CAPABILITIES, "future-capability"],
      }),
    ).toEqual({
      ok: true,
      service: "ficta",
      protocolVersion: 1,
      capabilities: ["health", "status", "protection-preview", "future-capability"],
    });
  });

  it("normalizes and deduplicates preview selections", () => {
    expect(
      protectionPreviewInputSchema.parse({
        text: "Review Project Finch",
        protectedValues: [" Project Finch ", "Project Finch"],
      }),
    ).toEqual({ text: "Review Project Finch", protectedValues: ["Project Finch"] });
  });

  it("rejects multibyte preview text over the published UTF-8 byte limit", () => {
    const text = "€".repeat(Math.floor(PROTECTION_PREVIEW_TEXT_MAX_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(PROTECTION_PREVIEW_TEXT_MAX_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(PROTECTION_PREVIEW_TEXT_MAX_BYTES);
    expect(protectionPreviewInputSchema.safeParse({ text }).success).toBe(false);
  });

  it("keeps status compatibility fields optional", () => {
    expect(
      protectionStatusSchema.safeParse({
        ok: true,
        service: "ficta",
        protection: { enabled: true, protecting: true, registeredValues: 1, policyExcluded: 0 },
        secretShapes: { enabled: false, status: "off", message: "off" },
        pii: {
          enabled: false,
          configuredBackend: "regex",
          backend: "regex",
          status: "off",
          failureMode: "fail-open",
          message: "off",
        },
      }).success,
    ).toBe(true);
  });

  it("publishes an OpenAPI 3.1 document for every procedure and the legacy error body", async () => {
    const raw = await readFile(new URL("../openapi/ficta-control-plane.openapi.json", import.meta.url), "utf8");
    const specification = JSON.parse(raw) as {
      openapi?: string;
      paths?: Record<
        string,
        Record<
          string,
          {
            requestBody?: {
              content?: Record<string, { schema?: { properties?: Record<string, Record<string, unknown>> } }>;
            };
            responses?: Record<string, unknown>;
          }
        >
      >;
    };
    expect(specification.openapi).toBe("3.1.1");
    expect(Object.keys(specification.paths ?? {})).toEqual([
      "/__ficta/capabilities",
      "/__ficta/health",
      "/__ficta/status",
      "/__ficta/protection-preview",
    ]);
    expect(specification.paths?.["/__ficta/protection-preview"]?.post?.responses).toHaveProperty("400");
    const textSchema =
      specification.paths?.["/__ficta/protection-preview"]?.post?.requestBody?.content?.["application/json"]?.schema
        ?.properties?.text;
    expect(textSchema).toMatchObject({
      description: `Maximum ${PROTECTION_PREVIEW_TEXT_MAX_BYTES} bytes when encoded as UTF-8.`,
      "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_TEXT_MAX_BYTES,
    });
  });
});
