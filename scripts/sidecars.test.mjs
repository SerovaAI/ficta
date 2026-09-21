import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, remoteDigest, runSidecars, runCli, releaseTag, sourceFingerprint } from "./sidecars.mjs";

const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const pin = `ghcr.io/example/presidio:1.0.0@${oldDigest}`;

function fixture({ failAt, current = oldDigest, override = false, labels = {}, openmedCached = false } = {}) {
  const calls = [];
  const writes = [];
  const logs = [];
  return {
    calls,
    writes,
    logs,
    dependencies: {
      fingerprint: (context) => `fingerprint:${context}`,
      release: async (repo) => (repo.includes("presidio") ? "2.2.364" : "v2.5.0"),
      read: (path) => {
        if (path.includes("presidio"))
          return `ARG PRESIDIO_ANALYZER_IMAGE=${pin}\nFROM \u0024{PRESIDIO_ANALYZER_IMAGE}\n`;
        if (path.endsWith("docker-compose.sidecars.yml"))
          return `image: \u0024{OPENMED_IMAGE:-ghcr.io/maziyarpanahi/openmed:v2.4.0@${oldDigest}}`;
        if (path.endsWith("Dockerfile")) return "FROM python:3.12-slim\n";
        return `ghcr.io/maziyarpanahi/openmed:v2.4.0@${oldDigest}`;
      },
      write: (...args) => writes.push(args),
      log: (message) => logs.push(message),
      run: (args) => {
        calls.push(args);
        if (failAt && args.includes(failAt)) throw new Error(`simulated ${failAt} failure`);
        if (args.includes("imagetools")) return `Name: test\nDigest: ${newDigest}\n`;
        if (args[0] === "image") {
          if (args.includes("{{json .Config.Labels}}")) return JSON.stringify(labels[args[2]] ?? {});
          if (args.includes("{{.Id}}")) return openmedCached ? "sha256:cached" : undefined;
          return JSON.stringify([`example@${current}`]);
        }
        if (args.includes("config"))
          return JSON.stringify({
            services: {
              "presidio-analyzer": { image: "ficta-presidio:dev", build: { context: "/presidio" } },
              "document-converter": { image: "ficta-doc-converter:dev", build: { context: "/converter" } },
              openmed: {
                image: override ? "example/openmed:pinned" : `ghcr.io/maziyarpanahi/openmed:v2.4.0@${oldDigest}`,
              },
            },
          });
        return "";
      },
    },
  };
}

test("arguments reject typos before any side effects", () => {
  assert.deepEqual(parseArgs(["update", "--", "--openmed"]), {
    action: "update",
    openmed: true,
    advisory: false,
    force: false,
  });
  assert.throws(() => parseArgs(["update", "--opemed"]), /Usage/);
  assert.throws(() => parseArgs([]), /Usage/);
});

test("digest parsing ignores child manifests and rejects malformed responses", () => {
  assert.equal(remoteDigest(`Digest: ${newDigest}\n  Name: child@${oldDigest}\n`), newDigest);
  assert.throws(() => remoteDigest("Digest: latest"), /digest/);
});

test("check reports updates without writing files, pulling, or restarting", async () => {
  const f = fixture({ current: newDigest });
  await runSidecars({ action: "check", openmed: false }, f.dependencies);
  assert.equal(f.writes.length, 0);
  assert.ok(f.calls.every((args) => ["buildx", "image"].includes(args[0])));
  assert.ok(f.logs.some((line) => line.startsWith("Presidio base: update available")));
  assert.ok(f.logs.some((line) => line.startsWith("Document converter base: up to date")));
});

