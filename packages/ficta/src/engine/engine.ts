import { createHash } from "node:crypto";
import { detectorFailClosed } from "./detection-policy.js";
import { type EntityLinkAnchorIndex, entityLinkAnchorIndex, linkDetectedEntityClaims } from "./entity-linker.js";
import { expandEntities, expansionSpans } from "./expander.js";
import {
  type EntityClaim,
  mapJoinedOffsets,
  type Occurrence,
  type ResolvedOccurrence,
  resolveOccurrences,
  spliceResolvedOccurrences,
} from "./occurrence.js";
import { protectedValueExcludedBy } from "./plugins/policy.js";
import { defaultDetectors, loadPluginRegistry, type PluginRegistrySnapshot } from "./plugins/registry.js";
import type {
  DetectionProfile,
  DetectTextContext,
  FictaPluginBase,
  ProtectedValue,
  RedactionPlugin,
  RegistryPolicy,
} from "./plugins/types.js";
import {
  entityClaimsFromProtectionRecords,
  literalProtectionRecords,
  type ProtectionRecord,
  protectionRecordSurfaces,
} from "./protection.js";
import {
  type AmbiguousEntityLinkDiagnostic,
  type BodyRedactionContext,
  type BodyRedactionDetails,
  DetectorUnavailableError,
  type EngineRegistryStatus,
  type ProtectionHit,
  type ProtectionTraceOccurrence,
  type ProtectionTraceValue,
  type RedactionEngine,
  RedactionInvariantError,
  type RequestScope,
  type RequestScopeOptions,
  type RestoreOptions,
  type RestoreTraceDetails,
  type TextRedactionContext,
  type TextRedactionDetails,
} from "./redaction-engine.js";
import { entityFamilySurrogateStrategy, surrogateStrategy } from "./surrogate.js";
import { type BodyLeaf, type ScopedVault, type SurrogateTable, Vault, visitBodyLeaves } from "./vault.js";
import type { Wire } from "./wire.js";
import { bufferedRestoreAdapterFor, sseRestoreAdapterFor } from "./wire-restore.js";

export interface ProtectionEngineOptions {
  plugins?: readonly RedactionPlugin[];
  values?: readonly ProtectedValue[];
  /**
   * Plugins whose registry exclusions core should enforce (the un-protection fence). Defaults to the
   * engine's own plugin set — the caller of `new ProtectionEngine` curates that set (the proxy passes
   * the built-in `defaultRedactionPlugins`), so trusting it is equivalent to today's behaviour. The
   * fence against *external* plugins lives in the public `loadPluginRegistry` (see plugins/index.ts).
   */
  trusted?: ReadonlySet<FictaPluginBase>;
}

/** How long a keyed scope's detected PII may sit idle in memory before it is dropped. */
const KEYED_SCOPE_IDLE_TTL_MS = 30 * 60_000;
/** Upper bound on concurrently-retained keyed scopes (least-recently-used evicted first). */
const KEYED_SCOPE_MAX = 256;
/** Hard safety bounds for adversarial detector/expander output; invariant failures always block. */
const MAX_BODY_ENTITIES = 10_000;
const MAX_BODY_OCCURRENCES = 100_000;

/**
 * Persistent state for one scope key: the detected value↔surrogate layer shared by the key's
 * requests, that layer's value metadata, and hashes of body string-leaves every available detector
 * has already swept (so re-sent transcript prefixes are not re-detected each turn).
 */
interface KeyedScopeState {
  detected: SurrogateTable;
  registryDerived: SurrogateTable;
  metadata: Map<string, ProtectedValue[]>;
  tokenOnly: Set<string>;
  seenLeaves: Set<string>;
  /**
   * Canonical fingerprint of the detection profile the swept-leaf cache was built under. A scope
   * key outlives a thread's settings, so when the profile changes (e.g. a jurisdiction added
   * mid-thread) the cache must be dropped: leaves swept under the old profile were never offered
   * to the newly enabled detectors. Detected values/metadata survive — re-sweeping only costs
   * re-detection, and surrogates re-mint deterministically.
   */
  profileFingerprint: string;
  lastUsedAt: number;
}

/** Order-insensitive fingerprint for swept-leaf cache invalidation on profile change. */
function detectionProfileFingerprint(profile: DetectionProfile | undefined): string {
  return profile ? [...profile.jurisdictions].sort().join(",") : "";
}

interface BodyDocument {
  readonly body: string;
  readonly parsed?: unknown;
  readonly leaves: readonly BodyLeaf[];
  readonly isJson: boolean;
}

interface DetectionPass {
  readonly complete: boolean;
  readonly values: readonly ProtectedValue[];
}

interface BodyDetectedValue {
  readonly value: ProtectedValue;
  readonly leaves: readonly BodyLeaf[];
}

interface BodyDetectionPass {
  readonly complete: boolean;
  readonly detections: readonly BodyDetectedValue[];
}

/**
 * Security-critical orchestration layer and the built-in {@link RedactionEngine}. Plugins can only
 * add values; the vault does the actual replacement/restore/leak check. That keeps the core
 * invariant testable and plugin-agnostic.
 *
 * Registered secrets load once into a permanent vault shared by every request. Per-request detected
 * PII is isolated in a {@link ProtectionRequestScope} (see {@link beginRequest}): the proxy opens a
 * fresh scope per request so detected values are bounded and never restored across requests. The
 * engine's own redact/restore methods run against a single implicit default scope — the degenerate
 * "one process, one session" case (CLI agents, direct callers, tests).
 */
