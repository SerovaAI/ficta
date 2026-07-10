import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FICTA_REGISTRY_RELOAD_PATH, FICTA_STATUS_PATH, isRegistryReloadOk } from "@serovaai/ficta-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { managedRegistryFilePlugin, resetPluginCachesForTests } from "../src/plugins/index.js";

const ENV_KEYS = [
  "FICTA_CONFIG_FILE",
  "FICTA_REGISTRY_ENV_FILE_ENABLED",
  "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
  "FICTA_REGISTRY_DOPPLER_ENABLED",
  "FICTA_REGISTRY_MANAGED_FILE_ENABLED",
  "FICTA_REGISTRY_MANAGED_FILE_PATHS",
  "FICTA_REGISTRY_MIN_LEN",
  "FICTA_UPSTREAM",
  "FICTA_LOG_LEVEL",
  "FICTA_LOG_DIR",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FICTA_CONFIG_FILE = "0";
  process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
  process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
  process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
  process.env.FICTA_REGISTRY_MANAGED_FILE_ENABLED = "1";
  process.env.FICTA_REGISTRY_MIN_LEN = "4";
  resetPluginCachesForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPluginCachesForTests();
});

function writeManagedFile(file: string, values: string[]): void {
  writeFileSync(
    file,
    JSON.stringify({
      schema: "ficta.managed-registry.v1",
      entries: values.map((value, i) => ({
        id: `entry-${i}`,
        name: `gateway:client:global:entry-${i}`,
        type: "client",
        value,
        aliases: [],
        kind: "custom",
      })),
    }),
    { mode: 0o600 },
  );
}

describe("engine registry reload", () => {
  it("registers new managed-file values live: redact, restore, and case-expand without a rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-reload-"));
    const file = join(dir, "protected-registry.json");
    process.env.FICTA_REGISTRY_MANAGED_FILE_PATHS = file;
    writeManagedFile(file, ["Northstar Biologics"]);

    const engine = new ProtectionEngine({ plugins: [managedRegistryFilePlugin] });
    expect(engine.size).toBe(1);

    // Gateway "publish" rewrites the file with an extra entry. The stat-based cache key must pick the
    // edit up on its own here — the engine-level reload does NOT get the endpoint's explicit reset.
    writeManagedFile(file, ["Northstar Biologics", "Copper Kite Litigation"]);
    const first = engine.reloadRegistryValues();
    expect(first).toEqual({ added: 1, total: 2 });

    // A fresh scope protects the new value immediately: redacted, case-expanded, restored.
    const scope = engine.beginRequest();
    const body = JSON.stringify({ content: "Re: Copper Kite Litigation — heading COPPER KITE LITIGATION." });
    const redacted = await scope.redactBodyDetailed(body);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain("Copper Kite Litigation");
    expect(redacted.body).not.toContain("COPPER KITE LITIGATION"); // registry case-variant coverage applies
    const restored = scope.restoreText(redacted.body);
    expect(restored).toContain("Copper Kite Litigation");
    expect(restored).toContain("COPPER KITE LITIGATION");

    // Unchanged file → idempotent no-op.
    expect(engine.reloadRegistryValues()).toEqual({ added: 0, total: 2 });
  });

  it("existing keyed scopes see reloaded values on their next request, detected layer intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-reload-keyed-"));
    const file = join(dir, "protected-registry.json");
    process.env.FICTA_REGISTRY_MANAGED_FILE_PATHS = file;
    writeManagedFile(file, ["Northstar Biologics"]);

    const engine = new ProtectionEngine({ plugins: [managedRegistryFilePlugin] });
    const key = "org-1:thread-1";
    // Turn 1 for this thread, before the reload.
    const before = await engine.beginRequest(key).redactBodyDetailed(JSON.stringify({ content: "Frog Trust memo" }));
    expect(before.body).toContain("Frog Trust"); // not yet registered

    writeManagedFile(file, ["Northstar Biologics", "Frog Trust"]);
    expect(engine.reloadRegistryValues()).toEqual({ added: 1, total: 2 });

    // Turn 2 on the SAME key: the shared permanent layer now covers the value.
    const after = await engine.beginRequest(key).redactBodyDetailed(JSON.stringify({ content: "Frog Trust memo" }));
    expect(after.body).not.toContain("Frog Trust");
    expect(after.leaks).toBe(0);
  });
});

describe("proxy registry reload endpoint", () => {
  it("POST reloads live (counts-only response), and the next proxied request redacts the new value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-reload-proxy-"));
    const file = join(dir, "protected-registry.json");
    process.env.FICTA_REGISTRY_MANAGED_FILE_PATHS = file;
    process.env.FICTA_LOG_LEVEL = "silent";
    process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-reload-logs-"));
    writeManagedFile(file, ["Northstar Biologics"]);

    let upstreamSaw = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamSaw = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as AddressInfo).port));
    });
    process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });
      const base = `http://127.0.0.1:${proxy.port}`;

      // Non-POST → 405.
      expect((await fetch(`${base}${FICTA_REGISTRY_RELOAD_PATH}`)).status).toBe(405);

      // Publish: the gateway rewrites the file, then POSTs reload. "ZA" is below FICTA_REGISTRY_MIN_LEN
      // (4 in this suite) — it must be surfaced as skippedTooShort, not read as a silent success.
      writeManagedFile(file, ["Northstar Biologics", "Copper Kite Litigation", "ZA"]);
      const res = await fetch(`${base}${FICTA_REGISTRY_RELOAD_PATH}`, { method: "POST" });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("Northstar"); // counts only — never values
      expect(raw).not.toContain("Copper Kite");
      const json: unknown = JSON.parse(raw);
      expect(isRegistryReloadOk(json)).toBe(true);
      if (isRegistryReloadOk(json)) expect(json.registry).toEqual({ added: 1, total: 2, skippedTooShort: 1 });

      // No restart: the very next proxied request keeps the new value out of the upstream body.
      const chat = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Copper Kite Litigation" }] }),
      });
      expect(chat.status).toBe(200);
      await chat.text();
      expect(upstreamSaw).not.toContain("Copper Kite Litigation");
      expect(upstreamSaw).toMatch(/FICTA_[0-9a-f]{32}/);

      // Live status reflects the reload.
      const status = (await (await fetch(`${base}${FICTA_STATUS_PATH}`)).json()) as {
        protection: { registeredValues: number };
      };
      expect(status.protection.registeredValues).toBe(2);
    } finally {
      proxy?.close();
      await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