test("update builds the resolved pin before recording it and recreates only default services", async () => {
  const f = fixture();
  await runSidecars({ action: "update", openmed: false }, f.dependencies);
  const build = f.calls.find((args) => args.includes("build"));
  assert.ok(build.includes(`PRESIDIO_ANALYZER_IMAGE=ghcr.io/example/presidio:2.2.364@${newDigest}`));
  assert.ok(build.includes("--pull") && !build.includes("--no-cache"));
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0][1].includes(`ARG PRESIDIO_ANALYZER_IMAGE=ghcr.io/example/presidio:2.2.364@${newDigest}`));
  const up = f.calls.at(-1);
  assert.ok(!up.includes("--force-recreate") && up.includes("--wait") && up.includes("--no-build"));
  assert.ok(!f.calls.some((args) => args.includes("openmed")));
});

test("OpenMed uses Compose's resolved override and is pulled only when opted in", async () => {
  const f = fixture({ override: true });
  await runSidecars({ action: "update", openmed: true }, f.dependencies);
  assert.ok(f.calls.some((args) => args.includes("imagetools") && args.includes("example/openmed:pinned")));
  assert.ok(f.calls.some((args) => args[0] === "pull" && args.at(-1) === `example/openmed:pinned@${newDigest}`));
  assert.equal(f.calls.at(-1).at(-1), "openmed");
});

for (const failAt of ["imagetools", "build", "pull"]) {
  test(`${failAt} failures preserve the source pin and do not recreate containers`, async () => {
    const f = fixture({ failAt });
    await assert.rejects(runSidecars({ action: "update", openmed: true }, f.dependencies), /simulated/);
    assert.equal(f.writes.length, 0);
    assert.ok(!f.calls.some((args) => args.includes("up")));
  });
}

test("advisory check reports updates without failing or mutating", async () => {
  const f = fixture();
  const warnings = [];
  await runCli(["check", "--advisory"], f.dependencies, (message) => warnings.push(message));
  assert.ok(f.logs.some((line) => line.startsWith("Presidio base: update available")));
  assert.equal(warnings.length, 0);
  assert.equal(f.writes.length, 0);
  assert.ok(f.calls.every((args) => ["buildx", "image"].includes(args[0])));
});

for (const failAt of ["imagetools", "image"]) {
  test(`advisory check warns and succeeds on ${failAt} failure; strict check still fails`, async () => {
    const f = fixture({ failAt });
    const warnings = [];
    await runCli(["check", "--advisory"], f.dependencies, (message) => warnings.push(message));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /version check incomplete.*Continuing checks/);
    assert.equal(f.writes.length, 0);
    await assert.rejects(runCli(["check"], f.dependencies), /simulated/);
  });
}

test("advisory flag cannot suppress update failures or argument errors", async () => {
  const f = fixture();
  await assert.rejects(runCli(["update", "--advisory"], f.dependencies), /Usage/);
  await assert.rejects(runCli(["check", "--advisory", "--typo"], f.dependencies), /Usage/);
  assert.equal(f.calls.length, 0);
});

test("only stable version release tags are accepted", () => {
  assert.equal(releaseTag({ tag_name: "v2.5.0" }), "v2.5.0");
  for (const tag_name of ["latest", "main", "2.5.0-rc1", "v2.5"]) {
    assert.throws(() => releaseTag({ tag_name }), /stable/);
  }
  assert.throws(() => releaseTag({ tag_name: "2.5.0", prerelease: true }), /stable/);
  assert.throws(() => releaseTag({ tag_name: "2.5.0", draft: true }), /stable/);
});

test("default OpenMed upgrade records the tagged digest for Compose and dev", async () => {
  const f = fixture();
  await runSidecars({ action: "update", openmed: true }, f.dependencies);
  const next = `ghcr.io/maziyarpanahi/openmed:v2.5.0@${newDigest}`;
  assert.ok(f.calls.some((args) => args[0] === "pull" && args[1] === next));
  assert.equal(f.writes.length, 4);
  assert.ok(f.writes.filter(([path]) => !path.includes("presidio")).every(([, source]) => source.includes(next)));
  assert.ok(f.calls.every((args) => !args.some((arg) => arg.includes(":latest"))));
});

