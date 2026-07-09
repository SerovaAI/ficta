import { describe, expect, it } from "vitest";
import { buildPreservationInstruction, withPreservationInstruction } from "../src/engine/preserve-literals.js";
import { Vault } from "../src/engine/vault.js";

const SURR = ["FICTA_62a02923eca8d0f518581ade81bcb579", "FICTA_e0ba46ccd8719363bd0443dea6de3a4d"];

describe("buildPreservationInstruction", () => {
  it("lists every surrogate and forbids truncation/ellipsis", () => {
    const text = buildPreservationInstruction(SURR);
    for (const s of SURR) expect(text).toContain(s);
    expect(text).toMatch(/ellipsis/i);
    expect(text).toMatch(/character-for-character/i);
  });

  it("caps the explicit list but keeps the policy for the rest", () => {
    const many = Array.from({ length: 600 }, (_, i) => `FICTA_${i.toString(16).padStart(32, "0")}`);
    const text = buildPreservationInstruction(many);
    expect(text).toContain(many[0]);
    expect(text).toContain("100 more"); // 600 - 500 cap
    expect(text).not.toContain(many[599]);
  });
});

describe("withPreservationInstruction", () => {
  it("sets `instructions` for openai-responses when absent", () => {
    const out = JSON.parse(withPreservationInstruction(JSON.stringify({ input: "hi" }), "openai-responses", SURR));
    expect(out.instructions).toContain(SURR[0]);
    expect(out.input).toBe("hi");
  });

  it("prepends to existing openai-responses `instructions`", () => {
    const body = JSON.stringify({ instructions: "Be concise.", input: "hi" });
    const out = JSON.parse(withPreservationInstruction(body, "openai-responses", SURR));
    expect(out.instructions.startsWith("The messages below")).toBe(true);
    expect(out.instructions).toContain("Be concise.");
  });

  it("prepends a system message for openai-chat", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const out = JSON.parse(withPreservationInstruction(body, "openai-chat", SURR));
    expect(out.messages[0]).toMatchObject({ role: "system" });
    expect(out.messages[0].content).toContain(SURR[1]);
    expect(out.messages[1]).toMatchObject({ role: "user", content: "hi" });
  });

  it("prepends to an anthropic string `system`", () => {
    const body = JSON.stringify({ system: "You are helpful.", messages: [] });
    const out = JSON.parse(withPreservationInstruction(body, "anthropic", SURR));
    expect(out.system.startsWith("The messages below")).toBe(true);
    expect(out.system).toContain("You are helpful.");
  });

  it("prepends a text block to an anthropic array `system`", () => {
    const body = JSON.stringify({ system: [{ type: "text", text: "base" }], messages: [] });
    const out = JSON.parse(withPreservationInstruction(body, "anthropic", SURR));
    expect(out.system[0].type).toBe("text");
    expect(out.system[0].text).toContain(SURR[0]);
    expect(out.system[1]).toMatchObject({ type: "text", text: "base" });
  });

  it("sets anthropic `system` when absent", () => {
    const out = JSON.parse(withPreservationInstruction(JSON.stringify({ messages: [] }), "anthropic", SURR));
    expect(out.system).toContain(SURR[0]);
  });

  it("is a no-op for unknown wire, empty surrogates, non-JSON, or an unrecognised shape", () => {
    const body = JSON.stringify({ input: "hi" });
    expect(withPreservationInstruction(body, "unknown", SURR)).toBe(body);
    expect(withPreservationInstruction(body, "openai-responses", [])).toBe(body);
    expect(withPreservationInstruction("not json", "openai-responses", SURR)).toBe("not json");
    // openai-chat with no messages array is left untouched rather than guessed at.
    const noMsgs = JSON.stringify({ foo: 1 });
    expect(withPreservationInstruction(noMsgs, "openai-chat", SURR)).toBe(noMsgs);
  });
});

describe("Vault.surrogatesIn (the allow-list source)", () => {
  it("returns distinct mapped surrogates present in text and excludes unminted FICTA_-shaped tokens", () => {
    const vault = new Vault([{ value: "Jane Doe" }, { value: "jane@example.com" }]);
    const s1 = vault.redactText("Jane Doe").text;
    const s2 = vault.redactText("jane@example.com").text;
    const unminted = `FICTA_${"0".repeat(32)}`; // shaped like a surrogate but never minted here

    const found = vault.surrogatesIn(`${s1} met ${s2}. ${s1} again. ${unminted}`);

    expect(found).toContain(s1);
    expect(found).toContain(s2);
    expect(found).not.toContain(unminted);
    expect(found.length).toBe(2); // distinct, unminted token excluded
  });
});
