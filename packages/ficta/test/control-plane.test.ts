import { randomUUID } from "node:crypto";
import {
  createFictaControlClient,
  fictaControlErrorData,
  fictaControlErrorStatus,
  FICTA_CAPABILITIES_PATH,
  FICTA_CONTROL_CAPABILITIES,
  FICTA_EXTENSION_CAPABILITIES,
  FICTA_CONTROL_PROTOCOL_VERSION,
} from "@serovaai/ficta-contract";
import {
  FICTA_EGRESS_EVENT_HEADER,
  FICTA_HEALTH_PATH,
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_SCOPE_HEADER,
  FICTA_STATUS_PATH,
  isProtectionPreviewOk,
  isProtectionStatusOk,
} from "@serovaai/ficta-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = ["FICTA_CONFIG_FILE", "FICTA_LOG_LEVEL", "FICTA_UPSTREAM"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FICTA_CONFIG_FILE = "0";
  process.env.FICTA_LOG_LEVEL = "silent";
  process.env.FICTA_UPSTREAM = "http://127.0.0.1:1";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("oRPC control plane", () => {
  it("serves the typed contract on the established HTTP paths", async () => {
    const { startProxy } = await import("../src/server.js");
    const proxy = await startProxy({ port: 0, plugins: [] });
    const baseUrl = `http://127.0.0.1:${proxy.port}`;
    const client = createFictaControlClient({
      baseUrl,
      headers: { [FICTA_SCOPE_HEADER]: "contract-test" },
    });

    try {
      await expect(client.capabilities()).resolves.toEqual({
        ok: true,
        service: "ficta",
        protocolVersion: FICTA_CONTROL_PROTOCOL_VERSION,
        capabilities: [...FICTA_CONTROL_CAPABILITIES, ...FICTA_EXTENSION_CAPABILITIES],
      });
      await expect(client.health()).resolves.toEqual({ ok: true, service: "ficta" });
      expect(isProtectionStatusOk(await client.status())).toBe(true);
      expect((await client.protectionStats({ limit: 1 })).stats.events).toEqual([]);
      expect((await client.config()).ok).toBe(true);
      expect((await client.traceCapture()).traceCapture.enabled).toBe(false);
      expect((await client.updateTraceCapture({ enabled: false })).traceCapture.enabled).toBe(false);
      expect((await client.registryReload()).ok).toBe(true);
      await expect(client.egressProof()).rejects.toMatchObject({ status: 400 });
      await expect(client.updateTraceCapture({ enabled: "bad" } as never)).rejects.toMatchObject({ status: 400 });
      await expect(client.updateConfig({ failClosed: false })).rejects.toMatchObject({
        status: 400,
        data: { status: "disabled" },
      });
      const eventId = randomUUID();
      const proofClient = createFictaControlClient({
        baseUrl,
        headers: {
          [FICTA_SCOPE_HEADER]: "contract-test",
          [FICTA_EGRESS_EVENT_HEADER]: eventId,
        },
      });
      await expect(proofClient.egressProof()).rejects.toMatchObject({ status: 404 });
      await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: "contract-test",
          [FICTA_EGRESS_EVENT_HEADER]: eventId,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "test" }] }),
      });
      expect((await proofClient.egressProof()).proof).toMatchObject({ eventId, outcome: "upstream_error" });
      const wrongStatsMethod = await fetch(`${baseUrl}/__ficta/protection-stats`, { method: "POST" });
      expect(wrongStatsMethod.status).toBe(405);

      const preview = await client.protectionPreview({
        text: "Review Project Juniper",
        protectedValues: ["Project Juniper"],
      });
      expect(isProtectionPreviewOk(preview)).toBe(true);
      expect(preview.redactedText).not.toContain("Project Juniper");

      const rawResponses = await Promise.all(
        [FICTA_CAPABILITIES_PATH, FICTA_HEALTH_PATH, FICTA_STATUS_PATH].map((path) => fetch(`${baseUrl}${path}`)),
      );
      expect(rawResponses.map((response) => response.status)).toEqual([200, 200, 200]);

      const headResponses = await Promise.all(
        [FICTA_HEALTH_PATH, FICTA_STATUS_PATH].map((path) => fetch(`${baseUrl}${path}`, { method: "HEAD" })),
      );
      expect(headResponses.map((response) => response.status)).toEqual([200, 200]);
      await expect(Promise.all(headResponses.map((response) => response.text()))).resolves.toEqual(["", ""]);
    } finally {
      proxy.close();
    }
  });

  it("preserves preview error bodies and does not forward wrong control methods", async () => {
    const { startProxy } = await import("../src/server.js");
    const proxy = await startProxy({ port: 0, plugins: [] });
    const baseUrl = `http://127.0.0.1:${proxy.port}`;

    try {
      const invalid = await fetch(`${baseUrl}${FICTA_PROTECTION_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: "contract-test" },
        body: JSON.stringify({ text: 42 }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        ok: false,
        service: "ficta",
        status: "invalid_request",
        message: "Preview text is required.",
      });

      const wrongMethod = await fetch(`${baseUrl}${FICTA_PROTECTION_PREVIEW_PATH}`);
      expect(wrongMethod.status).toBe(405);
      expect(await wrongMethod.json()).toEqual({
        error: { type: "method_not_allowed", message: "Use POST for protection preview." },
      });

      const client = createFictaControlClient({ baseUrl });
      let clientError: unknown;
      try {
        await client.protectionPreview({ text: "Review this message" });
      } catch (error) {
        clientError = error;
      }
      expect(fictaControlErrorStatus(clientError)).toBe(400);
      expect(fictaControlErrorData(clientError)).toEqual({
        ok: false,
        service: "ficta",
        status: "invalid_request",
        message: "A trusted scope is required.",
      });
    } finally {
      proxy.close();
    }
  });
});
