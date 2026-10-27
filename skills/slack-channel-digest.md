---
id: slack-channel-digest
name: Summarise a Slack channel into Notion
description: Read recent messages in a Slack channel and file a structured digest as a new Notion page.
connectors: [slack, notion]
tools:
  - slack_list_channels
  - slack_read_channel_history
  - slack_get_user
  - notion_search
  - notion_create_page
inputs:
  - name: channel
    label: Slack channel
    description: "Channel name or id, for example #eng-standup."
    required: true
    default: "#eng-standup"
  - name: hours
    label: Hours to look back
    type: number
    default: 24
  - name: parent_page
    label: Notion parent page
    description: Title of the Notion page the digest is filed under.
    required: true
    default: Standup Notes
---
1. Read the channel's history for the requested window with `slack_read_channel_history`. If the channel cannot be found, list channels and suggest the closest match instead of guessing.
2. If there are no messages in the window, say so and stop. Do not create an empty page.
3. Find the parent page with `notion_search` using the parent page title. If several pages match, prefer an exact title match. If none match, stop and ask which page to use.
4. Create one page under the parent with `notion_create_page`:
   - Title: `<#channel> digest: <YYYY-MM-DD>` using today's date from the user's message.
   - `## Summary`: two or three sentences on what happened.
   - `## Updates`: one `###` heading per person with their key points as bullets. Keep names as they appear in Slack.
   - `## Decisions` and `## Open blockers`: bullets, or "None reported".
   - `## Action items`: `- [ ]` to-dos with an owner in parentheses, only for commitments someone actually made.
5. Report the new page's title and id. If the user declined the page, summarise the digest in your reply instead.