export class ProtectionEngine implements RedactionEngine {
  private readonly plugins: readonly RedactionPlugin[];
  private readonly hasDetectors: boolean;
  private readonly vault: Vault;
  private readonly policy: RegistryPolicy;
  /** Metadata for permanent (registered) values only; detected-value metadata lives on each scope. */
  private readonly metadataByValue = new Map<string, ProtectedValue[]>();
  /** Resolver inputs retain logical registry identities while the vault continues to own flattened surfaces. */
  private readonly permanentClaims: EntityClaim[];
  /** Records active in this process. Deletions and modifications remain active until restart. */
  private readonly activeRegistryRecords = new Map<string, ProtectionRecord>();
  /** Persistent per-key scope state (detected layer + metadata + swept-content hashes), LRU-ordered. */
  private readonly keyedScopes = new Map<string, KeyedScopeState>();
  private defaultRequestScope?: ProtectionRequestScope;

  /** The trusted plugin set used at launch; kept so a live registry reload enforces the same fence. */
  private readonly trusted: ReadonlySet<FictaPluginBase>;
  /** Current registry-source snapshot; replaced by {@link reloadRegistryValues}. */
  private registrySnapshot: PluginRegistrySnapshot;

  /** Safe registry-source diagnostics (refreshed by {@link reloadRegistryValues}); never raw values. */
  get registryStatus(): EngineRegistryStatus {
    return {
      discoveries: this.registrySnapshot.discoveries,
      registryPolicy: this.registrySnapshot.registryPolicy,
      policyExcluded: this.registrySnapshot.policyExcluded,
      policyExcludedBySource: this.registrySnapshot.policyExcludedBySource,
    };
  }

  /** Number of values loaded at construction time from exact-registry plugins ("as of launch" — see
   *  {@link size} for the live count after any {@link reloadRegistryValues}). */
  readonly registrySize: number;

  constructor(opts: ProtectionEngineOptions = {}) {
    this.plugins = opts.plugins ?? defaultDetectors;
    this.trusted = opts.trusted ?? new Set(this.plugins);
    this.registrySnapshot = loadPluginRegistry(this.plugins, this.trusted);
    // loadPluginRegistry already ran validatePluginBoundaries, so derive this directly rather than
    // calling pluginsHaveDetectors (which would re-validate every plugin).
    this.hasDetectors = this.plugins.some((plugin) => Boolean(plugin.detectText));
    this.policy = this.registrySnapshot.registryPolicy;
    // registry.values are already policy-filtered by loadPluginRegistry; caller-supplied opts.values
    // pass through the same enforced exclusions so every ingress into the vault is consistent.
    const admittedOptions = admit(opts.values ?? [], this.policy);
    const values = [...this.registrySnapshot.values, ...admittedOptions];
    for (const value of values) remember(this.metadataByValue, value);
    const optionRecords = literalProtectionRecords(admittedOptions, "registry");
    this.permanentClaims = entityClaimsFromProtectionRecords([...this.registrySnapshot.records, ...optionRecords]);
    for (const record of this.registrySnapshot.records) this.activeRegistryRecords.set(recordKey(record), record);
    this.registrySize = values.length;
    this.vault = new Vault(values, entityFamilySurrogateStrategy(surrogateStrategy()));
    applyRecordBoundaries(this.vault, this.registrySnapshot.records);
  }

  /**
   * Re-run the registry-source plugins and register any NEW values into the shared permanent vault —
   * the live-registry path (gateway "Publish to proxy" → managed registry file → reload endpoint).
   * Values arrive already policy-filtered by {@link loadPluginRegistry} (the same enforced-exclusion
   * seam as launch, under the same trusted set). New values are immediately protected: `size` /
   * `protecting` are live, every subsequent `beginRequest` scope (keyed scopes included) stacks over
   * this vault, and the entity expander reads the shared metadata map per request.
   *
   * DELETIONS ARE INTENTIONALLY NOT PROCESSED: the vault has no delete, and removing a value
   * mid-process would break restore of surrogates already sitting in transcripts. A value removed
   * from the registry file keeps redacting (privacy-favoring over-redaction) until process restart.
   *
   * Callers that want a file edit picked up must bust the source plugin's cache first (see
   * `resetManagedRegistryFilePluginCache`); the stat-based cache key covers ordinary edits.
   */
  reloadRegistryValues(): { added: number; total: number; restartRequired: boolean } {
    const snapshot = loadPluginRegistry(this.plugins, this.trusted);
    const nextByKey = new Map(snapshot.records.map((record) => [recordKey(record), record]));
    let restartRequired = false;
    for (const [key, active] of this.activeRegistryRecords) {
      const next = nextByKey.get(key);
      if (!next || recordFingerprint(next) !== recordFingerprint(active)) restartRequired = true;
    }

    const newRecords = snapshot.records.filter((record) => !this.activeRegistryRecords.has(recordKey(record)));
    const fresh = newRecords.flatMap(protectionRecordSurfaces);
    for (const value of fresh) remember(this.metadataByValue, value);
    const added = this.vault.register(fresh);
    this.permanentClaims.push(...entityClaimsFromProtectionRecords(newRecords));
    for (const record of newRecords) this.activeRegistryRecords.set(recordKey(record), record);
    applyRecordBoundaries(this.vault, [...this.activeRegistryRecords.values()]);
    this.registrySnapshot = snapshot; // discovery/policyExcluded lines in /__ficta/status reflect the reload
    return { added, total: this.vault.size, restartRequired };
  }

  get size(): number {
    return this.vault.size;
  }

  /** True when this engine may transform outbound data (has values or a detector is present). */
  get enabled(): boolean {
    return this.size > 0 || this.hasDetectors;
  }

