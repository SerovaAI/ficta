import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ProtectionHit,
  ProtectionStatsBlockReason,
  ProtectionStatsBucket,
  ProtectionStatsEvent,
  ProtectionStatsLabelBucket,
  ProtectionStatsSnapshot,
  ProtectionStatsSurface,
  ProtectionStatsTotals,
} from "@serovaai/ficta-protocol";
import { plural } from "./engine/text.js";
import type { Wire } from "./engine/wire.js";

export type ProtectionSurface = ProtectionStatsSurface;
export type { ProtectionStatsSnapshot };

interface ProtectionStatsRecord {
  requestId?: number;
  method: string;
  path: string;
  wire: Wire;
  route?: string;
  model?: string;
  surface: ProtectionSurface;
  redactedValues: number;
  survivingValues: number;
  blocked: boolean;
  ambiguousEntityLinks?: number;
  blockReason?: ProtectionStatsBlockReason;
  redactedHits?: readonly ProtectionHit[];
  survivingHits?: readonly ProtectionHit[];
}

interface MutableBucket {
  name: string;
  requestKeys: Set<string>;
  redactedValues: number;
  survivingValues: number;
  blockedRequestKeys: Set<string>;
  keptOutOfModelValues: number;
}

interface MutableLabelBucket extends MutableBucket {
  source: string;
  plugin?: string;
  kind?: ProtectionHit["kind"];
  confidence?: ProtectionHit["confidence"];
}

export class ProtectionStats {
  private readonly startedAt = new Date().toISOString();
  private readonly events: ProtectionStatsEvent[] = [];
  private restoredValuesTotal = 0;
  private withheldFromToolsValuesTotal = 0;
  private residualSurrogateValuesTotal = 0;
  readonly path: string;
  private readonly captureDir?: () => string | undefined;

  constructor(path: string, opts: { captureDir?: () => string | undefined } = {}) {
    this.path = path;
    this.captureDir = opts.captureDir;
  }

  /** Cumulative distinct values restored into responses this run. */
  get restoredValues(): number {
    return this.restoredValuesTotal;
  }

  /** Cumulative values withheld from tool-call arguments this run. */
  get withheldFromToolsValues(): number {
    return this.withheldFromToolsValuesTotal;
  }

  /** Cumulative unmapped surrogate-shaped tokens that survived restore this run (values-free). */
  get residualSurrogateValues(): number {
    return this.residualSurrogateValuesTotal;
  }

  /**
   * Record a response's restore outcome: how many distinct values went back in, how many were held
   * back from tool-call arguments (restore-into-tools withholding), and how many surrogate-shaped
   * tokens survived restore unmapped (model-mutated/invented — token debris the client received).
   * Totals-only — restore has no per-hit event record the way redaction does. Skips the disk write
   * when there is nothing new.
   */
  recordRestore(outcome: {
    restoredValues: number;
    withheldFromToolsValues: number;
    residualSurrogateValues?: number;
  }): void {
    const residuals = outcome.residualSurrogateValues ?? 0;
    if (outcome.restoredValues <= 0 && outcome.withheldFromToolsValues <= 0 && residuals <= 0) return;
    this.restoredValuesTotal += Math.max(0, outcome.restoredValues);
    this.withheldFromToolsValuesTotal += Math.max(0, outcome.withheldFromToolsValues);
    this.residualSurrogateValuesTotal += Math.max(0, residuals);
    this.write();
  }

  record(record: ProtectionStatsRecord): void {
    // Detector outages have no value counts because screening could not run, but the fail-closed
    // decision is still first-class protection proof and must survive in the stats stream.
    if (
      record.redactedValues <= 0 &&
      record.survivingValues <= 0 &&
      (record.ambiguousEntityLinks ?? 0) <= 0 &&
      record.blockReason === undefined
    ) {
      return;
    }
    const event: ProtectionStatsEvent = {
      index: this.events.length + 1,
      at: new Date().toISOString(),
      method: record.method,
      path: record.path,
      wire: record.wire,
      surface: record.surface,
      redactedValues: record.redactedValues,
      survivingValues: record.survivingValues,
      blocked: record.blocked,
      ambiguousEntityLinks: Math.max(0, record.ambiguousEntityLinks ?? 0),
      model: normalizeModel(record.model),
      redactedHits: [...(record.redactedHits ?? [])],
      survivingHits: [...(record.survivingHits ?? [])],
    };
    if (record.blockReason) event.blockReason = record.blockReason;
    if (record.requestId !== undefined) event.requestId = record.requestId;
    if (record.route) event.route = record.route;
    this.events.push(event);
    this.write();
  }

