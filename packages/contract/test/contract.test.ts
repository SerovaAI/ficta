import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  capabilitiesSchema,
  FICTA_CONTROL_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
  protectionPreviewInputSchema,
  protectionStatusSchema,
} from "../src/index.js";

describe("Ficta control-plane schemas", () => {
  it("defines a versioned, finite capability set", () => {
    expect(
      capabilitiesSchema.parse({
        ok: true,
        service: "ficta",
        protocolVersion: FICTA_CONTROL_PROTOCOL_VERSION,
        capabilities: FICTA_CONTROL_CAPABILITIES,
      }),
    ).toEqual({
      ok: true,
      service: "ficta",
      protocolVersion: 1,
      capabilities: ["health", "status", "protection-preview"],
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
      paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    expect(specification.openapi).toBe("3.1.1");
    expect(Object.keys(specification.paths ?? {})).toEqual([
      "/__ficta/capabilities",
      "/__ficta/health",
      "/__ficta/status",
      "/__ficta/protection-preview",
    ]);
    expect(specification.paths?.["/__ficta/protection-preview"]?.post?.responses).toHaveProperty("400");
  });
});
