import type { SlackChannel, SlackUser } from "../slack/api.js";

/**
 * In-memory stand-ins for a Slack and a Notion workspace. Each Relay workspace
 * gets its own world, so demo writes never leak across tenants. Everything
 * here is fictional ("Northwind Labs"), with timestamps relative to creation
 * so "the last 24 hours" always has content.
 */
export interface DemoWorld {
  slack: SlackWorld;
  notion: NotionWorld;
}

export interface SlackWorld {
  botUserId: string;
  channels: SlackChannel[];
  users: SlackUser[];
  messages: Map<string, StoredSlackMessage[]>;
}

export interface StoredSlackMessage {
  ts: string;
  userId: string;
  text: string;
  replyCount: number;
}

export interface NotionWorld {
  pages: Map<string, StoredNotionPage>;
}

export interface StoredNotionPage {
  id: string;
  title: string;
  parentId: string | null;
  markdown: string;
  createdAt: string;
  lastEditedAt: string;
}

const HOUR = 3_600_000;

const USERS: SlackUser[] = [
  { id: "U01MAYACHN", name: "maya", realName: "Maya Chen", title: "Engineering Manager" },
  { id: "U02DIEGOAL", name: "diego", realName: "Diego Alvarez", title: "Backend Engineer" },
  { id: "U03PRIYANT", name: "priya", realName: "Priya Natarajan", title: "Frontend Engineer" },
  { id: "U04SAMOKAF", name: "sam", realName: "Sam Okafor", title: "Site Reliability Engineer" },
  { id: "U05LENAPRK", name: "lena", realName: "Lena Park", title: "Product Manager" },
  { id: "U0RELAYBOT", name: "relay", realName: "Relay", title: "Bot" },
];

const CHANNELS: SlackChannel[] = [
  { id: "C01GENERAL", name: "general", topic: "Company-wide announcements", memberCount: 42, isPrivate: false },
  { id: "C02STANDUP", name: "eng-standup", topic: "Async daily standup: yesterday / today / blockers", memberCount: 9, isPrivate: false },
  { id: "C03INCIDNT", name: "incidents", topic: "Live incidents and follow-ups. SEV levels in the runbook.", memberCount: 14, isPrivate: false },
  { id: "C04PRODUCT", name: "product", topic: "Roadmap, customer feedback, specs", memberCount: 11, isPrivate: false },
  { id: "C05RELEASE", name: "releases", topic: "Deploys and release notes", memberCount: 18, isPrivate: false },
];

// [channel, hours ago, user, text]
const MESSAGES: [string, number, string, string][] = [
  ["C02STANDUP", 20, "U01MAYACHN", "Morning all! Standup for today: yesterday / today / blockers 👇"],
  ["C02STANDUP", 19.5, "U02DIEGOAL", "Y: finished idempotency keys for /payments/capture, PR #482 is up.\nT: load test against staging, then start the webhook retry queue.\nB: staging Redis OOMs at ~2k rps, need SRE to bump the memory limit."],
  ["C02STANDUP", 19, "U03PRIYANT", "Y: shipped invoice list virtualization (smooth at 10k rows).\nT: accessibility pass on the checkout modal: focus trap + screen reader labels.\nB: none."],
  ["C02STANDUP", 18.5, "U04SAMOKAF", "Y: rotated TLS certs on the edge proxies, moved p99 latency alerts to the new SLO dashboards.\nT: bump staging Redis for Diego, then the postmortem for Sunday's checkout latency spike.\nB: none."],
  ["C02STANDUP", 18, "U05LENAPRK", "Reminder: v2.8 release notes need to be final by Thursday. Priya, is the invoice list change behind a flag or GA?"],
  ["C02STANDUP", 17.8, "U03PRIYANT", "GA in 2.8, flag removed in #479."],
  ["C02STANDUP", 6, "U02DIEGOAL", "Update: load test passed after Sam's Redis bump. p99 for capture is 180ms at 2.5k rps. Merging #482 after one more review."],
  ["C02STANDUP", 5, "U01MAYACHN", "Nice work. Diego, ping me for the review. Heads up: I'm out Friday, Sam is on point for incidents."],
  ["C03INCIDNT", 50, "U04SAMOKAF", "🔴 SEV-2: checkout p99 latency > 4s for the last 10 minutes. Investigating."],
  ["C03INCIDNT", 49, "U04SAMOKAF", "Mitigated: payment client retries were fanning out and saturating the DB pool. Rolled back the client config. Latency is normal."],
  ["C03INCIDNT", 22, "U04SAMOKAF", "Follow-ups from the checkout latency incident:\n1. Pool saturation alert (owner: Sam)\n2. Cap retry fan-out in the payment client (owner: Diego)\n3. Postmortem doc in Notion (owner: Sam, due Wed)"],
  ["C03INCIDNT", 3, "U04SAMOKAF", "🟡 SEV-3: elevated 5xx (0.8%) on /api/invoices/export for the last 15 minutes. PDF renderer pods are memory-throttled. Scaling 3 → 6 replicas."],
  ["C03INCIDNT", 2.5, "U03PRIYANT", "Seeing it from the UI too: exports time out for workspaces with more than 5k invoices."],
  ["C03INCIDNT", 2, "U04SAMOKAF", "5xx back under 0.05% after scaling. Keeping the SEV-3 open for an hour. Likely root cause: the new logo-embedding step loads full-resolution images."],
  ["C03INCIDNT", 1, "U02DIEGOAL", "I'll add a size cap for embedded logos in the renderer today and link the PR here."],
  ["C04PRODUCT", 26, "U05LENAPRK", "Acme Freight interview notes are in Notion. TL;DR: they want bulk invoice export and approval workflows."],
  ["C04PRODUCT", 8, "U05LENAPRK", "Q4 roadmap draft updated: approval workflows moved up, multi-currency pushed to Q1. Feedback welcome before Friday."],
  ["C04PRODUCT", 7, "U01MAYACHN", "Approval workflows depend on the audit log work. I'll add a dependency note to the roadmap."],
  ["C01GENERAL", 10, "U01MAYACHN", "Reminder: Thursday's all-hands moved to 16:00 UTC."],
  ["C01GENERAL", 4, "U05LENAPRK", "Lunch & learn tomorrow: Sam is presenting \"How we run incidents\"."],
  ["C05RELEASE", 30, "U01MAYACHN", "v2.7.3 hotfix deployed: fixes CSV export encoding for non-ASCII customer names."],
];

