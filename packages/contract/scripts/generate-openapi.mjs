import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAPIGenerator } from "@orpc/openapi";
import { JSON_SCHEMA_INPUT_REGISTRY, ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
  FICTA_HEALTH_PATH,
  FICTA_PROTECTION_PREVIEW_PATH,
  FICTA_SCOPE_HEADER,
  FICTA_STATUS_PATH,
} from "@serovaai/ficta-protocol";
import { format } from "oxfmt";
import { fictaClientContract } from "../dist/client.js";
import {
  PROTECTION_PREVIEW_TEXT_MAX_BYTES,
  PROTECTION_PREVIEW_VALUES_MAX_BYTES,
  FICTA_SCOPE_MAX_LENGTH,
  protectionPreviewProtectedValuesSchema,
  protectionPreviewTextSchema,
} from "../dist/schemas.js";

JSON_SCHEMA_INPUT_REGISTRY.add(protectionPreviewTextSchema, {
  description: `Maximum ${PROTECTION_PREVIEW_TEXT_MAX_BYTES} bytes when encoded as UTF-8.`,
  "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_TEXT_MAX_BYTES,
});
JSON_SCHEMA_INPUT_REGISTRY.add(protectionPreviewProtectedValuesSchema, {
  description: `Optional protected selections; maximum ${PROTECTION_PREVIEW_VALUES_MAX_BYTES} combined bytes after UTF-8 encoding, trimming, and deduplication.`,
  "x-ficta-max-utf8-bytes": PROTECTION_PREVIEW_VALUES_MAX_BYTES,
});

const outputUrl = new URL("../openapi/ficta-control-plane.openapi.json", import.meta.url);
const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
const specification = await generator.generate(fictaClientContract, {
  info: {
    title: "Ficta control plane",
    version: "1.0.0",
    description: "Portable HTTP contract for building a frontend for the Ficta protection engine.",
  },
  servers: [{ url: "http://127.0.0.1:8787", description: "Default local Ficta proxy" }],
  tags: [
    {
      name: "Ficta control plane",
      description: "Discovery, process health, values-free protection status, and trusted pre-send review.",
    },
  ],
  externalDocs: {
    description: "Frontend integration contract, trust boundary, and reviewed-send lifecycle",
    url: "https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/control-plane.md",
  },
  customErrorResponseBodySchema: (definedErrors) => (definedErrors.length === 1 ? definedErrors[0][3] : undefined),
});
addTrustedScopeParameter(specification);
addHeader(
  "/__ficta/egress-proof",
  "get",
  "x-ficta-scope",
  true,
  { type: "string", minLength: 1, maxLength: FICTA_SCOPE_MAX_LENGTH },
  "Trusted conversation scope used for the provider request.",
);
addHeader(
  "/__ficta/egress-proof",
  "get",
  "x-ficta-egress-event",
  true,
  { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,64}$" },
  "Server-generated request correlation id; use a UUID.",
);
addHeader(
  "/__ficta/registry/reload",
  "post",
  "x-ficta-registry-revision",
  false,
  { type: "string" },
  "Expected managed-file revision. Success acknowledges it only when that exact revision was loaded.",
);
function addHeader(path, method, name, required, schema, description) {
  specification.paths[path][method].parameters = [{ name, in: "header", required, schema, description }];
}
addHeadOperation(
  specification,
  FICTA_HEALTH_PATH,
  "headFictaHealth",
  "Check whether the Ficta proxy process is serving requests without a response body",
);
addHeadOperation(
  specification,
  FICTA_STATUS_PATH,
  "headFictaProtectionStatus",
  "Check whether protection status can be evaluated without a response body",
);
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

function addTrustedScopeParameter(specification) {
  const operation = specification.paths?.[FICTA_PROTECTION_PREVIEW_PATH]?.post;
  if (!operation) throw new Error(`Cannot add trusted scope to missing POST ${FICTA_PROTECTION_PREVIEW_PATH}.`);
  operation.parameters = [
    ...(operation.parameters ?? []),
    {
      name: FICTA_SCOPE_HEADER,
      in: "header",
      required: true,
      description: "Trusted, server-owned tenant/user/conversation isolation key. Never forwarded upstream.",
      schema: { type: "string", minLength: 1, maxLength: FICTA_SCOPE_MAX_LENGTH },
    },
  ];
}

function addHeadOperation(specification, path, operationId, summary) {
  const pathItem = specification.paths?.[path];
  const get = pathItem?.get;
  if (!pathItem || !get) throw new Error(`Cannot add HEAD operation for missing GET ${path}.`);
  pathItem.head = {
    operationId,
    summary,
    tags: get.tags,
    responses: Object.fromEntries(
      Object.entries(get.responses ?? {}).map(([status, response]) => [
        status,
        { description: response.description ?? status },
      ]),
    ),
  };
}
