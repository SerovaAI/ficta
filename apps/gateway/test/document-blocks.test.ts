import { describe, expect, it } from "vitest";
import {
  documentDownloadSource,
  lastDocumentBlock,
  lastHeading,
  parseFictaBlocks,
} from "@/lib/documents/document-blocks";

const CONTRACT = "# Consulting Agreement\n\n## 1. Services\n\n1. Clause one.";

function fenced(content: string, info = 'ficta:document title="Consulting Agreement"'): string {
  return `\`\`\`${info}\n${content}\n\`\`\``;
}

describe("parseFictaBlocks", () => {
  it("parses a closed document fence with attributes and exact offsets", () => {
    const text = `Here is the draft:\n\n${fenced(CONTRACT)}\n\nLet me know.`;
    const [block] = parseFictaBlocks(text);
    if (!block) throw new Error("no block parsed");
    expect(block.type).toBe("document");
    expect(block.attrs.title).toBe("Consulting Agreement");
    expect(block.closed).toBe(true);
    expect(block.content).toBe(CONTRACT);
    expect(text.slice(block.contentStart, block.contentEnd)).toBe(CONTRACT);
    expect(text.slice(0, block.start)).toBe("Here is the draft:\n\n");
    expect(text.slice(block.end)).toBe("\n\nLet me know.");
  });

  it("treats an unterminated fence as an open block (mid-stream)", () => {
    const text = `Drafting now:\n\`\`\`ficta:document title="NDA"\n# NDA\n\n## 1. Confid`;
    const [block] = parseFictaBlocks(text);
    expect(block?.closed).toBe(false);
    expect(block?.content).toBe("# NDA\n\n## 1. Confid");
  });

  it("ignores ficta fences opened inside an ordinary code block", () => {
    const text = "```md\n```ficta:document\nnot a document\n```\n";
    expect(parseFictaBlocks(text)).toEqual([]);
  });

  it("supports tilde fences and longer closing runs", () => {
    const text = `~~~ficta:document\n${CONTRACT}\n~~~~\n`;
    const [block] = parseFictaBlocks(text);
    expect(block?.closed).toBe(true);
    expect(block?.content).toBe(CONTRACT);
  });

  it("does not close a backtick fence with tildes", () => {
    const text = "```ficta:document\nbody\n~~~\nmore";
    const [block] = parseFictaBlocks(text);
    expect(block?.closed).toBe(false);
    expect(block?.content).toBe("body\n~~~\nmore");
  });

  it("parses fence types other than document (forward-compatible with ficta:patch)", () => {
    const [block] = parseFictaBlocks("```ficta:patch\nSEARCH/REPLACE\n```");
    expect(block?.type).toBe("patch");
  });
});

describe("lastDocumentBlock", () => {
  it("picks the last document fence when the model emitted several", () => {
    const text = `${fenced("# Old draft", 'ficta:document title="Old"')}\n\n${fenced(CONTRACT, 'ficta:document title="New"')}`;
    expect(lastDocumentBlock(text)?.attrs.title).toBe("New");
  });

  it("skips non-document ficta fences", () => {
    const text = `${fenced(CONTRACT)}\n\n\`\`\`ficta:patch\np\n\`\`\``;
    expect(lastDocumentBlock(text)?.type).toBe("document");
  });
});

describe("documentDownloadSource", () => {
  it("uses the last closed fence, with its title", () => {
    const source = documentDownloadSource(`Intro.\n\n${fenced(CONTRACT)}\n\nOutro.`);
    expect(source).toEqual({ markdown: CONTRACT, title: "Consulting Agreement", fromFence: true });
  });

  it("falls back to the whole message when there is no fence", () => {
    const source = documentDownloadSource(CONTRACT);
    expect(source).toEqual({ markdown: CONTRACT, fromFence: false });
  });

  it("falls back to the whole message while the only fence is still open", () => {
    const text = '```ficta:document title="NDA"\n# NDA';
    expect(documentDownloadSource(text)).toEqual({ markdown: text, fromFence: false });
  });

  it("uses the last closed fence when a later fence was left unterminated (truncated generation)", () => {
    const text = `${fenced(CONTRACT)}\n\n\`\`\`ficta:document title="Cut off"\n# Partial`;
    expect(documentDownloadSource(text)).toEqual({
      markdown: CONTRACT,
      title: "Consulting Agreement",
      fromFence: true,
    });
  });

  it("returns nothing for blank text", () => {
    expect(documentDownloadSource("   \n")).toBeUndefined();
  });
});

describe("lastHeading", () => {
  it("returns the deepest-progress heading for the streaming card", () => {
    expect(lastHeading("# Agreement\n\ntext\n\n## 7. Limitation of Liability\n\n1. clause")).toBe(
      "7. Limitation of Liability",
    );
  });

  it("returns undefined when no heading has streamed yet", () => {
    expect(lastHeading("preamble text only")).toBeUndefined();
  });
});
