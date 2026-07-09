import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalLogLevel = process.env.FICTA_LOG_LEVEL;
const originalLogDir = process.env.FICTA_LOG_DIR;

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.FICTA_LOG_LEVEL;
  else process.env.FICTA_LOG_LEVEL = originalLogLevel;
  if (originalLogDir === undefined) delete process.env.FICTA_LOG_DIR;
  else process.env.FICTA_LOG_DIR = originalLogDir;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("proxy logger", () => {
  it("reads FICTA_LOG_LEVEL lazily on the first log call, not at import time", async () => {
    delete process.env.FICTA_LOG_LEVEL;
    vi.resetModules();
    const { log } = await import("../src/logger.js");

    process.env.FICTA_LOG_LEVEL = "silent";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    log.info("FICTA_SHOULD_NOT_APPEAR");

    expect(stderr).not.toHaveBeenCalled();
  });

  it("also writes runtime logs to ficta.log when logging is enabled", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "ficta-logger-"));
    process.env.FICTA_LOG_DIR = logDir;
    process.env.FICTA_LOG_LEVEL = "info";
    vi.resetModules();
    const { log } = await import("../src/logger.js");

    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    log.info({ marker: "file-log-test" }, "FICTA_FILE_LOG_TEST");

    const fileLog = readFileSync(join(logDir, "ficta.log"), "utf8");
    expect(fileLog).toContain("FICTA_FILE_LOG_TEST");
    expect(fileLog).toContain("file-log-test");
  });
});