const PAGE = (n: number) => `1f0e8c2a-0000-4000-8000-${String(n).padStart(12, "0")}`;

const PAGES: { id: string; title: string; parentId: string | null; hoursAgo: number; markdown: string }[] = [
  {
    id: PAGE(1),
    title: "Engineering Wiki",
    parentId: null,
    hoursAgo: 400,
    markdown: "Home for Northwind Labs engineering docs: roadmaps, release notes, postmortems and standup digests.",
  },
  {
    id: PAGE(2),
    title: "Standup Notes",
    parentId: PAGE(1),
    hoursAgo: 200,
    markdown: "Daily standup digests are filed here as child pages, one per day.",
  },
  {
    id: PAGE(3),
    title: "Release Notes: v2.8",
    parentId: PAGE(1),
    hoursAgo: 12,
    markdown: [
      "Target date: Thursday",
      "## Highlights",
      "- Invoice list virtualization: smooth scrolling for 10k+ invoices (now GA)",
      "- Idempotency keys for payment capture, so client retries are safe",
      "- Accessibility improvements in checkout: focus management and screen reader labels",
      "## Fixes",
      "- CSV export encoding for non-ASCII customer names (also shipped in 2.7.3)",
      "## Known issues",
      "- Large PDF exports can be slow for workspaces with more than 5k invoices; a fix is in progress",
    ].join("\n"),
  },
  {
    id: PAGE(4),
    title: "Q4 Roadmap",
    parentId: PAGE(1),
    hoursAgo: 8,
    markdown: [
      "## Now",
      "- Approval workflows (depends on audit log)",
      "- Audit log v1",
      "- Webhook retry queue",
      "## Next",
      "- Bulk invoice export",
      "## Later",
      "- Multi-currency (moved to Q1)",
    ].join("\n"),
  },
  {
    id: PAGE(5),
    title: "Postmortem: Checkout latency spike (draft)",
    parentId: PAGE(1),
    hoursAgo: 20,
    markdown: [
      "Status: draft, owner Sam Okafor",
      "## Summary",
      "Checkout p99 latency exceeded 4s for 52 minutes. Payment client retries fanned out and saturated the database connection pool.",
      "## Action items",
      "- [ ] Pool saturation alert (Sam)",
      "- [ ] Cap retry fan-out in the payment client (Diego)",
      "- [ ] Load test retry behaviour in staging (Diego)",
    ].join("\n"),
  },
  {
    id: PAGE(6),
    title: "Customer interview: Acme Freight",
    parentId: PAGE(1),
    hoursAgo: 27,
    markdown: [
      "Interviewer: Lena Park",
      "## Key asks",
      "- Bulk export of invoices for month-end close",
      "- Two-step approval for invoices above $10k",
      "## Quotes",
      "> We spend half a day every month exporting invoices one by one.",
    ].join("\n"),
  },
];

export function createDemoWorld(now = Date.now()): DemoWorld {
  const messages = new Map<string, StoredSlackMessage[]>(CHANNELS.map((c) => [c.id, []]));
  for (const [channel, hoursAgo, userId, text] of MESSAGES) {
    const ts = ((now - hoursAgo * HOUR) / 1000).toFixed(6);
    messages.get(channel)!.push({ ts, userId, text, replyCount: 0 });
  }

  const pages = new Map<string, StoredNotionPage>();
  for (const page of PAGES) {
    const at = new Date(now - page.hoursAgo * HOUR).toISOString();
    pages.set(page.id, { ...page, createdAt: at, lastEditedAt: at });
  }

  return {
    slack: {
      botUserId: "U0RELAYBOT",
      channels: CHANNELS.map((c) => ({ ...c })),
      users: USERS,
      messages,
    },
    notion: { pages },
  };
}
