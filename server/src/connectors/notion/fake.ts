import { randomUUID } from "node:crypto";
import type { NotionWorld, StoredNotionPage } from "../demo/world.js";
import { notionError, type NotionApi, type NotionPage, type NotionPageSummary } from "./api.js";

const notFound = () =>
  notionError(404, { code: "object_not_found", message: "Could not find page. Make sure it is shared with the integration." });

/** NotionApi backed by an in-memory world; pages store Markdown directly. */
export class FakeNotionApi implements NotionApi {
  constructor(private readonly world: NotionWorld) {}

  async search(query: string, limit: number): Promise<NotionPageSummary[]> {
    const q = query.trim().toLowerCase();
    return [...this.world.pages.values()]
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.markdown.toLowerCase().includes(q))
      .sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt))
      .slice(0, limit)
      .map(summary);
  }

  async readPage(pageId: string): Promise<NotionPage> {
    const page = this.page(pageId);
    const children = [...this.world.pages.values()]
      .filter((p) => p.parentId === pageId)
      .map((p) => `- 📄 ${p.title} (page id: ${p.id})`);
    const markdown = [page.markdown, ...children].join("\n");
    return { ...summary(page), markdown, truncated: false };
  }

  async createPage(parentPageId: string, title: string, markdown: string): Promise<NotionPageSummary> {
    this.page(parentPageId);
    const now = new Date().toISOString();
    const page: StoredNotionPage = { id: randomUUID(), title, parentId: parentPageId, markdown, createdAt: now, lastEditedAt: now };
    this.world.pages.set(page.id, page);
    return summary(page);
  }

  async appendToPage(pageId: string, markdown: string): Promise<{ pageId: string; appendedBlocks: number }> {
    const page = this.page(pageId);
    page.markdown = `${page.markdown}\n${markdown}`;
    page.lastEditedAt = new Date().toISOString();
    return { pageId, appendedBlocks: markdown.split("\n").filter((l) => l.trim()).length };
  }

  private page(id: string): StoredNotionPage {
    const page = this.world.pages.get(id);
    if (!page) throw notFound();
    return page;
  }
}

function summary(page: StoredNotionPage): NotionPageSummary {
  return { id: page.id, title: page.title, url: null, lastEditedAt: page.lastEditedAt };
}
