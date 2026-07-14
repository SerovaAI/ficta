import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine/engine.js";
import {
  type ProtectionRecord,
  protectionRecordSurfaces,
  type StructuredRegistrySourceCapabilities,
} from "../src/engine/protection.js";
import { RedactionInvariantError } from "../src/engine/redaction-engine.js";
import {
  entityFamilySurrogateStrategy,
  hexSurrogateStrategy,
  type SurrogateStrategy,
  typedSurrogateStrategy,
} from "../src/engine/surrogate.js";
import { Vault } from "../src/engine/vault.js";
import { bufferedRestoreAdapterFor, sseRestoreAdapterFor } from "../src/engine/wire-restore.js";
import type { DetectorPlugin, RegistrySourcePlugin } from "../src/plugins/index.js";

const KEY = "phase-zero-entity-fidelity-key-at-least-32-bytes";
const CONTEXT = "thread:entity-fidelity-fixture";
const NORTHSTAR_ID = "entity-northstar-biologics";

afterEach(() => {
  delete process.env.FICTA_RESTORE_INTO_TOOLS;
  delete process.env.FICTA_SURROGATE_STYLE;
});

describe("entity-family surrogate contract", () => {
  it("matches the characterized canonical HMAC/base32 token exactly", () => {
    const strategy = entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY);

    const minted = strategy.mintEntity?.({
      protectionContextId: CONTEXT,
      entityId: NORTHSTAR_ID,
      entityType: "organization",
      exactSurface: "Northstar Biologics (Pty) Ltd",
    });

    expect(minted).toEqual({
      token: "FICTA_ORG_45SZ6UEHCLPT_ZWQCH5ASZWWH",
      entityTag: "45SZ6UEHCLPT",
      surfaceTag: "ZWQCH5ASZWWH",
    });
  });

  it("shares one entity tag across exact surfaces but scopes both tags to the protection context", () => {
    const strategy = entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY);
    const mint = (context: string, surface: string) =>
      strategy.mintEntity?.({
        protectionContextId: context,
        entityId: NORTHSTAR_ID,
        entityType: "organization",
        exactSurface: surface,
      });

    const canonical = mint(CONTEXT, "Northstar Biologics (Pty) Ltd");
    const short = mint(CONTEXT, "Northstar");
    const separate = mint("thread:separate", "Northstar");

    expect(canonical?.entityTag).toBe(short?.entityTag);
    expect(canonical?.surfaceTag).not.toBe(short?.surfaceTag);
    expect(short?.entityTag).not.toBe(separate?.entityTag);
    expect(short?.surfaceTag).not.toBe(separate?.surfaceTag);
    expect(
      entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY).mintEntity?.({
        protectionContextId: CONTEXT,
        entityId: NORTHSTAR_ID,
        entityType: "organization",
        exactSurface: "Northstar",
      }),
    ).toEqual(short);
  });

  it("delegates literals byte-for-byte to either shipped literal strategy", () => {
    for (const literal of [hexSurrogateStrategy(KEY), typedSurrogateStrategy(KEY)]) {
      const family = entityFamilySurrogateStrategy(literal, KEY);
      expect(family.mint("ZA-TRUST-0042", { name: "iban-code", kind: "secret" })).toBe(
        literal.mint("ZA-TRUST-0042", { name: "iban-code", kind: "secret" }),
      );
    }
  });

  it("rejects entity-tag and complete-token collisions without exposing identity values", () => {
    const base = entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY);
    const colliding: SurrogateStrategy = {
      ...base,
      mintEntity: ({ exactSurface }) => ({
        token: `FICTA_ORG_${"A".repeat(12)}_${(exactSurface === "Alpha" ? "B" : "C").repeat(12)}`,
        entityTag: "A".repeat(12),
        surfaceTag: exactSurface === "Alpha" ? "B".repeat(12) : "C".repeat(12),
      }),
    };
    const scope = new Vault([], colliding).beginScope(undefined, undefined, "thread:collision");
    scope.registerResolvedEntitySurface(
      { value: "Alpha", entityId: "entity-alpha", entityType: "organization" },
      "registry",
      true,
    );

    let thrown: unknown;
    try {
      scope.registerResolvedEntitySurface(
        { value: "Beta", entityId: "entity-beta", entityType: "organization" },
        "registry",
        true,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RedactionInvariantError);
    expect(String(thrown)).not.toContain("entity-alpha");
    expect(String(thrown)).not.toContain("entity-beta");
    expect(String(thrown)).not.toContain("Alpha");
    expect(String(thrown)).not.toContain("Beta");

    const completeCollision: SurrogateStrategy = {
      ...base,
      mintEntity: () => ({
        token: `FICTA_ORG_${"D".repeat(12)}_${"E".repeat(12)}`,
        entityTag: "D".repeat(12),
        surfaceTag: "E".repeat(12),
      }),
    };
    const completeScope = new Vault([], completeCollision).beginScope(undefined, undefined, "thread:collision");
    completeScope.registerResolvedEntitySurface(
      { value: "Gamma", entityId: "entity-gamma", entityType: "organization" },
      "registry",
      true,
    );
    expect(() =>
      completeScope.registerResolvedEntitySurface(
        { value: "Delta", entityId: "entity-gamma", entityType: "organization" },
        "registry",
        true,
      ),
    ).toThrowError("redaction invariant failed: entity-family complete-token collision");
  });
});

