import { describe, expect, it } from "vitest";
import { parseProtectedRegistryImport } from "@/lib/protected-registry-import";

describe("protected registry import parser", () => {
  it("parses headed CSV rows with aliases", () => {
    const result = parseProtectedRegistryImport(
      [
        "scope_id,type,value,aliases,status",
        'NSB-2026-0147,client,Northstar Biologics (Pty) Ltd,"Northstar; NBL",approved',
        "NSB-2026-0147,counterparty,Proxima Medical Supplies CC,Proxima,suggested",
      ].join("\n"),
    );

    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([
      {
        matterId: "NSB-2026-0147",
        type: "client",
        value: "Northstar Biologics (Pty) Ltd",
        aliases: ["Northstar", "NBL"],
        status: "approved",
        source: "csv",
      },
      {
        matterId: "NSB-2026-0147",
        type: "counterparty",
        value: "Proxima Medical Supplies CC",
        aliases: ["Proxima"],
        status: "suggested",
        source: "csv",
      },
    ]);
  });

  it("skips rows with unsupported types or blank values", () => {
    const result = parseProtectedRegistryImport(
      ["matter_id,type,value", "M-1,client,", "M-2,unsupported,Acme"].join("\n"),
    );

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([
      "Row 2 was skipped because value is blank.",
      'Row 3 was skipped because type "unsupported" is not supported.',
    ]);
  });
});