  /**
   * True when protection is actually *configured* — registered values, or a detector reporting
   * itself active via `discover()`. Unlike `enabled` (true whenever a detector is merely present),
   * this is false during pure passthrough (no values, detector disabled), so the banner and request
   * path don't claim to redact when nothing is protected.
   */
  get protecting(): boolean {
    if (this.size > 0) return true;
    const inactive = new Set(["disabled", "not_found", "error"]);
    for (const plugin of this.plugins) {
      if (!plugin.detectText) continue;
      const discoveries = this.registrySnapshot.discoveries.filter((discovery) => discovery.plugin === plugin.name);
      // A detector counts as active unless its own discovery explicitly reports it inactive.
      if (discoveries.length === 0 || discoveries.some((discovery) => !inactive.has(discovery.status))) return true;
    }
    return false;
  }

  /**
   * Open a request-scoped view. Without a `scopeKey` the scope is an in-memory ephemeral layer over
   * the shared permanent vault, discarded when the caller drops it (the CLI/agent default).
   *
   * With a `scopeKey` (e.g. the web app's server-derived `org:thread` pair) the scope's detected
   * layer persists across that key's requests: a value detected on turn 1 stays redacted on turn 3
   * even if the detector misses it there, and detection can skip content it already swept (see
   * {@link ProtectionRequestScope.redactBodyDetailed}). Keys must be derived by a trusted caller —
   * the engine treats the key itself as the isolation boundary, exactly like the per-request case:
   * different keys can never restore each other's values. Keyed state holds raw detected PII in
   * memory beyond a single request, so it is bounded by an idle TTL and an LRU cap; eviction only
   * costs re-detection (deterministic surrogates re-mint identically), never a broken restore of a
   * future request.
   */
  beginRequest(scopeKey?: string, opts?: RequestScopeOptions): RequestScope {
    if (!scopeKey) {
      return new ProtectionRequestScope(
        this.plugins,
        this.policy,
        this.metadataByValue,
        this.permanentClaims,
        this.vault.beginScope(),
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        opts?.detectionProfile,
      );
    }
    const state = this.keyedScopeState(scopeKey, detectionProfileFingerprint(opts?.detectionProfile));
    return new ProtectionRequestScope(
      this.plugins,
      this.policy,
      this.metadataByValue,
      this.permanentClaims,
      this.vault.beginScope(state.detected, state.registryDerived, scopeKey),
      state.metadata,
      state.seenLeaves,
      state.tokenOnly,
      true,
      identifierHash(scopeKey),
      undefined,
      opts?.detectionProfile,
    );
  }

  private keyedScopeState(key: string, profileFingerprint: string): KeyedScopeState {
    const now = Date.now();
    const existing = this.keyedScopes.get(key);
    if (existing) this.keyedScopes.delete(key); // re-insert below so map order stays least-recently-used-first
    const state = existing ?? {
      detected: this.vault.newDetectedLayer(),
      registryDerived: this.vault.newRegistryDerivedLayer(),
      metadata: new Map<string, ProtectedValue[]>(),
      tokenOnly: new Set<string>(),
      seenLeaves: new Set<string>(),
      profileFingerprint,
      lastUsedAt: now,
    };
    if (state.profileFingerprint !== profileFingerprint) {
      state.seenLeaves.clear();
      state.profileFingerprint = profileFingerprint;
    }
    state.lastUsedAt = now;
    this.keyedScopes.set(key, state);
    this.evictKeyedScopes(now);
    return state;
  }

  /** Drop idle keyed scopes and enforce the LRU cap. Map order is LRU because touches re-insert. */
  private evictKeyedScopes(now: number): void {
    for (const [key, state] of this.keyedScopes) {
      const expired = now - state.lastUsedAt > KEYED_SCOPE_IDLE_TTL_MS;
      if (!expired && this.keyedScopes.size <= KEYED_SCOPE_MAX) break;
      this.keyedScopes.delete(key);
    }
  }

  // The engine's own redact/restore surface operates on a single implicit default scope — the
  // degenerate "one process, one session" case (CLI agents, direct callers, tests). The proxy does
  // NOT use these; it opens a fresh scope per request via beginRequest() for isolation.
  private get defaultScope(): ProtectionRequestScope {
    if (!this.defaultRequestScope) {
      this.defaultRequestScope = new ProtectionRequestScope(
        this.plugins,
        this.policy,
        this.metadataByValue,
        this.permanentClaims,
        this.vault.beginScope(),
      );
    }
    return this.defaultRequestScope;
  }

  redactBodyDetailed(body: string, ctx: BodyRedactionContext = {}): Promise<BodyRedactionDetails> {
    return this.defaultScope.redactBodyDetailed(body, ctx);
  }

  redactTextDetailed(text: string, ctx: TextRedactionContext = {}): Promise<TextRedactionDetails> {
    return this.defaultScope.redactTextDetailed(text, ctx);
  }

  /** Conservative raw-value membership check for deciding whether derived metadata is safe to log. */
  containsProtectedValue(text: string): boolean {
    return this.defaultScope.containsProtectedValue(text);
  }

  restoreText(text: string, opts?: RestoreOptions): string {
    return this.defaultScope.restoreText(text, opts);
  }

  restoreJson(body: string, wire?: Wire, opts?: RestoreOptions): string {
    return this.defaultScope.restoreJson(body, wire, opts);
  }

