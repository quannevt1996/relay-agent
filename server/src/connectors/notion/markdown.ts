/**
 * Conversion between a pragmatic subset of Markdown and Notion blocks.
 * Inline formatting is kept as literal text; the model reads and writes
 * Markdown, and Notion renders the block structure.
 */

interface RichText {
  plain_text?: string;
  text?: { content: string };
}

export interface NotionBlock {
  id?: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

const MAX_TEXT = 2000; // Notion's per-rich-text-object limit

function richText(text: string): { type: "text"; text: { content: string } }[] {
  const chunks: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + MAX_TEXT) } });
  }
  return chunks.length ? chunks : [{ type: "text", text: { content: "" } }];
}

const block = (type: string, body: Record<string, unknown>): NotionBlock => ({ object: "block", type, [type]: body });

export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push(block("paragraph", { rich_text: richText(paragraph.join("\n")) }));
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;

    if ((m = line.match(/^```\s*([\w+-]*)\s*$/))) {
      flush();
      const code: string[] = [];
      while (i + 1 < lines.length && !/^```\s*$/.test(lines[i + 1]!)) code.push(lines[++i]!);
      i++; // closing fence
      blocks.push(block("code", { rich_text: richText(code.join("\n")), language: m[1] || "plain text" }));
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      blocks.push(block(`heading_${m[1]!.length}`, { rich_text: richText(m[2]!) }));
    } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      flush();
      blocks.push(block("to_do", { rich_text: richText(m[2]!), checked: m[1] !== " " }));
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flush();
      blocks.push(block("bulleted_list_item", { rich_text: richText(m[1]!) }));
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush();
      blocks.push(block("numbered_list_item", { rich_text: richText(m[1]!) }));
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      blocks.push(block("quote", { rich_text: richText(m[1]!) }));
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push(block("divider", {}));
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const plain = (rich: unknown): string =>
  Array.isArray(rich) ? (rich as RichText[]).map((t) => t.plain_text ?? t.text?.content ?? "").join("") : "";

export function blocksToMarkdown(blocks: NotionBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const body = (b[b.type] ?? {}) as Record<string, unknown>;
    const text = plain(body.rich_text);
    switch (b.type) {
      case "paragraph":
        out.push(text);
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
        out.push(`${"#".repeat(Number(b.type.at(-1)))} ${text}`);
        break;
      case "bulleted_list_item":
      case "toggle":
        out.push(`- ${text}`);
        break;
      case "numbered_list_item":
        out.push(`1. ${text}`);
        break;
      case "to_do":
        out.push(`- [${body.checked ? "x" : " "}] ${text}`);
        break;
      case "quote":
        out.push(`> ${text}`);
        break;
      case "callout":
        out.push(`> 💡 ${text}`);
        break;
      case "code":
        out.push("```" + String(body.language ?? ""), text, "```");
        break;
      case "divider":
        out.push("---");
        break;
      case "child_page":
        out.push(`- 📄 ${String(body.title ?? "Untitled")} (page id: ${b.id})`);
        break;
      case "child_database":
        out.push(`- 🗃️ ${String(body.title ?? "Untitled")} (database id: ${b.id})`);
        break;
      case "bookmark":
      case "embed":
      case "link_preview":
        out.push(String(body.url ?? ""));
        break;
      default:
        out.push(`[unsupported block: ${b.type}]`);
    }
  }
  return out.join("\n");
}

/** Accepts a page id (with or without dashes) or a Notion URL. */
export function normalizePageId(ref: string): string | undefined {
  const compact = ref.trim().split(/[?#]/)[0]!.replace(/-/g, "");
  const m = compact.match(/([0-9a-f]{32})$/i);
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
