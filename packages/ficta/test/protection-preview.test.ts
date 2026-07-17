import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_PROTECTION_TICKET_HEADER,
  FICTA_SCOPE_HEADER,
  isProtectionPreviewOk,
} from "@serovaai/ficta-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetectorPlugin } from "../src/plugins/index.js";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

const ENV_KEYS = ["FICTA_UPSTREAM", "FICTA_LOG_LEVEL", "FICTA_CONFIG_FILE"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FICTA_LOG_LEVEL = "silent";
  process.env.FICTA_CONFIG_FILE = "0";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("pre-send protection preview", () => {
  it("returns the occurrence resolver's exact spans when the detected canonical value is not a literal substring", async () => {
    const raw = "Blue **Lantern** FZCO";
    const detector: DetectorPlugin = {
      kind: "detector",
      name: "preview-span-fixture",
      bodyDetectionView: "content",
      detectText: (text) =>
        text === raw
          ? [
              {
                name: "organization",
                value: "Blue Lantern FZCO",
                source: "fixture-detector",
                kind: "pii",
                confidence: "high",
                spans: [{ start: 0, end: raw.length }],
              },
            ]
          : [],
    };
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      process.env.FICTA_UPSTREAM = "http://127.0.0.1:1";
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [detector] });
      const response = await fetch(`http://127.0.0.1:${proxy.port}${FICTA_PROTECTION_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: "span-scope" },
        body: JSON.stringify({ text: raw }),
      });
      const preview = (await response.json()) as unknown;
      expect(isProtectionPreviewOk(preview)).toBe(true);
      if (!isProtectionPreviewOk(preview)) throw new Error("span preview guard failed");
      expect(preview.redactedText).not.toContain(raw);
      expect(preview.findings).toEqual([
        expect.objectContaining({ start: 0, end: raw.length, origin: "detected", source: "fixture-detector" }),
      ]);
    } finally {
      proxy?.close();
    }
  });

  it("previews a user selection and requires the opaque ticket to apply it to the model request", async () => {
    const sensitive = "Project Copper Kite";
    let upstreamBody = "";
    let upstreamTicket: string | undefined;
    let upstreamRequests = 0;
    const upstream = createServer((req, res) => {
      upstreamRequests++;
      upstreamTicket = req.headers[FICTA_PROTECTION_TICKET_HEADER];
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;

    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [] });
      const base = `http://127.0.0.1:${proxy.port}`;
      const scope = "org-1:thread-1";
      const text = `Summarize the ${sensitive} plan.`;

      const previewResponse = await fetch(`${base}${FICTA_PROTECTION_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: scope },
        body: JSON.stringify({ text, protectedValues: [sensitive] }),
      });
      const preview = (await previewResponse.json()) as unknown;
      expect(previewResponse.status).toBe(200);
      expect(isProtectionPreviewOk(preview)).toBe(true);
      if (!isProtectionPreviewOk(preview)) throw new Error("preview guard failed");
      expect(preview.redactedText).not.toContain(sensitive);
      expect(preview.findings).toEqual([
        expect.objectContaining({ start: 14, end: 33, origin: "user", source: "user-selected" }),
      ]);

      const modelResponse = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: scope,
          [FICTA_PROTECTION_TICKET_HEADER]: preview.ticket,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }),
      });
      const restored = await modelResponse.text();
      expect(modelResponse.status).toBe(200);
      expect(upstreamBody).not.toContain(sensitive);
      expect(upstreamBody).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(upstreamTicket).toBeUndefined();
      expect(restored).toContain(sensitive);

      const replay = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: scope,
          [FICTA_PROTECTION_TICKET_HEADER]: preview.ticket,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }),
      });
      expect(replay.status).toBe(409);
      expect(upstreamRequests).toBe(1);

      const changedPreviewResponse = await fetch(`${base}${FICTA_PROTECTION_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: scope },
        body: JSON.stringify({ text, protectedValues: [sensitive] }),
      });
      const changedPreview = (await changedPreviewResponse.json()) as unknown;
      expect(isProtectionPreviewOk(changedPreview)).toBe(true);
      if (!isProtectionPreviewOk(changedPreview)) throw new Error("changed preview guard failed");
      const changed = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: scope,
          [FICTA_PROTECTION_TICKET_HEADER]: changedPreview.ticket,
        },
        body: JSON.stringify({
          model: "test",
          messages: [
            { role: "user", content: text },
            { role: "assistant", content: "Earlier response" },
            { role: "user", content: `${text} changed` },
          ],
        }),
      });
      expect(changed.status).toBe(409);
      const changedRetry = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: scope,
          [FICTA_PROTECTION_TICKET_HEADER]: changedPreview.ticket,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }),
      });
      expect(changedRetry.status).toBe(409);
      expect(upstreamRequests).toBe(1);

      const tabTexts = ["Protect Alpha Ledger", "Protect Beta Ledger"];
      const tabTickets: string[] = [];
      for (const tabText of tabTexts) {
        const response = await fetch(`${base}${FICTA_PROTECTION_PREVIEW_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: scope },
          body: JSON.stringify({ text: tabText, protectedValues: [tabText.slice(8)] }),
        });
        const prepared = (await response.json()) as unknown;
        expect(isProtectionPreviewOk(prepared)).toBe(true);
        if (!isProtectionPreviewOk(prepared)) throw new Error("parallel preview guard failed");
        tabTickets.push(prepared.ticket);
      }
      for (let index = 0; index < tabTexts.length; index++) {
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [FICTA_SCOPE_HEADER]: scope,
            [FICTA_PROTECTION_TICKET_HEADER]: tabTickets[index] ?? "",
          },
          body: JSON.stringify({
            model: "test",
            input: [{ role: "user", content: [{ type: "input_text", text: tabTexts[index] }] }],
          }),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(upstreamRequests).toBe(3);

      // User-selected values are request-local: Gateway can remove one from durable chat state and the
      // next preview on the same keyed detector scope no longer protects it.
      const removedResponse = await fetch(`${base}${FICTA_PROTECTION_PREVIEW_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: scope },
        body: JSON.stringify({ text, protectedValues: [] }),
      });
      const removed = (await removedResponse.json()) as unknown;
      expect(isProtectionPreviewOk(removed)).toBe(true);
      if (!isProtectionPreviewOk(removed)) throw new Error("removed preview guard failed");
      expect(removed.redactedText).toContain(sensitive);
      expect(removed.findings).toEqual([]);

      const wrongScope = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [FICTA_SCOPE_HEADER]: "org-1:thread-2",
          [FICTA_PROTECTION_TICKET_HEADER]: preview.ticket,
        },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }),
      });
      expect(wrongScope.status).toBe(409);
      expect(upstreamRequests).toBe(3);
    } finally {
      proxy?.close();
      await close(upstream);
    }
  });

  it("keeps concurrent same-scope tickets independent and evicts only the oldest at the bound", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((req, res) => {
      upstreamRequests++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;

    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [] });
      const base = `http://127.0.0.1:${proxy.port}`;
      const scope = "org-1:shared-thread";
      const prepared: Array<{ text: string; ticket: string }> = [];

      // The per-scope bound is eight: the ninth preview evicts only the oldest capability.
      for (let index = 0; index < 9; index++) {
        const protectedValue = `Private Ledger ${index}`;
        const text = `Summarize ${protectedValue}`;
        const response = await fetch(`${base}${FICTA_PROTECTION_PREVIEW_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", [FICTA_SCOPE_HEADER]: scope },
          body: JSON.stringify({ text, protectedValues: [protectedValue] }),
        });
        const preview = (await response.json()) as unknown;
        expect(isProtectionPreviewOk(preview)).toBe(true);
        if (!isProtectionPreviewOk(preview)) throw new Error("bounded preview guard failed");
        prepared.push({ text, ticket: preview.ticket });
      }

      const send = ({ text, ticket }: { text: string; ticket: string }) =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [FICTA_SCOPE_HEADER]: scope,
            [FICTA_PROTECTION_TICKET_HEADER]: ticket,
          },
          body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }),
        });

      expect((await send(prepared[0] as { text: string; ticket: string })).status).toBe(409);
      const second = await send(prepared[1] as { text: string; ticket: string });
      expect(second.status).toBe(200);
      await second.text();
      const newest = await send(prepared[8] as { text: string; ticket: string });
      expect(newest.status).toBe(200);
      await newest.text();
      expect(upstreamRequests).toBe(2);
    } finally {
      proxy?.close();
      await close(upstream);
    }
  });
});