  restoreStream(opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array> {
    return this.defaultScope.restoreStream(opts);
  }

  restoreEventStream(wire: Wire, opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array> {
    return this.defaultScope.restoreEventStream(wire, opts);
  }
}

/**
 * One request's worth of redaction. Detection performed through it registers into the scope's
 * ephemeral vault layer and a scope-local metadata map, so nothing detected here mutates the shared
 * permanent vault or engine metadata. Restore and the `containsProtectedValue` check consult the
 * detected layer first, then the permanent one. When the scope is dropped at request end its detected
 * PII is garbage-collected and can never be restored into a later request's response.
 */
class ProtectionRequestScope implements RequestScope {
  private registryLinkingCache?: {
    permanentClaimsLength: number;
    registryClaims: EntityClaim[];
    anchorIndex: EntityLinkAnchorIndex;
  };

  constructor(
    private readonly plugins: readonly RedactionPlugin[],
    private readonly policy: RegistryPolicy,
    private readonly permanentMetadata: ReadonlyMap<string, ProtectedValue[]>,
    private readonly permanentClaims: readonly EntityClaim[],
    private readonly vault: ScopedVault,
    private readonly detectedMetadata: Map<string, ProtectedValue[]> = new Map(),
    /** Present only for keyed scopes: leaf hashes already swept by every available detector. */
    private readonly seenLeaves?: Set<string>,
    /** Resolver-clipped surfaces retain restore metadata but never become future entity candidates. */
    private readonly tokenOnly = new Set<string>(),
    /** Entity families require the trusted context supplied only by keyed request scopes. */
    private readonly hasTrustedEntityContext = false,
    /** One-way correlation boundary for values-free local ambiguity diagnostics. */
    private readonly protectionContextHash?: string,
    /** Explicit caller selections are re-seeded per request, never retained by a keyed scope. */
    private readonly userProtectedMetadata: Map<string, ProtectedValue[]> = new Map(),
    /** Additive-only jurisdiction widening injected into every detector ctx this scope builds. */
    private readonly detectionProfile?: DetectionProfile,
  ) {}

  registerProtectedValues(values: readonly ProtectedValue[]): void {
    let changed = false;
    for (const candidate of values) {
      const value = candidate.value.trim();
      if (!value) continue;
      const protectedValue: ProtectedValue = {
        name: candidate.name || "USER_SELECTED",
        value,
        source: candidate.source || "gateway-user",
        plugin: candidate.plugin,
        kind: candidate.kind ?? "custom",
        confidence: candidate.confidence ?? "exact",
      };
      remember(this.userProtectedMetadata, protectedValue);
      this.vault.registerUserProtectedSurface(protectedValue, true);
      changed = true;
    }
    if (changed) this.registryLinkingCache = undefined;
  }

  async redactBodyDetailed(body: string, ctx: BodyRedactionContext = {}): Promise<BodyRedactionDetails> {
    return this.redactBodyOccurrences(body, ctx);
  }

  private async redactBodyOccurrences(body: string, ctx: BodyRedactionContext): Promise<BodyRedactionDetails> {
    const { traceValues, traceOccurrences, ...detectCtx } = ctx;
    const document = bodyDocument(body);
    const seen = this.seenLeaves;
    const hashes = seen ? document.leaves.map((leaf) => leafHash(leaf.text)) : [];
    const freshLeaves = seen ? document.leaves.filter((_, i) => !seen.has(hashes[i] ?? "")) : document.leaves;
    const freshContentLeaves = freshLeaves.filter((leaf) => leaf.kind !== "key");
    const detection = await this.detectBodyValues(freshContentLeaves, freshLeaves, {
      ...detectCtx,
      surface: "body",
      detectionProfile: detectCtx.detectionProfile ?? this.detectionProfile,
    });
    if (seen && detection.complete) for (const hash of hashes) seen.add(hash);

    const { registryClaims, anchorIndex } = this.registryLinkingState();
    const detectedByValue = new Map<string, ProtectedValue>();
    for (const [value, metas] of this.detectedMetadata) {
      if (this.tokenOnly.has(value)) continue;
      const meta = metas[0];
      if (meta) detectedByValue.set(value, meta);
    }
    for (const { value } of detection.detections) detectedByValue.set(value.value, value);
    const detectedClaims = linkDetectedEntityClaims(
      anchorIndex,
      claimsFromValues([...detectedByValue.values()], "detected"),
    );
    const detectedClaimByValue = new Map(detectedClaims.map((claim) => [claim.meta.value, claim]));

    const occurrences: Occurrence[] = [];
    for (const { value, leaves: detectedLeaves } of detection.detections) {
      const claim = detectedClaimByValue.get(value.value);
      if (!claim) continue;
      const detectedText = detectedLeaves.map((leaf) => leaf.text).join("\n");
      const detectedTexts = detectedLeaves.map((leaf) => leaf.text);
      const detectedIndices = detectedLeaves.map((leaf) => leaf.index);
      let validSpans = value.spans !== undefined && value.spans.length > 0;
      if (validSpans) {
        for (const span of value.spans ?? []) {
          if (
            !Number.isSafeInteger(span.start) ||
            !Number.isSafeInteger(span.end) ||
            span.start < 0 ||
            span.end <= span.start ||
            span.end > detectedText.length
          ) {
            validSpans = false;
            break;
          }
          occurrences.push(
            ...mapJoinedOffsets(detectedTexts, detectedIndices, {
              start: span.start,
              end: span.end,
              origin: "detector",
              ...claim,
            }),
          );
        }
      }
      if (!validSpans) occurrences.push(...exactDetectorOccurrences(detectedLeaves, value.value, claim));
    }

    const allClaims = [...registryClaims, ...detectedClaims];
    if (allClaims.length > MAX_BODY_ENTITIES) throw new RedactionInvariantError("body entity limit exceeded");
    occurrences.push(
      ...expandEntities(
        document.leaves.map((leaf) => leaf.text),
        allClaims,
      ),
    );
    if (occurrences.length > MAX_BODY_OCCURRENCES) {
      throw new RedactionInvariantError("body occurrence limit exceeded");
    }
    const admissible = occurrences.filter((occurrence) => {
      const leaf = document.leaves[occurrence.leaf];
      return leaf !== undefined && this.vault.isRedactableRange(leaf.text, occurrence.start, occurrence.end);
    });
    const resolved = resolveOccurrences(admissible);
    if (resolved.length > MAX_BODY_OCCURRENCES) {
      throw new RedactionInvariantError("resolved body occurrence limit exceeded");
    }
    const ambiguityDiagnostics = resolvedAmbiguityDiagnostics(admissible, resolved, this.protectionContextHash);

    for (const { value } of detection.detections) remember(this.detectedMetadata, value);
    const replacements = new Map<number, string>();
    const owners = new Map<string, EntityClaim>();
    const renderedSurrogates = new Map<string, string>();
    const found = new Set<string>();
    const resolvedTrace: ProtectionTraceOccurrence[] = [];
    const matchSurfaces = new Set(
      resolved.filter((occurrence) => !occurrence.clipped).map((occurrence) => occurrence.surface),
    );
    for (const [leafIndex, claims] of groupResolvedByLeaf(resolved)) {
      const leaf = document.leaves[leafIndex];
      if (!leaf) continue;
      const rewritten = spliceResolvedOccurrences(leaf.text, claims, (occurrence) => {
        const surface = {
          ...occurrence.meta,
          value: occurrence.surface,
          wordBounded: occurrenceWordBounded(occurrence),
        };
        const userProtected = this.userProtectedMetadata.has(occurrence.entity.canonical);
        const token =
          this.hasTrustedEntityContext &&
          !userProtected &&
          occurrence.entity.protectionKind === "entity" &&
          occurrence.entity.entityType
            ? this.vault.registerResolvedEntitySurface(
                {
                  ...surface,
                  entityId: occurrence.entity.id,
                  entityType: occurrence.entity.entityType,
                },
                occurrence.mention.resolverAuthority,
                matchSurfaces.has(occurrence.surface),
              )
            : userProtected
              ? this.vault.registerUserProtectedSurface(surface, matchSurfaces.has(occurrence.surface))
              : this.vault.registerResolvedSurface(
                  surface,
                  occurrence.mention.resolverAuthority,
                  matchSurfaces.has(occurrence.surface),
                );
        if (traceOccurrences) {
          resolvedTrace.push({
            ...this.hitFromProtectedValue(occurrence.meta),
            leaf: occurrence.leaf,
            start: occurrence.start,
            end: occurrence.end,
            surrogate: token,
            origin: userProtected
              ? "user"
              : occurrence.mention.resolverAuthority === "registry"
                ? "registry"
                : "detected",
          });
        }
        renderedSurrogates.set(occurrence.surface, token);
        found.add(occurrence.surface);
        const owner = owners.get(occurrence.surface);
        const occurrenceClaim: EntityClaim = {
          entity: occurrence.entity,
          meta: occurrence.meta,
          mention: occurrence.mention,
        };
        if (!owner || occurrence.mention.resolverAuthority === "registry") {
          owners.set(occurrence.surface, occurrenceClaim);
        }
        if (!userProtected) {
          remember(this.detectedMetadata, { ...occurrence.meta, value: occurrence.surface });
          if (matchSurfaces.has(occurrence.surface)) this.tokenOnly.delete(occurrence.surface);
          else this.tokenOnly.add(occurrence.surface);
        }
        return token;
      });
      if (rewritten !== leaf.text) replacements.set(leafIndex, rewritten);
    }

    const redactedBody = renderBodyDocument(document, replacements);
    const leakValues = this.vault.leakValues(redactedBody);
    const leakValueSet = new Set(leakValues);
    const leakOwners = entityOwners(allClaims);
    // The string catalog catches exact known surfaces. Re-scan the already-redacted body against
    // logical entity policy as an independent backstop for case/whitespace variants that were not
    // admitted to the catalog because downstream resolution/catalog registration missed them.
    for (const [surface, owner] of entityPolicyLeakOwners(redactedBody, allClaims, this.vault)) {
      if (!leakValueSet.has(surface)) {
        leakValueSet.add(surface);
        leakValues.push(surface);
      }
      preferOwner(leakOwners, surface, owner);
    }
    const details: BodyRedactionDetails = {
      body: redactedBody,
      count: found.size,
      leaks: leakValues.length,
      hits: this.hitsForEntities([...owners.values()]),
      leakHits: this.hitsForOwnedValues(leakValues, leakOwners),
      ambiguousEntityLinks: ambiguityDiagnostics.length,
    };
    if (traceValues) {
      if (found.size > 0) details.traceValues = this.traceValuesForOwnedValues(found, owners, renderedSurrogates);
      if (leakValues.length > 0) details.traceLeakValues = this.traceValuesForOwnedValues(leakValues, leakOwners);
    }
    if (traceOccurrences && resolvedTrace.length > 0) {
      details.traceOccurrences = resolvedTrace.sort((a, b) => a.leaf - b.leaf || a.start - b.start || b.end - a.end);
    }
    if (traceValues && ambiguityDiagnostics.length > 0) {
      details.traceAmbiguousEntityLinks = ambiguityDiagnostics;
    }
    return details;
  }

  private registryLinkingState(): {
    registryClaims: readonly EntityClaim[];
    anchorIndex: EntityLinkAnchorIndex;
  } {
    const cached = this.registryLinkingCache;
    if (cached && cached.permanentClaimsLength === this.permanentClaims.length) return cached;
    const registryClaims = [...this.permanentClaims, ...claimsFromMetadata(this.userProtectedMetadata, "registry")];
    const refreshed = {
      permanentClaimsLength: this.permanentClaims.length,
      registryClaims,
      anchorIndex: entityLinkAnchorIndex(registryClaims),
    };
    this.registryLinkingCache = refreshed;
    return refreshed;
  }

  async redactTextDetailed(text: string, ctx: TextRedactionContext = {}): Promise<TextRedactionDetails> {
    // preservePaths defaults true (the query surface keeps real paths like redirect_uri intact); the
    // proxy passes false for headers so a secret inside a slash-path is redacted, not preserved.
    const { surface = "header", preservePaths = true, traceValues, ...rest } = ctx;
    await this.registerDetectedValues(text, {
      ...rest,
      surface,
      detectionProfile: rest.detectionProfile ?? this.detectionProfile,
    });
    const redacted = this.vault.redactTextDetailed(text, preservePaths);
    const leakValues = this.vault.leakValues(redacted.text, preservePaths);
    const details: TextRedactionDetails = {
      text: redacted.text,
      count: redacted.count,
      leaks: leakValues.length,
      hits: this.hitsFor(redacted.values),
      leakHits: this.hitsFor(leakValues),
    };
    if (traceValues) {
      if (redacted.values.length > 0) details.traceValues = this.traceValuesFor(redacted.values);
      if (leakValues.length > 0) details.traceLeakValues = this.traceValuesFor(leakValues);
    }
    return details;
  }

  restoreText(text: string, opts?: RestoreOptions): string {
    return this.vault.restoreText(text, opts);
  }

  restoreJson(body: string, wire: Wire = "unknown", opts?: RestoreOptions): string {
    return this.vault.restoreJson(body, bufferedRestoreAdapterFor(wire), opts);
  }

  restoreStream(opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array> {
    return this.vault.restoreStream(opts);
  }

  restoreEventStream(wire: Wire, opts?: RestoreOptions): TransformStream<Uint8Array, Uint8Array> {
    return this.vault.restoreEventStream(sseRestoreAdapterFor(wire), bufferedRestoreAdapterFor(wire), opts);
  }

  get restoredCount(): number {
    return this.vault.restoredCount;
  }

  get withheldFromToolsCount(): number {
    return this.vault.withheldFromToolsCount;
  }

  get residualSurrogateCount(): number {
    return this.vault.residualSurrogateCount;
  }

  traceRestoreDetails(): RestoreTraceDetails {
    return {
      restored: this.traceEntries(this.vault.traceRestoredValues()),
      withheldFromTools: this.traceEntries(this.vault.traceWithheldValues()),
    };
  }

  /** Membership check over this scope's detected values and the permanent registry. */
  containsProtectedValue(text: string): boolean {
    return this.vault.containsKnownValue(text, false);
  }

  mintedSurrogatesIn(text: string): string[] {
    return this.vault.surrogatesIn(text);
  }

  /** Returns true when every detector ran (nothing was skipped by a fail-open outage or crash). */
  private async registerDetectedValues(text: string, ctx: DetectTextContext): Promise<boolean> {
    const detection = await this.detectValues(text, ctx);
    for (const value of detection.values) remember(this.detectedMetadata, value);
    this.vault.register(detection.values);
    return detection.complete;
  }

  private async detectValues(text: string, ctx: DetectTextContext): Promise<DetectionPass> {
    if (!text) return { complete: true, values: [] };
    let complete = true;
    const values: ProtectedValue[] = [];
    for (const plugin of this.plugins) {
      let detected: readonly ProtectedValue[];
      try {
        detected = (await plugin.detectText?.(text, ctx)) ?? [];
      } catch (err) {
        // Detector plugins are best-effort and must not take down the exact-match proxy path. A
        // detector only *signals* a backend outage (DetectorUnavailableError); core owns the policy:
        // resolve the detector's own fail-closed override against the global default and either block
        // (re-raise → server.ts refuses to forward) or skip detection for this request (continue).
        if (err instanceof DetectorUnavailableError) {
          const override = plugin.kind === "detector" ? plugin.failClosed?.() : undefined;
          if (detectorFailClosed(override)) throw err;
          complete = false;
          continue;
        }
        complete = false;
        continue;
      }
      if (detected.length === 0) continue;
      const candidates = detected.map((value) => ({ ...value, plugin: value.plugin ?? plugin.name }));
      values.push(...admit(candidates, this.policy));
    }
    return { complete, values };
  }

  private async detectBodyValues(
    contentLeaves: readonly BodyLeaf[],
    allLeaves: readonly BodyLeaf[],
    ctx: DetectTextContext,
  ): Promise<BodyDetectionPass> {
    let complete = true;
    const detections: BodyDetectedValue[] = [];
    for (const plugin of this.plugins) {
      // NLP detectors opt into content-only leaves so protocol/object keys never contaminate spans.
      // Exact structural detectors retain key context (e.g. `api_token` followed by its value).
      const leaves = plugin.bodyDetectionView === "content" ? contentLeaves : allLeaves;
      const text = leaves.map((leaf) => leaf.text).join("\n");
      if (!text) continue;
      let detected: readonly ProtectedValue[];
      try {
        detected = (await plugin.detectText?.(text, ctx)) ?? [];
      } catch (err) {
        if (err instanceof DetectorUnavailableError) {
          const override = plugin.kind === "detector" ? plugin.failClosed?.() : undefined;
          if (detectorFailClosed(override)) throw err;
          complete = false;
          continue;
        }
        complete = false;
        continue;
      }
      const candidates = detected.map((value) => ({ ...value, plugin: value.plugin ?? plugin.name }));
      for (const value of admit(candidates, this.policy)) detections.push({ value, leaves });
    }
    return { complete, detections };
  }

  /** Stored metadata fallback for header/query redaction and later response restore traces. */
  private storedMetadataFor(raw: string): ProtectedValue | undefined {
    return (this.permanentMetadata.get(raw) ??
      this.userProtectedMetadata.get(raw) ??
      this.detectedMetadata.get(raw))?.[0];
  }

  private hitsForEntities(claims: readonly EntityClaim[]): ProtectionHit[] {
    // One entry per distinct redacted surface, even when several surfaces share the same safe label.
    // ProtectionStats groups these entries to produce actual per-label value counts; deduplicating
    // metadata here made three PERSON values look like one.
    return claims.map((claim) => this.hitFromProtectedValue(claim.meta));
  }

  private hitsForOwnedValues(values: readonly string[], owners: ReadonlyMap<string, EntityClaim>): ProtectionHit[] {
    const claims = values.flatMap((value) => {
      const owner = owners.get(value);
      return owner ? [owner] : [];
    });
    const hits = this.hitsForEntities(claims);
    if (hits.length > 0 || values.length === 0) return hits;
    return this.hitsFor(values);
  }

  private traceValuesForOwnedValues(
    values: Iterable<string>,
    owners: ReadonlyMap<string, EntityClaim>,
    renderedSurrogates: ReadonlyMap<string, string> = new Map(),
  ): ProtectionTraceValue[] {
    return this.vault.traceValues(values).map((entry) => {
      const owner = owners.get(entry.value);
      const meta = owner?.meta ?? this.storedMetadataFor(entry.value);
      const hit = meta === undefined ? unknownHit() : this.hitFromProtectedValue(meta);
      const trace: ProtectionTraceValue = { ...hit, value: entry.value, valueSha256: valueHash(entry.value) };
      const rendered = renderedSurrogates.get(entry.value);
      if (rendered !== undefined) trace.surrogate = rendered;
      else if (entry.surrogate !== undefined) trace.surrogate = entry.surrogate;
      if (owner) trace.provenance = owner.mention.resolverAuthority === "detected" ? "detected" : "permanent";
      else if (entry.provenance !== undefined) trace.provenance = entry.provenance;
      return trace;
    });
  }

  private hitsFor(values: readonly string[]): ProtectionHit[] {
    return values.map((raw) => {
      const value = this.storedMetadataFor(raw);
      return value === undefined ? unknownHit() : this.hitFromProtectedValue(value);
    });
  }

  private traceValuesFor(values: Iterable<string>): ProtectionTraceValue[] {
    return this.traceEntries(this.vault.traceValues(values));
  }

  private traceEntries(entries: ReturnType<ScopedVault["traceValues"]>): ProtectionTraceValue[] {
    return entries.map((entry) => {
      const value = this.storedMetadataFor(entry.value);
      const hit = value === undefined ? unknownHit() : this.hitFromProtectedValue(value);
      const trace: ProtectionTraceValue = {
        ...hit,
        value: entry.value,
        valueSha256: valueHash(entry.value),
      };
      if (entry.surrogate !== undefined) trace.surrogate = entry.surrogate;
      if (entry.provenance !== undefined) trace.provenance = entry.provenance;
      return trace;
    });
  }

  private hitFromProtectedValue(value: ProtectedValue): ProtectionHit {
    const hit: ProtectionHit = {
      name: this.safeMetadataField(value.name, "<redacted-name>"),
      source: this.safeMetadataField(value.source, "<redacted-source>"),
    };
    if (value.plugin) hit.plugin = this.safeMetadataField(value.plugin, "<redacted-plugin>");
    if (value.kind) hit.kind = value.kind;
    if (value.confidence) hit.confidence = value.confidence;
    return hit;
  }

  private safeMetadataField(value: string | undefined, fallback: string): string {
    const text = value?.trim();
    if (!text) return fallback;
    return this.containsProtectedValue(text) ? fallback : text;
  }
}

function bodyDocument(body: string): BodyDocument {
  try {
    const parsed: unknown = JSON.parse(body);
    const leaves: BodyLeaf[] = [];
    visitBodyLeaves(parsed, (leaf) => {
      leaves.push(leaf);
    });
    return { body, parsed, leaves, isJson: true };
  } catch {
    const leaves: BodyLeaf[] = [];
    visitBodyLeaves(
      body,
      (leaf) => {
        leaves.push(leaf);
      },
      "raw",
    );
    return { body, leaves, isJson: false };
  }
}

function renderBodyDocument(document: BodyDocument, replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) return document.body;
  if (!document.isJson) return replacements.get(0) ?? document.body;
  const mapped = visitBodyLeaves(document.parsed, (leaf) => replacements.get(leaf.index));
  return JSON.stringify(mapped);
}

function claimsFromMetadata(
  metadata: ReadonlyMap<string, readonly ProtectedValue[]>,
  authority: "registry" | "detected",
): EntityClaim[] {
  const values: ProtectedValue[] = [];
  for (const [value, metas] of metadata) {
    const meta = metas[0];
    if (meta) values.push({ ...meta, value });
  }
  return claimsFromValues(values, authority);
}

function claimsFromValues(values: readonly ProtectedValue[], authority: "registry" | "detected"): EntityClaim[] {
  return entityClaimsFromProtectionRecords(literalProtectionRecords(values, authority));
}

function recordKey(record: ProtectionRecord): string {
  return record.protectionKind === "entity" ? record.entityId : record.protectionId;
}

function recordFingerprint(record: ProtectionRecord): string {
  if (record.protectionKind === "literal") {
    return JSON.stringify({
      protectionKind: record.protectionKind,
      value: record.value,
      semanticType: record.semanticType,
      authority: record.authority,
      confidence: record.confidence,
      meta: record.meta,
    });
  }
  return JSON.stringify({
    protectionKind: record.protectionKind,
    entityType: record.entityType,
    canonical: record.canonical,
    forms: [...record.forms].sort((a, b) => a.formId.localeCompare(b.formId)),
    provenance: record.provenance,
    meta: record.meta,
  });
}

function applyRecordBoundaries(vault: Vault, records: readonly ProtectionRecord[]): void {
  const policies = new Map<string, boolean>();
  for (const record of records) {
    if (record.protectionKind === "literal") {
      policies.set(record.value, false);
      continue;
    }
    policies.set(record.canonical.value, false);
    for (const form of record.forms) {
      if (policies.get(form.value) !== false) policies.set(form.value, form.boundary === "token");
    }
  }
  for (const [value, wordBounded] of policies) vault.setWordBounded(value, wordBounded);
}

function occurrenceWordBounded(occurrence: Occurrence): boolean {
  if (occurrence.entity.protectionKind !== "entity") return false;
  if (occurrence.mention.linkSource === "deterministic_alias") return true;
  if (
    expansionSpans(occurrence.surface, occurrence.entity.canonical, { caseInsensitive: true }).some(
      ({ start, end }) => start === 0 && end === occurrence.surface.length,
    )
  ) {
    return false;
  }
  let matchedToken = false;
  for (const form of occurrence.entity.forms) {
    const matchesSurface = expansionSpans(occurrence.surface, form.value, { caseInsensitive: true }).some(
      ({ start, end }) => start === 0 && end === occurrence.surface.length,
    );
    if (!matchesSurface) continue;
    if (form.boundary === "substring") return false;
    matchedToken = true;
  }
  return matchedToken;
}

function exactDetectorOccurrences(leaves: readonly BodyLeaf[], value: string, claim: EntityClaim): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const leaf of leaves) {
    for (const span of expansionSpans(leaf.text, value)) {
      occurrences.push({ leaf: leaf.index, ...span, origin: "detector", ...claim });
    }
  }
  return occurrences;
}