describe("engine entity-family rendering", () => {
  it("renders registered forms as one family, keeps literals opaque, and restores exact surfaces", async () => {
    const engine = fixtureEngine();
    const scope = engine.beginRequest(CONTEXT);
    const body = JSON.stringify({
      content: "Northstar Biologics (Pty) Ltd instructed Northstar. Amelia Naidoo approved account ZA-TRUST-0042.",
    });

    const redacted = await scope.redactBodyDetailed(body, { traceValues: true, traceOccurrences: true });
    const tokens = scope.mintedSurrogatesIn(redacted.body);
    const organizations = tokens.filter((token) => token.startsWith("FICTA_ORG_"));
    const people = tokens.filter((token) => token.startsWith("FICTA_PERSON_"));
    const literals = tokens.filter((token) => /^FICTA_[0-9a-f]{32}$/u.test(token));

    expect(organizations).toHaveLength(2);
    expect(new Set(organizations.map(entityTag))).toEqual(new Set([entityTag(organizations[0] ?? "")]));
    expect(people).toHaveLength(1);
    expect(literals).toHaveLength(1);
    expect(scope.restoreJson(redacted.body)).toBe(body);
    expect(redacted.traceOccurrences?.map((occurrence) => occurrence.surrogate)).toEqual(
      expect.arrayContaining(tokens),
    );
    expect(redacted.traceValues?.map((value) => value.surrogate)).toEqual(expect.arrayContaining(tokens));
    expect(scope.traceRestoreDetails().restored.map((value) => value.surrogate)).toEqual(
      expect.arrayContaining(tokens),
    );
  });

  it("keeps unkeyed scopes on literal rendering", async () => {
    const engine = fixtureEngine();
    const body = JSON.stringify({ content: "Northstar instructed Amelia Naidoo." });

    const result = await engine.redactBodyDetailed(body);

    expect(result.body).not.toContain("FICTA_ORG_");
    expect(result.body).not.toContain("FICTA_PERSON_");
    expect(result.body).toMatch(/FICTA_[0-9a-f]{32}/u);
    expect(engine.restoreText(result.body)).toBe(body);
  });

  it("keeps the configured typed style for literals in a keyed entity scope", async () => {
    const originalStyle = process.env.FICTA_SURROGATE_STYLE;
    try {
      process.env.FICTA_SURROGATE_STYLE = "typed";
      const scope = fixtureEngine().beginRequest(CONTEXT);
      const body = JSON.stringify({ content: "Northstar approved account ZA-TRUST-0042." });

      const result = await scope.redactBodyDetailed(body);

      expect(result.body).toMatch(/FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}/u);
      expect(result.body).toMatch(/FICTA_SECRET_[0-9a-f]{32}/u);
      expect(scope.restoreJson(result.body)).toBe(body);
    } finally {
      if (originalStyle === undefined) delete process.env.FICTA_SURROGATE_STYLE;
      else process.env.FICTA_SURROGATE_STYLE = originalStyle;
    }
  });

  it("keeps raw text surfaces literal after the same value renders as a body entity", async () => {
    const scope = fixtureEngine().beginRequest(CONTEXT);
    const body = JSON.stringify({ content: "Northstar approved." });

    const bodyResult = await scope.redactBodyDetailed(body);
    const headerResult = await scope.redactTextDetailed("Northstar", {
      surface: "header",
      preservePaths: false,
    });

    expect(bodyResult.body).toMatch(/FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}/u);
    expect(headerResult.text).toMatch(/^FICTA_[0-9a-f]{32}$/u);
    expect(scope.restoreJson(bodyResult.body)).toBe(body);
    expect(scope.restoreText(headerResult.text)).toBe("Northstar");
  });

  it("cannot correlate or restore a family token from another protection context", async () => {
    const engine = fixtureEngine();
    const first = engine.beginRequest("thread:first");
    const second = engine.beginRequest("thread:second");
    const body = JSON.stringify({ content: "Northstar approved." });

    const firstRedaction = await first.redactBodyDetailed(body);
    const secondRedaction = await second.redactBodyDetailed(body);
    const firstToken = first.mintedSurrogatesIn(firstRedaction.body)[0] ?? "";

    expect(firstRedaction.body).not.toBe(secondRedaction.body);
    expect(second.restoreText(firstToken)).toBe(firstToken);
    expect(first.restoreJson(firstRedaction.body)).toBe(body);
  });

  it("round-trips Markdown, possessives, casing, and reflowed registered forms byte-for-byte", async () => {
    const northstar = fixtureEngine().beginRequest(CONTEXT);
    const northstarBody = JSON.stringify({ content: "**Northstar** alleges; NORTHSTAR's tracker agrees." });
    const northstarRedaction = await northstar.redactBodyDetailed(northstarBody);
    const northstarTokens = northstar
      .mintedSurrogatesIn(northstarRedaction.body)
      .filter((token) => token.startsWith("FICTA_ORG_"));

    expect(northstarTokens).toHaveLength(2);
    expect(new Set(northstarTokens.map(entityTag)).size).toBe(1);
    expect(northstarRedaction.body).toMatch(/\*\*FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}\*\*/u);
    expect(northstarRedaction.body).toContain("'s tracker");
    expect(northstar.restoreJson(northstarRedaction.body)).toBe(northstarBody);

    const proximaEngine = new ProtectionEngine({
      plugins: [structuredRegistry([entityRecord("entity-proxima", "organization", "Proxima Medical Supplies CC")])],
    });
    const proxima = proximaEngine.beginRequest(CONTEXT);
    const proximaBody = JSON.stringify({ content: "Proxima Medical\nSupplies CC" });
    const proximaRedaction = await proxima.redactBodyDetailed(proximaBody);
    expect(proximaRedaction.body).toMatch(/FICTA_ORG_[A-Z2-7]{12}_[A-Z2-7]{12}/u);
    expect(proxima.restoreJson(proximaRedaction.body)).toBe(proximaBody);
  });

  it("gives a uniquely linked detector alias the registered entity family without upgrading its trust", async () => {
    const engine = new ProtectionEngine({
      plugins: [
        structuredRegistry([entityRecord(NORTHSTAR_ID, "organization", "Northstar Biologics (Pty) Ltd")]),
        organizationDetector("Northstar"),
      ],
    });
    const scope = engine.beginRequest(CONTEXT);
    const body = JSON.stringify({ content: "Northstar Biologics (Pty) Ltd instructed Northstar." });

    const redacted = await scope.redactBodyDetailed(body, { traceValues: true });
    const tokens = scope.mintedSurrogatesIn(redacted.body).filter((token) => token.startsWith("FICTA_ORG_"));

    expect(tokens).toHaveLength(2);
    expect(new Set(tokens.map(entityTag)).size).toBe(1);
    expect(redacted.traceValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "Northstar",
          provenance: "detected",
          surrogate: expect.stringMatching(/^FICTA_ORG_/u),
        }),
      ]),
    );
    expect(scope.restoreJson(redacted.body)).toBe(body);
  });

  it("round-trips an entity-family residual clipped by a higher-authority literal without persisting it", async () => {
    const detected = "Northstar-segment";
    const engine = new ProtectionEngine({
      plugins: [
        structuredRegistry([
          entityRecord("entity-northstar-segment", "organization", "Northstar-segment Holdings Ltd"),
          {
            protectionKind: "literal",
            protectionId: "segment-literal",
            value: "star-segment",
            authority: "registry",
            confidence: "exact",
            meta: {
              name: "segment",
              value: "star-segment",
              source: "fixture",
              kind: "secret",
              confidence: "exact",
            },
          },
        ]),
        organizationDetector(detected),
      ],
    });
    const key = "thread:clipped-family";
    const firstScope = engine.beginRequest(key);
    const body = JSON.stringify({ content: detected });

    const first = await firstScope.redactBodyDetailed(body);
    expect(first.count).toBe(2);
    expect(firstScope.mintedSurrogatesIn(first.body)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^FICTA_ORG_/u), expect.stringMatching(/^FICTA_[0-9a-f]{32}$/u)]),
    );
    expect(firstScope.restoreJson(first.body)).toBe(body);

    const later = await engine.beginRequest(key).redactBodyDetailed(JSON.stringify({ content: "North alone" }));
    expect(later.body).toContain("North alone");
  });
});

