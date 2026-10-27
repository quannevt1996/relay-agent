import { ConnectorError, request, type HttpOptions } from "../../lib/http.js";

export interface SlackChannel {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  isPrivate: boolean;
}

export interface SlackMessage {
  ts: string;
  postedAt: string;
  userId: string;
  userName: string;
  text: string;
  replyCount: number;
}

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  title: string;
}

export interface SlackApi {
  listChannels(limit: number): Promise<SlackChannel[]>;
  /** Newest first, like the Slack API. */
  channelHistory(channelId: string, options: { oldest?: Date; limit: number }): Promise<SlackMessage[]>;
  postMessage(channelId: string, text: string, threadTs?: string): Promise<{ channelId: string; ts: string }>;
  getUser(userId: string): Promise<SlackUser>;
}

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

export function slackError(method: string, error: string, needed?: string): ConnectorError {
  if (AUTH_ERRORS.has(error)) {
    return new ConnectorError("auth", `Slack rejected the token (${error})`, "Reconnect Slack on the Connections page.");
  }
  switch (error) {
    case "missing_scope":
      return new ConnectorError(
        "permission",
        `Slack app is missing a scope for ${method}${needed ? ` (needs ${needed})` : ""}`,
        "Add the scope to the Slack app and reconnect.",
      );
    case "not_in_channel":
      return new ConnectorError(
        "permission",
        "The Relay bot is not a member of that channel",
        "Invite the bot to the channel with /invite, or pick another channel.",
      );
    case "channel_not_found":
      return new ConnectorError("not_found", "Channel not found", "Use slack_list_channels to find a valid channel id.");
    case "user_not_found":
      return new ConnectorError("not_found", "User not found");
    case "ratelimited":
      return new ConnectorError("rate_limited", `Slack rate limit hit on ${method}`, "Wait a minute and try again.");
    default:
      return new ConnectorError("upstream", `Slack ${method} failed: ${error}`);
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  [key: string]: unknown;
}

const toIso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/** Thin client over the Slack Web API (https://api.slack.com/web). */
export class SlackWebApi implements SlackApi {
  private readonly userCache = new Map<string, SlackUser>();

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly http: HttpOptions = {},
    private readonly baseUrl = "https://slack.com/api",
  ) {}

  async listChannels(limit: number): Promise<SlackChannel[]> {
    const res = await this.call("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(Math.min(limit, 200)),
    });
    const channels = res.channels as Array<{
      id: string;
      name: string;
      is_private: boolean;
      num_members?: number;
      topic?: { value: string };
    }>;
    return channels.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic?.value ?? "",
      memberCount: c.num_members ?? 0,
      isPrivate: c.is_private,
    }));
  }

  async channelHistory(channelId: string, { oldest, limit }: { oldest?: Date; limit: number }): Promise<SlackMessage[]> {
    const params: Record<string, string> = { channel: channelId, limit: String(Math.min(limit, 200)) };
    if (oldest) params.oldest = String(oldest.getTime() / 1000);
    const res = await this.call("conversations.history", params);
    const messages = (res.messages as Array<{ ts: string; user?: string; bot_id?: string; text: string; reply_count?: number }>)
      .filter((m) => m.user);
    return Promise.all(
      messages.map(async (m) => ({
        ts: m.ts,
        postedAt: toIso(m.ts),
        userId: m.user!,
        userName: (await this.getUser(m.user!).catch(() => undefined))?.realName ?? m.user!,
        text: m.text,
        replyCount: m.reply_count ?? 0,
      })),
    );
  }

  async postMessage(channelId: string, text: string, threadTs?: string): Promise<{ channelId: string; ts: string }> {
    const res = await this.call("chat.postMessage", { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, "POST");
    return { channelId: res.channel as string, ts: res.ts as string };
  }

  async getUser(userId: string): Promise<SlackUser> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    const res = await this.call("users.info", { user: userId });
    const u = res.user as { id: string; name: string; real_name?: string; profile?: { title?: string; real_name?: string } };
    const user = { id: u.id, name: u.name, realName: u.real_name ?? u.profile?.real_name ?? u.name, title: u.profile?.title ?? "" };
    this.userCache.set(userId, user);
    return user;
  }

  private async call(method: string, params: Record<string, string>, httpMethod: "GET" | "POST" = "GET"): Promise<SlackResponse> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${method}`);
    const init: RequestInit = { method: httpMethod, headers: { Authorization: `Bearer ${token}` } };
    if (httpMethod === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    } else {
      init.headers = { ...init.headers, "Content-Type": "application/json; charset=utf-8" };
      init.body = JSON.stringify(params);
    }

    const res = await request(url.toString(), init, this.http);
    if (res.status === 429) throw slackError(method, "ratelimited");
    if (!res.ok) throw new ConnectorError("upstream", `Slack ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as SlackResponse;
    if (!body.ok) throw slackError(method, body.error ?? "unknown_error", body.needed);
    return body;
  }
}