test("release discovery failure warns in advisory mode with no latest fallback", async () => {
  const f = fixture();
  f.dependencies.release = async () => {
    throw new Error("GitHub unavailable");
  };
  const warnings = [];
  await runCli(["check", "--advisory"], f.dependencies, (message) => warnings.push(message));
  assert.match(warnings[0], /GitHub unavailable/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

const matchingLabels = {
  "ficta-presidio:dev": { "ai.serova.ficta.sidecar-inputs": "fingerprint:/presidio" },
  "ficta-doc-converter:dev": { "ai.serova.ficta.sidecar-inputs": "fingerprint:/converter" },
};

test("unchanged images skip builds and pulls and reuse containers", async () => {
  const f = fixture({ labels: matchingLabels, openmedCached: true });
  await runSidecars({ action: "update", openmed: true }, f.dependencies);
  assert.ok(!f.calls.some((args) => args.includes("build") || args[0] === "pull"));
  assert.ok(!f.calls.at(-1).includes("--force-recreate"));
  assert.ok(f.calls.at(-1).includes("--wait"));
});

test("only a sidecar whose inputs changed is built", async () => {
  const f = fixture({ labels: matchingLabels });
  f.dependencies.fingerprint = (context) => (context === "/presidio" ? "changed" : `fingerprint:${context}`);
  await runSidecars({ action: "update" }, f.dependencies);
  const builds = f.calls.filter((args) => args.includes("build"));
  assert.equal(builds.length, 1);
  assert.equal(builds[0].at(-1), "presidio-analyzer");
  assert.ok(!builds[0].includes("--no-cache"));
});

test("force rebuilds both images uncached, pulls OpenMed, and recreates containers", async () => {
  const f = fixture({ labels: matchingLabels, openmedCached: true });
  await runSidecars(parseArgs(["update", "--openmed", "--force"]), f.dependencies);
  const builds = f.calls.filter((args) => args.includes("build"));
  assert.equal(builds.length, 2);
  assert.ok(builds.every((args) => args.includes("--no-cache")));
  assert.ok(f.calls.some((args) => args[0] === "pull"));
  assert.ok(f.calls.at(-1).includes("--force-recreate"));
  assert.throws(() => parseArgs(["check", "--force"]), /Usage/);
});

test("fingerprints detect source, configuration, and base changes and remain stable after pin writeback", () => {
  const context = mkdtempSync(join(tmpdir(), "ficta-sidecar-inputs-"));
  try {
    const dockerfile = join(context, "Dockerfile");
    writeFileSync(dockerfile, `ARG BASE=${oldDigest}\n`);
    writeFileSync(join(context, "app.py"), "original");
    writeFileSync(join(context, "recognizers.yaml"), "original config");
    const build = { args: { OPTIONAL_FEATURE: "0" } };
    const hash = () => sourceFingerprint(context, newDigest, build, [[oldDigest, newDigest]]);
    const initial = hash();
    writeFileSync(dockerfile, `ARG BASE=${newDigest}\n`);
    assert.equal(hash(), initial);
    mkdirSync(join(context, "__pycache__"));
    writeFileSync(join(context, "__pycache__", "app.pyc"), "cache");
    assert.equal(hash(), initial);
    assert.notEqual(sourceFingerprint(context, oldDigest, build), initial);
    assert.notEqual(sourceFingerprint(context, newDigest, { args: { OPTIONAL_FEATURE: "1" } }), initial);
    writeFileSync(join(context, "recognizers.yaml"), "changed config");
    assert.notEqual(hash(), initial);
    writeFileSync(join(context, "recognizers.yaml"), "original config");
    writeFileSync(join(context, "app.py"), "changed source");
    assert.notEqual(hash(), initial);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
});

test("converter version check uses the built image base rather than an unrelated cached base", async () => {
  const f = fixture({
    current: oldDigest,
    labels: {
      "ficta-doc-converter:dev": { "ai.serova.ficta.sidecar-base-digest": newDigest },
    },
  });
  await runSidecars({ action: "check" }, f.dependencies);
  assert.ok(f.logs.some((line) => line.startsWith("Document converter base: up to date")));
});