describe("entity-family restoration transports", () => {
  it("restores a complete known token across every raw-stream split and leaves mutations untouched", async () => {
    const { scope, token } = entityScope("Northstar", "registry");
    const text = `before ${token} after`;
    for (let cut = 1; cut < text.length; cut += 1) {
      expect(await transformText(scope.restoreStream(), [text.slice(0, cut), text.slice(cut)])).toBe(
        "before Northstar after",
      );
    }
    const mutated = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(scope.restoreText(mutated)).toBe(mutated);
    expect(scope.restoreText(token.slice(0, -1))).toBe(token.slice(0, -1));
  });

  it("restores family tokens through every supported buffered and SSE wire", async () => {
    for (const wire of ["anthropic", "openai-chat", "openai-responses"] as const) {
      const { scope, token } = entityScope("Northstar", "detected");
      const buffered = JSON.stringify({ content: [{ type: "text", text: token }] });
      expect(scope.restoreJson(buffered, bufferedRestoreAdapterFor(wire))).toContain("Northstar");

      const sse = `data: ${JSON.stringify({ content: token })}\n\n`;
      const restored = await transformText(scope.restoreEventStream(sseRestoreAdapterFor(wire)), [sse]);
      expect(restored).toContain("Northstar");
      expect(restored).not.toContain(token);
    }
  });

  it("reassembles family tokens split across semantic text deltas on every supported SSE wire", async () => {
    for (const wire of ["anthropic", "openai-chat", "openai-responses"] as const) {
      const { scope, token } = entityScope("Northstar", "detected");
      const cut = 17;
      const sse = textDeltaStream(wire, token.slice(0, cut), token.slice(cut));

      const restored = await transformText(scope.restoreEventStream(sseRestoreAdapterFor(wire)), [sse]);

      expect(restored).toContain("Northstar");
      expect(restored).not.toContain(token);
    }
  });

  it("reassembles split tool arguments and applies provenance on every supported SSE wire", async () => {
    for (const wire of ["anthropic", "openai-chat", "openai-responses"] as const) {
      const registry = entityScope("Northstar", "registry");
      const registryOut = await transformText(registry.scope.restoreEventStream(sseRestoreAdapterFor(wire)), [
        toolDeltaStream(wire, registry.token.slice(0, 17), registry.token.slice(17)),
      ]);
      expect(registryOut).toContain(registry.token);
      expect(registryOut).not.toContain("Northstar");
      expect(registry.scope.withheldFromToolsCount).toBe(1);

      const detected = entityScope("Proxima", "detected");
      const detectedOut = await transformText(detected.scope.restoreEventStream(sseRestoreAdapterFor(wire)), [
        toolDeltaStream(wire, detected.token.slice(0, 17), detected.token.slice(17)),
      ]);
      expect(detectedOut).toContain("Proxima");
      expect(detectedOut).not.toContain(detected.token);
    }
  });

  it("applies restore-into-tools provenance to entity-family tokens", () => {
    const registry = entityScope("Northstar", "registry");
    const detected = entityScope("Proxima", "detected");
    const registryBody = anthropicToolBody(registry.token);
    const detectedBody = anthropicToolBody(detected.token);

    expect(registry.scope.restoreJson(registryBody, bufferedRestoreAdapterFor("anthropic"))).toContain(registry.token);
    expect(detected.scope.restoreJson(detectedBody, bufferedRestoreAdapterFor("anthropic"))).toContain("Proxima");

    process.env.FICTA_RESTORE_INTO_TOOLS = "all";
    const optedIn = entityScope("Northstar", "registry");
    expect(
      optedIn.scope.restoreJson(anthropicToolBody(optedIn.token), bufferedRestoreAdapterFor("anthropic")),
    ).toContain("Northstar");
  });
});

