import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("offline suite isolation", () => {
  it("writes capture logs under a temp root, never the real ~/.ficta/logs", () => {
    const { logRoot } = loadConfig();
    expect(realpathSync(logRoot).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(logRoot.startsWith(join(homedir(), ".ficta"))).toBe(false);
  });
});
