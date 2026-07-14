import { describe, expect, it } from "vitest";
import { parseProtectedRegistryImport } from "@/lib/protected-registry-import";

describe("protected registry import parser", () => {
  it("parses entity and literal CSV rows", () => {
    const result = parseProtectedRegistryImport(
      [
        "protection_kind,entity_type,matter_id,type,value,forms,status",
        'entity,organization,NSB-2026-0147,client,Northstar Biologics (Pty) Ltd,"Northstar~short_name~token;NBL~alias~token",approved',
        "literal,,,counterparty,Proxima Medical Supplies CC,,suggested",
      ].join("\n"),
    );

    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([
      {
        matterId: "NSB-2026-0147",
        type: "client",
        protectionKind: "entity",
        entityType: "organization",
        value: "Northstar Biologics (Pty) Ltd",
        forms: [
          { value: "Northstar", kind: "short_name", boundary: "token" },
          { value: "NBL", kind: "alias", boundary: "token" },
        ],
        status: "approved",
        source: "csv",
      },
      {
        matterId: "",
        type: "counterparty",
        protectionKind: "literal",
        value: "Proxima Medical Supplies CC",
        forms: [],
        status: "suggested",
        source: "csv",
      },
    ]);
  });

  it("parses literal value-first rows without a header", () => {
    const result = parseProtectedRegistryImport("Northstar Biologics (Pty) Ltd,approved");

    expect(result.warnings).toEqual([]);
    expect(result.entries).toEqual([
      {
        matterId: "",
        type: "other",
        protectionKind: "literal",
        value: "Northstar Biologics (Pty) Ltd",
        forms: [],
        status: "approved",
        source: "csv",
      },
    ]);
  });

  it("skips rows with unsupported types, invalid forms, or blank values", () => {
    const result = parseProtectedRegistryImport(
      [
        "protection_kind,entity_type,matter_id,type,value,forms",
        "literal,,M-1,client,,",
        "literal,,M-2,unsupported,Acme,",
        "entity,organization,M-3,client,Northstar,Northstar~short_name~word",
      ].join("\n"),
    );

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([
      "Row 2 was skipped because value is blank.",
      'Row 3 was skipped because type "unsupported" is not supported.',
      'Row 4 was skipped because form boundary "word" is not supported.',
    ]);
  });
});
