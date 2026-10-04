import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DestroyCategoriesControl, toggleDestroyCategory } from "@/components/settings/ProxyConfigSection";
import { DESTROY_CATEGORY_OPTIONS, isProxyConfigOk, isProxyConfigUpdateOk } from "@/lib/proxy-config";

function validPayload() {
  return {
    ok: true,
    service: "ficta",
    config: {
      protection: {
        failClosed: true,
        requireRegistry: false,
        globallyDisabled: false,
        redactPaths: false,
        restoreIntoTools: "detected",
        surrogateStyle: "opaque",
      },
      detection: {
        pii: {
          standalone: true,
          agents: false,
          configuredBackend: "regex",
          configuredBackends: ["regex"],
          failureMode: "fail-open",
        },
        secretShapes: { standalone: false, agents: false },
      },
      transport: {
        host: "127.0.0.1",
        port: 8787,
        upstreams: {
          anthropic: "https://api.anthropic.com",
          openai: "https://api.openai.com",
          chatgpt: "https://chatgpt.com",
        },
        allowCustomUpstream: false,
        logLevel: "info",
        logBodies: false,
        traceAudit: false,
        traceCapture: { enabled: false },
        logDir: "/home/user/.ficta/logs",
      },
    },
    edit: {
      path: "/home/user/.ficta/config.toml",
      disabled: false,
      restartRequired: false,
      values: {
        failClosed: true,
        piiEnabled: true,
        piiBackends: ["regex", "openmed"],
        piiFailClosed: false,
        piiPresidioUrl: "http://127.0.0.1:5002",
        piiOpenmedUrl: "http://127.0.0.1:5004",
        secretShapesEnabled: false,
        surrogateStyle: "opaque",
        restoreIntoTools: "detected",
        allowCustomUpstream: false,
        destroyCategories: [],
      },
      locked: {},
    },
  };
}

// The guard is the wire contract with the proxy: any shape drift must fail closed to `bad_response`
// rather than render garbage, so it rejects on every missing/mistyped field.
describe("isProxyConfigOk", () => {
  it("accepts a well-formed payload", () => {
    expect(isProxyConfigOk(validPayload())).toBe(true);
  });

  it("accepts an optional forcedUpstream string", () => {
    const payload = validPayload();
    payload.config.transport = { ...payload.config.transport, forcedUpstream: "http://127.0.0.1:9999" } as never;
    expect(isProxyConfigOk(payload)).toBe(true);
  });

  it("rejects non-objects and wrong service markers", () => {
    expect(isProxyConfigOk(undefined)).toBe(false);
    expect(isProxyConfigOk(null)).toBe(false);
    expect(isProxyConfigOk("ficta")).toBe(false);
    expect(isProxyConfigOk({ ...validPayload(), ok: false })).toBe(false);
    expect(isProxyConfigOk({ ...validPayload(), service: "other" })).toBe(false);
  });

  it("rejects a payload with a missing section", () => {
    const payload = validPayload();
    delete (payload.config as Record<string, unknown>).detection;
    expect(isProxyConfigOk(payload)).toBe(false);
  });

  it("rejects a payload with missing edit metadata", () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).edit;
    expect(isProxyConfigOk(payload)).toBe(false);
  });

  it("rejects mistyped fields", () => {
    const badFailClosed = validPayload();
    (badFailClosed.config.protection as Record<string, unknown>).failClosed = "yes";
    expect(isProxyConfigOk(badFailClosed)).toBe(false);

    const badStyle = validPayload();
    (badStyle.config.protection as Record<string, unknown>).surrogateStyle = "hex";
    expect(isProxyConfigOk(badStyle)).toBe(false);

    const badPort = validPayload();
    (badPort.config.transport as Record<string, unknown>).port = "8787";
    expect(isProxyConfigOk(badPort)).toBe(false);

    const badTraceAudit = validPayload();
    (badTraceAudit.config.transport as Record<string, unknown>).traceAudit = "false";
    expect(isProxyConfigOk(badTraceAudit)).toBe(false);

    const badFailureMode = validPayload();
    (badFailureMode.config.detection.pii as Record<string, unknown>).failureMode = "open";
    expect(isProxyConfigOk(badFailureMode)).toBe(false);

    const badEditBackend = validPayload();
    (badEditBackend.edit.values as Record<string, unknown>).piiBackends = ["other"];
    expect(isProxyConfigOk(badEditBackend)).toBe(false);
  });

  it("accepts proxy config update responses with edit metadata", () => {
    expect(isProxyConfigUpdateOk({ ok: true, service: "ficta", edit: validPayload().edit })).toBe(true);
    expect(isProxyConfigUpdateOk({ ok: true, service: "ficta", edit: { disabled: false } })).toBe(false);
  });
});

const disabledCheckboxes = (html: string) => html.match(/<button[^>]*role="checkbox"[^>]*\sdisabled=""/g)?.length ?? 0;

describe("Remove permanently control", () => {
  const render = (props: Partial<Parameters<typeof DestroyCategoriesControl>[0]> = {}) =>
    renderToStaticMarkup(createElement(DestroyCategoriesControl, { selected: [], onChange: () => {}, ...props }));

  it("offers only detector category names and warns that removal is irreversible", () => {
    expect(DESTROY_CATEGORY_OPTIONS.map((option) => option.category)).toEqual([
      "credit-card",
      "iban-code",
      "account-number",
      "us-bank-number",
      "za-id-number",
      "us-ssn",
    ]);
    const html = render();
    expect(html).toContain(
      "Irreversible: removed values never appear in answers, exports or restored text. Registered values are never removed.",
    );
    for (const { category } of DESTROY_CATEGORY_OPTIONS) expect(html).toContain(`id="proxy-destroy-${category}"`);
    expect(html).not.toContain('aria-checked="true"');
  });

  it("shows selected categories and keeps categories configured outside the offered set", () => {
    const html = render({ selected: ["credit-card", "uk-nino"] });
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain("Also removed (set in config.toml)");
    expect(html).toContain("uk-nino");
    expect(toggleDestroyCategory(["uk-nino"], "credit-card", true)).toEqual(["uk-nino", "credit-card"]);
    expect(toggleDestroyCategory(["uk-nino", "credit-card"], "credit-card", false)).toEqual(["uk-nino"]);
  });

  it("renders read-only with the lock reason when the proxy reports the field locked", () => {
    const html = render({
      selected: ["credit-card"],
      disabled: true,
      locked: "FICTA_DESTROY_CATEGORIES is set in the proxy environment.",
    });
    expect(html).toContain("FICTA_DESTROY_CATEGORIES is set in the proxy environment.");
    expect(disabledCheckboxes(html)).toBe(DESTROY_CATEGORY_OPTIONS.length);
  });

  it("renders a destroy-everything policy as all categories, read-only", () => {
    const html = render({ selected: ["*"] });
    expect(html).toContain("All detected categories");
    expect(disabledCheckboxes(html)).toBe(DESTROY_CATEGORY_OPTIONS.length);
  });
});
