import { ConnectorError, request, type HttpOptions } from "../../lib/http.js";
import { blocksToMarkdown, markdownToBlocks, type NotionBlock } from "./markdown.js";

export interface NotionPageSummary {
  id: string;
  title: string;
  /** Null for demo pages, which have no real URL. */
  url: string | null;
  lastEditedAt: string;
}

export interface NotionPage extends NotionPageSummary {
  markdown: string;
  truncated: boolean;
}

export interface NotionApi {
  search(query: string, limit: number): Promise<NotionPageSummary[]>;
  readPage(pageId: string): Promise<NotionPage>;
  createPage(parentPageId: string, title: string, markdown: string): Promise<NotionPageSummary>;
  appendToPage(pageId: string, markdown: string): Promise<{ pageId: string; appendedBlocks: number }>;
}

export const NOTION_VERSION = "2022-06-28";
const SHARE_HINT = "Share the page with the Relay integration in Notion (••• menu → Connections), then retry.";
const MAX_BLOCKS_PER_REQUEST = 100;
const MAX_BLOCK_PAGES = 5;

interface NotionErrorBody {
  object?: string;
  code?: string;
  message?: string;
}

export function notionError(status: number, body: NotionErrorBody): ConnectorError {
  const message = `Notion: ${body.message ?? `HTTP ${status}`}`;
  switch (body.code) {
    case "unauthorized":
      return new ConnectorError("auth", message, "Reconnect Notion on the Connections page.");
    case "restricted_resource":
      return new ConnectorError("permission", message, SHARE_HINT);
    case "object_not_found":
      return new ConnectorError("not_found", message, SHARE_HINT);
    case "rate_limited":
      return new ConnectorError("rate_limited", message, "Wait a few seconds and try again.");
    case "validation_error":
      return new ConnectorError("invalid_request", message);
    default:
      return new ConnectorError("upstream", message);
  }
}

interface RawPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
}

function summarize(page: RawPage): NotionPageSummary {
  const titleProp = Object.values(page.properties).find((p) => p.type === "title");
  const title = titleProp?.title?.map((t) => t.plain_text).join("") || "Untitled";
  return { id: page.id, title, url: page.url, lastEditedAt: page.last_edited_time };
}

/** Client for the Notion REST API (https://developers.notion.com/reference). */
export class NotionRestApi implements NotionApi {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly http: HttpOptions = {},
    private readonly baseUrl = "https://api.notion.com/v1",
  ) {}

  async search(query: string, limit: number): Promise<NotionPageSummary[]> {
    const res = await this.call<{ results: RawPage[] }>("POST", "/search", {
      query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: Math.min(limit, 100),
    });
    return res.results.map(summarize);
  }

  async readPage(pageId: string): Promise<NotionPage> {
    const page = summarize(await this.call<RawPage>("GET", `/pages/${pageId}`));
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const res = await this.call<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(
        "GET",
        `/blocks/${pageId}/children?${qs}`,
      );
      blocks.push(...res.results);
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor && ++pages < MAX_BLOCK_PAGES);
    return { ...page, markdown: blocksToMarkdown(blocks), truncated: Boolean(cursor) };
  }

  async createPage(parentPageId: string, title: string, markdown: string): Promise<NotionPageSummary> {
    const blocks = markdownToBlocks(markdown);
    const page = await this.call<RawPage>("POST", "/pages", {
      parent: { page_id: parentPageId },
      properties: { title: { title: [{ type: "text", text: { content: title } }] } },
      children: blocks.slice(0, MAX_BLOCKS_PER_REQUEST),
    });
    await this.appendBlocks(page.id, blocks.slice(MAX_BLOCKS_PER_REQUEST));
    return summarize(page);
  }

  async appendToPage(pageId: string, markdown: string): Promise<{ pageId: string; appendedBlocks: number }> {
    const blocks = markdownToBlocks(markdown);
    await this.appendBlocks(pageId, blocks);
    return { pageId, appendedBlocks: blocks.length };
  }

  private async appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      await this.call("PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) });
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const res = await request(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.http,
    );
    const json = (await res.json().catch(() => ({}))) as T & NotionErrorBody;
    if (!res.ok) throw notionError(res.status, json);
    return json;
  }
}