function groupResolvedByLeaf(resolved: readonly ResolvedOccurrence[]): Map<number, ResolvedOccurrence[]> {
  const grouped = new Map<number, ResolvedOccurrence[]>();
  for (const occurrence of resolved) {
    const claims = grouped.get(occurrence.leaf) ?? [];
    claims.push(occurrence);
    grouped.set(occurrence.leaf, claims);
  }
  return grouped;
}

function entityOwners(claims: readonly EntityClaim[]): Map<string, EntityClaim> {
  const owners = new Map<string, EntityClaim>();
  for (const claim of claims) {
    preferOwner(owners, claim.entity.canonical, claim);
    for (const form of claim.entity.forms) preferOwner(owners, form.value, claim);
  }
  return owners;
}

/** Logical-entity leak scan, deliberately independent of which surfaces the resolver registered. */
function entityPolicyLeakOwners(
  body: string,
  claims: readonly EntityClaim[],
  vault: ScopedVault,
): Map<string, EntityClaim> {
  const document = bodyDocument(body);
  const owners = new Map<string, EntityClaim>();
  const occurrences = expandEntities(
    document.leaves.map((leaf) => leaf.text),
    claims,
  );
  if (occurrences.length > MAX_BODY_OCCURRENCES) {
    throw new RedactionInvariantError("body leak-gate occurrence limit exceeded");
  }
  for (const occurrence of occurrences) {
    const leaf = document.leaves[occurrence.leaf];
    if (!leaf || !vault.isRedactableRange(leaf.text, occurrence.start, occurrence.end)) continue;
    preferOwner(owners, occurrence.surface, occurrence);
  }
  return owners;
}

