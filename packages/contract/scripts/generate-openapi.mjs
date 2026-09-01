import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAPIGenerator } from "@orpc/openapi";
import { JSON_SCHEMA_INPUT_REGISTRY, ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { format } from "oxfmt";
import { fictaControlContract } from "../dist/contract.js";
import { PROTECTION_PREVIEW_TEXT_MAX_BYTES, protectionPreviewTextSchema } from "../dist/schemas.js";

JSON_SCHEMA_INPUT_REGISTRY.add(protectionPreviewTextSchema, {
  description: `Maximum ${PROTECTION_PREVIEW_TEXT_MAX_BYTES} bytes when encoded as UTF-8.`,
  "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_TEXT_MAX_BYTES,
});

const outputUrl = new URL("../openapi/ficta-control-plane.openapi.json", import.meta.url);
const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
const specification = await generator.generate(fictaControlContract, {
  info: {
    title: "Ficta control plane",
    version: "1.0.0",
    description: "Portable HTTP contract for building a frontend for the Ficta protection engine.",
  },
  servers: [{ url: "http://127.0.0.1:8787", description: "Default local Ficta proxy" }],
  customErrorResponseBodySchema: (_definedErrors, status) => {
    const previewStatus = {
      400: "invalid_request",
      403: "forbidden",
      422: "invariant",
      503: "detector_unavailable",
    }[status];
    if (!previewStatus) return undefined;
    return {
      type: "object",
      properties: {
        ok: { const: false },
        service: { const: "ficta" },
        status: { const: previewStatus },
        message: { type: "string" },
      },
      required: ["ok", "service", "status", "message"],
      additionalProperties: false,
    };
  },
});
const formatted = await format(fileURLToPath(outputUrl), JSON.stringify(specification), {
  printWidth: 120,
  tabWidth: 2,
});
if (formatted.errors.length > 0) throw new Error("Could not format the generated OpenAPI document.");
const generated = formatted.code;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = await readFile(outputUrl, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== generated) {
    console.error(`${fileURLToPath(outputUrl)} is stale; run pnpm --filter @serovaai/ficta-contract build.`);
    process.exitCode = 1;
  }
} else {
  await writeFile(outputUrl, generated);
}
