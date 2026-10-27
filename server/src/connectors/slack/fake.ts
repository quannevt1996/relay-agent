import type { SlackWorld } from "../demo/world.js";
import { slackError, type SlackApi, type SlackChannel, type SlackMessage, type SlackUser } from "./api.js";

/** SlackApi backed by an in-memory world; mirrors the real API's error codes. */
export class FakeSlackApi implements SlackApi {
  constructor(private readonly world: SlackWorld) {}

  async listChannels(limit: number): Promise<SlackChannel[]> {
    return this.world.channels.slice(0, limit);
  }

  async channelHistory(channelId: string, { oldest, limit }: { oldest?: Date; limit: number }): Promise<SlackMessage[]> {
    const stored = this.world.messages.get(channelId);
    if (!stored) throw slackError("conversations.history", "channel_not_found");
    const since = oldest ? oldest.getTime() / 1000 : 0;
    return stored
      .filter((m) => Number(m.ts) >= since)
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .slice(0, limit)
      .map((m) => ({
        ts: m.ts,
        postedAt: new Date(Number(m.ts) * 1000).toISOString(),
        userId: m.userId,
        userName: this.user(m.userId)?.realName ?? m.userId,
        text: m.text,
        replyCount: m.replyCount,
      }));
  }

  async postMessage(channelId: string, text: string, threadTs?: string): Promise<{ channelId: string; ts: string }> {
    const stored = this.world.messages.get(channelId);
    if (!stored) throw slackError("chat.postMessage", "channel_not_found");
    const ts = (Date.now() / 1000).toFixed(6);
    if (threadTs) {
      const parent = stored.find((m) => m.ts === threadTs);
      if (!parent) throw slackError("chat.postMessage", "thread_not_found");
      parent.replyCount += 1;
    } else {
      stored.push({ ts, userId: this.world.botUserId, text, replyCount: 0 });
    }
    return { channelId, ts };
  }

  async getUser(userId: string): Promise<SlackUser> {
    const user = this.user(userId);
    if (!user) throw slackError("users.info", "user_not_found");
    return user;
  }

  private user(id: string): SlackUser | undefined {
    return this.world.users.find((u) => u.id === id);
  }
}