function preferOwner(owners: Map<string, EntityClaim>, surface: string, candidate: EntityClaim): void {
  const current = owners.get(surface);
  if (
    !current ||
    (current.mention.resolverAuthority === "detected" && candidate.mention.resolverAuthority === "registry")
  ) {
    owners.set(surface, candidate);
  }
}

/** Content hash for the swept-leaf ledger; hashes are retained, never the leaf text itself. */
function leafHash(leaf: string): string {
  return createHash("sha256").update(leaf).digest("hex");
}

function valueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identifierHash(value: string): string {
  return valueHash(value).slice(0, 16);
}

function resolvedAmbiguityDiagnostics(
  admissible: readonly Occurrence[],
  resolved: readonly ResolvedOccurrence[],
  contextHash: string | undefined,
): AmbiguousEntityLinkDiagnostic[] {
  const winning = resolved.filter((occurrence) => occurrence.ambiguousEntityLink !== undefined);
  if (winning.length === 0) return [];
  const seen = new Set<string>();
  const diagnostics: AmbiguousEntityLinkDiagnostic[] = [];
  for (const occurrence of admissible) {
    const ambiguity = occurrence.ambiguousEntityLink;
    if (!ambiguity) continue;
    const key = `${occurrence.entity.id}\0${occurrence.leaf}\0${occurrence.start}\0${occurrence.end}`;
    if (seen.has(key)) continue;
    const survived = winning.some(
      (candidate) =>
        candidate.entity.id === occurrence.entity.id &&
        candidate.leaf === occurrence.leaf &&
        candidate.start < occurrence.end &&
        candidate.end > occurrence.start,
    );
    if (!survived) continue;
    seen.add(key);
    const diagnostic: AmbiguousEntityLinkDiagnostic = {
      code: ambiguity.code,
      linkingRule: ambiguity.linkingRule,
      leaf: occurrence.leaf,
      start: occurrence.start,
      end: occurrence.end,
      candidateCount: ambiguity.candidateEntityIds.length,
      candidateEntityIds: ambiguity.candidateEntityIds.map(identifierHash).sort(),
    };
    if (contextHash) diagnostic.contextHash = contextHash;
    diagnostics.push(diagnostic);
  }
  return diagnostics.sort((a, b) => a.leaf - b.leaf || a.start - b.start || a.end - b.end);
}

/** Drop named candidates excluded by an enforced (trusted) registry-policy rule. */
function admit(values: readonly ProtectedValue[], policy: RegistryPolicy): ProtectedValue[] {
  return values.filter((value) => !protectedValueExcludedBy(value, policy));
}

function remember(metadata: Map<string, ProtectedValue[]>, value: ProtectedValue): void {
  if (!value.value) return;
  const existing = metadata.get(value.value) ?? [];
  // Detector spans are coordinates in one request's detectText() input. Persisting them into the
  // engine or a keyed scope would make request N's offsets appear to describe request N+1.
  const { spans: _spans, ...persistent } = value;
  existing.push(persistent);
  metadata.set(value.value, existing);
}

function unknownHit(): ProtectionHit {
  return { name: "<unknown>", source: "unknown" };
}