  snapshot(): ProtectionStatsSnapshot {
    const updatedAt = new Date().toISOString();
    const totals = this.totals();
    return {
      version: 1,
      path: this.path,
      startedAt: this.startedAt,
      updatedAt,
      totals,
      byModel: this.groupBy((event) => event.model),
      bySurface: this.groupBy((event) => event.surface),
      byWire: this.groupBy((event) => event.wire),
      byLabel: this.groupByLabel(),
      events: [...this.events],
    };
  }

  write(): void {
    const data = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    writeFileSync(this.path, data, { mode: 0o600 });
    const captureDir = this.captureDir?.();
    if (captureDir) writeFileSync(join(captureDir, "stats.json"), data, { mode: 0o600 });
  }

  renderSummary(): string {
    return renderProtectionStatsSummary(this.snapshot());
  }

  private totals(): ProtectionStatsTotals {
    const affectedRequestKeys = new Set<string>();
    const blockedRequestKeys = new Set<string>();
    const ambiguousRequestKeys = new Set<string>();
    let redactedValues = 0;
    let survivingValues = 0;
    let keptOutOfModelValues = 0;
    let ambiguousEntityLinks = 0;
    for (const event of this.events) {
      const key = requestKey(event);
      affectedRequestKeys.add(key);
      redactedValues += event.redactedValues;
      survivingValues += event.survivingValues;
      keptOutOfModelValues += keptOutValues(event);
      ambiguousEntityLinks += event.ambiguousEntityLinks;
      if (event.ambiguousEntityLinks > 0) ambiguousRequestKeys.add(key);
      if (event.blocked) blockedRequestKeys.add(key);
    }
    return {
      events: this.events.length,
      affectedRequests: affectedRequestKeys.size,
      redactedValues,
      survivingValues,
      blockedRequests: blockedRequestKeys.size,
      keptOutOfModelValues,
      restoredValues: this.restoredValuesTotal,
      withheldFromToolsValues: this.withheldFromToolsValuesTotal,
      residualSurrogateValues: this.residualSurrogateValuesTotal,
      ambiguousEntityLinks,
      ambiguousEntityLinkRequests: ambiguousRequestKeys.size,
    };
  }

  private groupBy(nameFor: (event: ProtectionStatsEvent) => string): ProtectionStatsBucket[] {
    const buckets = new Map<string, MutableBucket>();
    for (const event of this.events) {
      const name = nameFor(event) || "unknown";
      const bucket = buckets.get(name) ?? newMutableBucket(name);
      buckets.set(name, bucket);
      addEventToBucket(bucket, event);
    }
    return [...buckets.values()].map(freezeBucket).sort(compareBuckets);
  }

  private groupByLabel(): ProtectionStatsLabelBucket[] {
    const buckets = new Map<string, MutableLabelBucket>();
    for (const event of this.events) {
      const request = requestKey(event);
      for (const hit of event.redactedHits) {
        const bucket = labelBucket(buckets, hit);
        bucket.requestKeys.add(request);
        bucket.redactedValues += 1;
        bucket.keptOutOfModelValues += 1;
      }
      for (const hit of event.survivingHits) {
        const bucket = labelBucket(buckets, hit);
        bucket.requestKeys.add(request);
        bucket.survivingValues += 1;
        if (event.blocked) {
          bucket.blockedRequestKeys.add(request);
          bucket.keptOutOfModelValues += 1;
        }
      }
    }
    return [...buckets.values()].map(freezeLabelBucket).sort(compareBuckets);
  }
}