function fixtureEngine(): ProtectionEngine {
  return new ProtectionEngine({
    plugins: [
      structuredRegistry([
        entityRecord(NORTHSTAR_ID, "organization", "Northstar Biologics (Pty) Ltd", ["Northstar"]),
        entityRecord("entity-amelia", "person", "Amelia Naidoo"),
        {
          protectionKind: "literal",
          protectionId: "account",
          value: "ZA-TRUST-0042",
          authority: "registry",
          confidence: "exact",
          meta: {
            name: "account",
            value: "ZA-TRUST-0042",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
        },
      ]),
    ],
  });
}

function entityRecord(
  entityId: string,
  entityType: "organization" | "person",
  canonical: string,
  forms: string[] = [],
): ProtectionRecord {
  return {
    protectionKind: "entity",
    entityId,
    entityType,
    canonical: { formId: `${entityId}:canonical`, value: canonical },
    forms: forms.map((value, index) => ({
      formId: `${entityId}:form:${index}`,
      value,
      kind: "short_name",
      boundary: "token",
    })),
    provenance: "registry",
    meta: {
      name: entityType,
      value: canonical,
      source: "fixture",
      kind: "pii",
      confidence: "exact",
    },
  };
}

function structuredRegistry(
  records: readonly ProtectionRecord[],
): RegistrySourcePlugin & StructuredRegistrySourceCapabilities {
  return {
    kind: "registry-source",
    name: "structured-fixture",
    config: { bindings: [], sections: [], envDefaults: {} },
    setup: { registrySources: () => [] },
    discover: () => [],
    loadValues: () => records.flatMap(protectionRecordSurfaces),
    loadProtectionRecords: () => records,
    fatalLoadErrors: true,
  };
}

function organizationDetector(value: string): DetectorPlugin {
  return {
    kind: "detector",
    name: "organization-fixture",
    bodyDetectionView: "content",
    detectText: (text) =>
      text.includes(value)
        ? [
            {
              name: "organization",
              value,
              source: "organization-fixture",
              kind: "pii",
              confidence: "high",
            },
          ]
        : [],
  };
}

function entityScope(surface: string, authority: "registry" | "detected") {
  const strategy = entityFamilySurrogateStrategy(hexSurrogateStrategy(KEY), KEY);
  const scope = new Vault([], strategy).beginScope(undefined, undefined, CONTEXT);
  const token = scope.registerResolvedEntitySurface(
    { value: surface, entityId: `${surface.toLowerCase()}-entity`, entityType: "organization" },
    authority,
    true,
  );
  return { scope, token };
}

function entityTag(token: string): string {
  return token.split("_")[2] ?? "";
}

function anthropicToolBody(token: string): string {
  return JSON.stringify({ content: [{ type: "tool_use", input: { party: token } }] });
}

function textDeltaStream(
  wire: "anthropic" | "openai-chat" | "openai-responses",
  first: string,
  second: string,
): string {
  if (wire === "anthropic") {
    return [
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: first },
      }),
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: second },
      }),
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    ].join("");
  }
  if (wire === "openai-chat") {
    return [
      sseEvent(undefined, { choices: [{ index: 0, delta: { content: first } }] }),
      sseEvent(undefined, { choices: [{ index: 0, delta: { content: second } }] }),
      "data: [DONE]\n\n",
    ].join("");
  }
  return [
    sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: first,
    }),
    sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: second,
    }),
    sseEvent("response.output_text.done", {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
    }),
  ].join("");
}

function toolDeltaStream(
  wire: "anthropic" | "openai-chat" | "openai-responses",
  first: string,
  second: string,
): string {
  if (wire === "anthropic") {
    return [
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: first },
      }),
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: second },
      }),
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    ].join("");
  }
  if (wire === "openai-chat") {
    return [
      sseEvent(undefined, {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: first } }] } }],
      }),
      sseEvent(undefined, {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: second } }] } }],
      }),
      "data: [DONE]\n\n",
    ].join("");
  }
  return [
    sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "call_1",
      delta: first,
    }),
    sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "call_1",
      delta: second,
    }),
    sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: "call_1",
    }),
  ].join("");
}

function sseEvent(event: string | undefined, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

async function transformText(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]): Promise<string> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let out = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  await pump;
  return out;
}
