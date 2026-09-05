import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  capabilitiesSchema,
  createFictaControlClient,
  protectionPreviewSchema,
  FICTA_CONTROL_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
  FICTA_SCOPE_HEADER,
  FICTA_SCOPE_MAX_LENGTH,
  PROTECTION_PREVIEW_TEXT_MAX_BYTES,
  PROTECTION_PREVIEW_VALUE_MAX,
  PROTECTION_PREVIEW_VALUES_MAX_BYTES,
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

  it("rejects protected selections over the published combined UTF-8 byte limit", () => {
    const protectedValues = Array.from(
      { length: 12 },
      (_, index) => `${"€".repeat(PROTECTION_PREVIEW_VALUE_MAX - 2)}${String(index).padStart(2, "0")}`,
    );
    const totalBytes = protectedValues.reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
    expect(totalBytes).toBeGreaterThan(PROTECTION_PREVIEW_VALUES_MAX_BYTES);
    expect(protectionPreviewInputSchema.safeParse({ text: "Review these values", protectedValues }).success).toBe(
      false,
    );
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
            parameters?: Array<{
              name?: string;
              in?: string;
              required?: boolean;
              schema?: Record<string, unknown>;
            }>;
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
      "/__ficta/protection-stats",
      "/__ficta/egress-proof",
      "/__ficta/config",
      "/__ficta/trace-capture",
      "/__ficta/registry/reload",
    ]);
    expect(specification.paths?.["/__ficta/health"]?.head?.responses).toHaveProperty("200");
    expect(specification.paths?.["/__ficta/status"]?.head?.responses).toHaveProperty("200");
    const previewOperation = specification.paths?.["/__ficta/protection-preview"]?.post;
    expect(previewOperation?.responses).toHaveProperty("400");
    expect(previewOperation?.parameters).toContainEqual({
      name: FICTA_SCOPE_HEADER,
      in: "header",
      required: true,
      description: "Trusted, server-owned tenant/user/conversation isolation key. Never forwarded upstream.",
      schema: { type: "string", minLength: 1, maxLength: FICTA_SCOPE_MAX_LENGTH },
    });
    const previewProperties = previewOperation?.requestBody?.content?.["application/json"]?.schema?.properties;
    const textSchema = previewProperties?.text;
    expect(textSchema).toMatchObject({
      description: `Maximum ${PROTECTION_PREVIEW_TEXT_MAX_BYTES} bytes when encoded as UTF-8.`,
      "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_TEXT_MAX_BYTES,
    });
    expect(previewProperties?.protectedValues).toMatchObject({
      "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_VALUES_MAX_BYTES,
    });
  });
});

const preview = {
  ok: true,
  service: "ficta",
  ticket: "opaque_token.from-another-engine+/=",
  textSha256: "a".repeat(64),
  redactedText: "replacement",
  findings: [{ start: 0, end: 4, surrogate: "replacement", origin: "user", name: "selected", source: "user-selected" }],
};
describe("portable response validation", () => {
  it("accepts opaque tickets and rejects empty tickets and invalid finding spans", () => {
    expect(protectionPreviewSchema.safeParse(preview).success).toBe(true);
    for (const ticket of ["", " token ", "token\r\ninjected"]) {
      expect(protectionPreviewSchema.safeParse({ ...preview, ticket }).success).toBe(false);
    }
    for (const end of [0, -1]) {
      expect(
        protectionPreviewSchema.safeParse({ ...preview, findings: [{ ...preview.findings[0], end }] }).success,
      ).toBe(false);
    }
  });
  it("validates responses from external engines at the shared client boundary", async () => {
    const client = createFictaControlClient({
      baseUrl: "http://external-engine",
      fetch: async () => Response.json({ ...preview, ticket: "" }),
    });
    await expect(client.protectionPreview({ text: "test" })).rejects.toThrow();
  });
});
