import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import { type DetectorPlugin, dopplerPlugin, type RegistrySourcePlugin } from "../src/plugins/index.js";

const SECRET = "test-secret-value-12345";
const EMAIL = "alice@example.com";

describe("protection engine plugins", () => {
  it("loads exact registry values from a plugin and round-trips them", async () => {
    const plugin: RegistrySourcePlugin = {
      kind: "registry-source",
      name: "fixture-registry",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [
        { name: "FIXTURE_SECRET", value: SECRET, source: "fixture", kind: "secret", confidence: "exact" },
      ],
    };
    const engine = new ProtectionEngine({ plugins: [plugin] });

    expect(engine.registrySize).toBe(1);
    expect(engine.enabled).toBe(true);

    const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: `secret=${SECRET}` }));
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(SECRET);
    expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted.body)).toContain(SECRET);
  });

  it("recognizes registered values across line-wrapped whitespace in safety checks", () => {
    const value = "Proxima Medical Supplies CC";
    const engine = new ProtectionEngine({ plugins: [], values: [{ value }] });

    expect(engine.containsProtectedValue("counterparty: Proxima Medical\nSupplies CC")).toBe(true);
    expect(engine.containsProtectedValue("counterparty: ProximaMedicalSupplies CC")).toBe(false);
  });

  it("exposes raw value trace details only when explicitly requested", async () => {
    const plugin: RegistrySourcePlugin = {
      kind: "registry-source",
      name: "fixture-registry",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [
        { name: "FIXTURE_SECRET", value: SECRET, source: "fixture", kind: "secret", confidence: "exact" },
      ],
    };
    const engine = new ProtectionEngine({ plugins: [plugin] });
    const body = JSON.stringify({ content: `secret=${SECRET}` });

    const normal = await engine.redactBodyDetailed(body);
    expect(normal.traceValues).toBeUndefined();

    const scope = engine.beginRequest();
    const redacted = await scope.redactBodyDetailed(body, { traceValues: true });
    expect(redacted.traceValues).toHaveLength(1);
    expect(redacted.traceValues?.[0]).toMatchObject({
      name: "FIXTURE_SECRET",
      source: "fixture",
      kind: "secret",
      confidence: "exact",
      value: SECRET,
      provenance: "permanent",
    });
    expect(redacted.traceValues?.[0]?.valueSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(redacted.traceValues?.[0]?.surrogate).toMatch(/^FICTA_[0-9a-f]{32}$/);

    scope.restoreJson(redacted.body);
    expect(scope.traceRestoreDetails().restored).toEqual(redacted.traceValues);
  });

  it("attributes a value that is both registered and detected to the registry, not the detector", async () => {
    // A registered secret is authoritative for audit *identity*: when a probabilistic detector also
    // flags the exact same value, the trace/stats report the registry's declared identity
    // (env-file/secret/exact) rather than the detector's guess (person/pii/high). See
    // ProtectionRequestScope.metadataFor.
    //
    // `provenance` is deliberately NOT flipped here: it comes from the vault's layer walk and reflects
    // what mechanically governed this redaction (the detected layer's surrogate and its
    // restore-into-tools classification). It stays `detected` — claiming `permanent` while the value is
    // still mechanically treated as detected would make the audit misreport tool behavior. Making the
    // registry win the span itself (and thus provenance + restore-into-tools) is the span-resolver
    // rework tracked in ficta-internal.
    const NAME = "Amelia Naidoo";
    const registry: RegistrySourcePlugin = {
      kind: "registry-source",
      name: "fixture-registry",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [{ name: "CLIENT_CFO", value: NAME, source: "env-file", kind: "secret", confidence: "exact" }],
    };
    const detector: DetectorPlugin = {
      kind: "detector",
      name: "fixture-pii-detector",
      detectText: (text) =>
        text.includes(NAME)
          ? [{ name: "person", value: NAME, source: "fixture-detector", kind: "pii", confidence: "high" }]
          : [],
    };
    const engine = new ProtectionEngine({ plugins: [registry, detector] });

    const scope = engine.beginRequest();
    const redacted = await scope.redactBodyDetailed(JSON.stringify({ content: `The CFO is ${NAME}.` }), {
      traceValues: true,
    });

    expect(redacted.count).toBe(1);
    // Identity attribution (redactedHits in the trace/stats) now names the registry secret.
    expect(redacted.hits).toHaveLength(1);
    expect(redacted.hits[0]).toMatchObject({
      name: "CLIENT_CFO",
      source: "env-file",
      kind: "secret",
      confidence: "exact",
    });
    expect(redacted.traceValues?.[0]).toMatchObject({
      name: "CLIENT_CFO",
      source: "env-file",
      kind: "secret",
      confidence: "exact",
      provenance: "detected", // mechanical layer, unchanged by the identity fix; see comment above
    });
  });

  it("case-expands word-like registry values to every casing present, but not digit-bearing secrets", async () => {
    const engine = new ProtectionEngine({
      plugins: [],
      values: [
        { name: "JURISDICTION", value: "Mauritius", source: "env-file", kind: "secret", confidence: "exact" },
        { name: "MATTER_ID", value: "NSB-2026-0147", source: "env-file", kind: "secret", confidence: "exact" },
      ],
    });
    const scope = engine.beginRequest();
    const body = JSON.stringify({
      content: "In Mauritius; heading MAURITIUS; and mauritius. Matter NSB-2026-0147 vs nsb-2026-0147.",
    });
    const redacted = await scope.redactBodyDetailed(body);

    // The registered word-like value now covers all three casings present in the body.
    expect(redacted.body).not.toContain("Mauritius");
    expect(redacted.body).not.toContain("MAURITIUS");
    expect(redacted.body).not.toContain("mauritius");
    // The digit-bearing secret is NOT case-folded: the registered casing is redacted, the lowercase twin
    // is left intact (folding an ID/key is meaningless and would risk matching unrelated text).
    expect(redacted.body).not.toContain("NSB-2026-0147");
    expect(redacted.body).toContain("nsb-2026-0147");
    expect(redacted.count).toBe(4); // Mauritius ×3 casings + NSB-2026-0147 ×1
    expect(redacted.leaks).toBe(0);

    // Each casing round-trips to its own surface form.
    const restored = scope.restoreText(redacted.body);
    expect(restored).toContain("Mauritius");
    expect(restored).toContain("MAURITIUS");
    expect(restored).toContain("mauritius");
  });

  it("persists registry case-variant mappings across requests in the same keyed scope", async () => {
    const engine = new ProtectionEngine({
      plugins: [],
      values: [{ name: "JURISDICTION", value: "Mauritius", source: "env-file", kind: "secret" }],
    });
    const key = "org-1:thread-1";
    const first = engine.beginRequest(key);
    const redacted = await first.redactBodyDetailed(JSON.stringify({ content: "Heading: MAURITIUS" }));
    expect(redacted.body).not.toContain("MAURITIUS");

    // A later stateful turn may receive a surrogate minted in an earlier turn without the raw value
    // appearing again in its request. Keyed scopes must retain the permanent-provenance mapping.
    const second = engine.beginRequest(key);
    expect(second.restoreText(redacted.body)).toContain("MAURITIUS");

    // The mapping remains isolated from other scope keys.
    expect(engine.beginRequest("org-2:thread-1").restoreText(redacted.body)).toBe(redacted.body);
  });

  it("withholds a registry secret's case-variant from tool-call arguments like the canonical form", async () => {
    // A caps twin of a registered secret is still that secret. It is registered into the scope's
    // registry-derived layer (permanent provenance), so the default restore-into-tools policy
    // (`detected`) must withhold BOTH forms from tool-call arguments — registering the variant as
    // `detected` would let a prompt-injected tool call exfiltrate the secret via its case variant.
    const saved = process.env.FICTA_RESTORE_INTO_TOOLS;
    delete process.env.FICTA_RESTORE_INTO_TOOLS; // default policy: "detected"
    try {
      const engine = new ProtectionEngine({
        plugins: [],
        values: [{ name: "CLIENT", value: "Mauritius Holdings", source: "env-file", kind: "secret" }],
      });
      const scope = engine.beginRequest();
      const body = JSON.stringify({ content: "Client Mauritius Holdings; heading MAURITIUS HOLDINGS." });
      const redacted = await scope.redactBodyDetailed(body);
      expect(redacted.leaks).toBe(0);
      const surrogates = [...new Set(redacted.body.match(/FICTA_[0-9a-f]{32}/g) ?? [])];
      expect(surrogates).toHaveLength(2);

      // Model places both surrogates into a tool-call argument (openai-chat buffered restore path).
      const toolBody = JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [{ function: { arguments: JSON.stringify({ cmd: surrogates.join(" ") }) } }],
            },
          },
        ],
      });
      const restored = scope.restoreJson(toolBody, "openai-chat");
      expect(restored).not.toContain("Mauritius Holdings"); // canonical: withheld
      expect(restored).not.toContain("MAURITIUS HOLDINGS"); // caps twin: withheld too (the fix)
      for (const surrogate of surrogates) expect(restored).toContain(surrogate);
      expect(scope.withheldFromToolsCount).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.FICTA_RESTORE_INTO_TOOLS;
      else process.env.FICTA_RESTORE_INTO_TOOLS = saved;
    }
  });

  it("isolates detector plugin exceptions", async () => {
    const engine = new ProtectionEngine({
      plugins: [
        {
          kind: "detector",
          name: "throwing-detector",
          detectText: () => {
            throw new Error("boom");
          },
        },
      ],
    });

    expect(await engine.redactBodyDetailed(JSON.stringify({ content: SECRET }))).toEqual({
      body: JSON.stringify({ content: SECRET }),
      count: 0,
      leaks: 0,
      hits: [],
      leakHits: [],
    });
  });

  it("supports request-time detector plugins for future PII-style values", async () => {
    const piiPlugin: DetectorPlugin = {
      kind: "detector",
      name: "fixture-pii-detector",
      detectText: (text) => {
        const emails = new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
        return [...emails].map((email) => ({
          name: "EMAIL",
          value: email,
          source: "fixture-detector",
          kind: "pii",
          confidence: "high",
        }));
      },
    };
    const engine = new ProtectionEngine({ plugins: [piiPlugin] });

    expect(engine.registrySize).toBe(0);
    expect(engine.enabled).toBe(true);

    const redacted = await engine.redactBodyDetailed(JSON.stringify({ content: `contact ${EMAIL}` }));
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(EMAIL);
    expect(engine.restoreText(redacted.body)).toContain(EMAIL);
  });

  it("stays disabled with no values and no detector plugins", () => {
    const engine = new ProtectionEngine({ plugins: [] });
    expect(engine.registrySize).toBe(0);
    expect(engine.size).toBe(0);
    expect(engine.enabled).toBe(false);
  });

  describe("trusted registry-policy exclusions reach every vault ingress", () => {
    const POLICY_ENV = [
      "FICTA_REGISTRY_DOPPLER_ENABLED",
      "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
      "FICTA_REGISTRY_ENV_FILE_ENABLED",
      "FICTA_REGISTRY_MANAGED_FILE_ENABLED",
    ] as const;
    let saved: Partial<Record<(typeof POLICY_ENV)[number], string>>;

    afterEach(() => {
      for (const key of POLICY_ENV) {
        if (saved?.[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("drops excluded names from opts.values and detector output but keeps real secrets", async () => {
      saved = Object.fromEntries(POLICY_ENV.map((k) => [k, process.env[k]]));
      // Keep launch sources quiet (no Doppler CLI spawn, no ambient env/.env) so the built-in
      // Doppler plugin contributes only its trusted DOPPLER_CONFIG metadata exclusion.
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_MANAGED_FILE_ENABLED = "0";

      const detector: DetectorPlugin = {
        kind: "detector",
        name: "fixture-detector",
        detectText: () => [
          {
            name: "DOPPLER_CONFIG",
            value: "detector-routing-label",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
          {
            name: "OTHER_SECRET",
            value: "real-secret-value-abc",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
        ],
      };

      const engine = new ProtectionEngine({
        plugins: [dopplerPlugin, detector],
        values: [
          {
            name: "DOPPLER_CONFIG",
            value: "opts-routing-label",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
          { name: "KEEP_ME", value: "kept-secret-value-xyz", source: "fixture", kind: "secret", confidence: "exact" },
        ],
      });

      // opts.values: DOPPLER_CONFIG excluded by the trusted Doppler rule, KEEP_ME registered.
      expect(engine.registrySize).toBe(1);

      const body = JSON.stringify({
        content: "detector-routing-label / real-secret-value-abc / opts-routing-label / kept-secret-value-xyz",
      });
      const redacted = await engine.redactBodyDetailed(body);

      expect(redacted.leaks).toBe(0);
      // Excluded names (from both detector and opts.values) are left intact.
      expect(redacted.body).toContain("detector-routing-label");
      expect(redacted.body).toContain("opts-routing-label");
      // Real secrets are still protected.
      expect(redacted.body).not.toContain("real-secret-value-abc");
      expect(redacted.body).not.toContain("kept-secret-value-xyz");
    });

    it("honors the user's FICTA_REGISTRY_EXCLUDE_NAMES at request-time detection", async () => {
      saved = Object.fromEntries(POLICY_ENV.map((k) => [k, process.env[k]]));
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_MANAGED_FILE_ENABLED = "0";
      const savedExclude = process.env.FICTA_REGISTRY_EXCLUDE_NAMES;
      process.env.FICTA_REGISTRY_EXCLUDE_NAMES = "BUILD_ID";
      try {
        const detector: DetectorPlugin = {
          kind: "detector",
          name: "fixture-detector",
          detectText: () => [
            { name: "BUILD_ID", value: "build-label-1234", source: "fixture", kind: "secret", confidence: "exact" },
            { name: "REAL", value: "real-secret-value-abc", source: "fixture", kind: "secret", confidence: "exact" },
          ],
        };
        const engine = new ProtectionEngine({ plugins: [detector] });
        const redacted = await engine.redactBodyDetailed(
          JSON.stringify({ content: "build-label-1234 / real-secret-value-abc" }),
        );

        expect(redacted.leaks).toBe(0);
        expect(redacted.body).toContain("build-label-1234"); // user-excluded, left intact
        expect(redacted.body).not.toContain("real-secret-value-abc"); // still protected
      } finally {
        if (savedExclude === undefined) delete process.env.FICTA_REGISTRY_EXCLUDE_NAMES;
        else process.env.FICTA_REGISTRY_EXCLUDE_NAMES = savedExclude;
      }
    });
  });
});