export function renderProtectionStatsSummary(snapshot: ProtectionStatsSnapshot): string {
  const total = snapshot.totals.keptOutOfModelValues;
  const lines = [`🔒 ficta — kept ${total} ${plural(total, "protected value")} out of the model this session`];
  if (snapshot.totals.events === 0) return `${lines.join("\n")}\n`;

  const blocked = snapshot.totals.blockedRequests > 0 ? `, blocked ${snapshot.totals.blockedRequests}` : "";
  lines.push(`   affected requests: ${snapshot.totals.affectedRequests}${blocked}`);
  if (snapshot.totals.ambiguousEntityLinks > 0) {
    lines.push(
      `   ambiguous entity links: ${snapshot.totals.ambiguousEntityLinks} across ${snapshot.totals.ambiguousEntityLinkRequests} ${plural(snapshot.totals.ambiguousEntityLinkRequests, "request")}`,
    );
  }
  const residuals = snapshot.totals.residualSurrogateValues ?? 0;
  if (residuals > 0) {
    lines.push(`   unrestored surrogate tokens: ${residuals} (model-mutated or invented; see restore-mutation notes)`);
  }

  const modelLine = formatTopBuckets(
    snapshot.byModel.filter((bucket) => bucket.name !== "unknown"),
    3,
  );
  if (modelLine) lines.push(`   by model: ${modelLine}`);

  const surfaceLine = formatTopBuckets(snapshot.bySurface, 3);
  if (surfaceLine) lines.push(`   by surface: ${surfaceLine}`);

  const labelLine = formatTopBuckets(snapshot.byLabel, 3);
  if (labelLine) lines.push(`   top labels: ${labelLine}`);

  lines.push(`   stats: ${snapshot.path}`);
  return `${lines.join("\n")}\n`;
}

function newMutableBucket(name: string): MutableBucket {
  return {
    name,
    requestKeys: new Set<string>(),
    redactedValues: 0,
    survivingValues: 0,
    blockedRequestKeys: new Set<string>(),
    keptOutOfModelValues: 0,
  };
}

function addEventToBucket(bucket: MutableBucket, event: ProtectionStatsEvent): void {
  const request = requestKey(event);
  bucket.requestKeys.add(request);
  bucket.redactedValues += event.redactedValues;
  bucket.survivingValues += event.survivingValues;
  bucket.keptOutOfModelValues += keptOutValues(event);
  if (event.blocked) bucket.blockedRequestKeys.add(request);
}

function freezeBucket(bucket: MutableBucket): ProtectionStatsBucket {
  return {
    name: bucket.name,
    requests: bucket.requestKeys.size,
    redactedValues: bucket.redactedValues,
    survivingValues: bucket.survivingValues,
    blockedRequests: bucket.blockedRequestKeys.size,
    keptOutOfModelValues: bucket.keptOutOfModelValues,
  };
}

function labelBucket(buckets: Map<string, MutableLabelBucket>, hit: ProtectionHit): MutableLabelBucket {
  const source = hit.source || "unknown";
  const name = hit.name || "<unknown>";
  const key = JSON.stringify([name, source, hit.plugin ?? "", hit.kind ?? "", hit.confidence ?? ""]);
  const existing = buckets.get(key);
  if (existing) return existing;
  const bucket: MutableLabelBucket = { ...newMutableBucket(name), source };
  if (hit.plugin) bucket.plugin = hit.plugin;
  if (hit.kind) bucket.kind = hit.kind;
  if (hit.confidence) bucket.confidence = hit.confidence;
  buckets.set(key, bucket);
  return bucket;
}

function freezeLabelBucket(bucket: MutableLabelBucket): ProtectionStatsLabelBucket {
  const frozen = freezeBucket(bucket);
  const out: ProtectionStatsLabelBucket = { ...frozen, source: bucket.source };
  if (bucket.plugin) out.plugin = bucket.plugin;
  if (bucket.kind) out.kind = bucket.kind;
  if (bucket.confidence) out.confidence = bucket.confidence;
  return out;
}

function compareBuckets(a: ProtectionStatsBucket, b: ProtectionStatsBucket): number {
  return (
    b.keptOutOfModelValues - a.keptOutOfModelValues ||
    b.redactedValues - a.redactedValues ||
    a.name.localeCompare(b.name)
  );
}

function keptOutValues(event: ProtectionStatsEvent): number {
  return event.redactedValues + (event.blocked ? event.survivingValues : 0);
}

function requestKey(event: ProtectionStatsEvent): string {
  return event.requestId === undefined ? `event:${event.index}` : `request:${event.requestId}`;
}

function normalizeModel(model: string | undefined): string {
  const value = model?.trim();
  if (!value) return "unknown";
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

function formatTopBuckets(buckets: readonly ProtectionStatsBucket[], max: number): string {
  return buckets
    .slice(0, max)
    .map((bucket) => `${bucket.name} ${bucket.keptOutOfModelValues}`)
    .join(", ");
}
