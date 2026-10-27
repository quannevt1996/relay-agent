---
id: incident-timeline-to-postmortem
name: Add a Slack incident timeline to a postmortem
description: Turn recent updates in an incident channel into a timeline appended to the postmortem page in Notion.
connectors: [slack, notion]
tools:
  - slack_read_channel_history
  - notion_search
  - notion_read_page
  - notion_append_to_page
inputs:
  - name: channel
    label: Incident channel
    required: true
    default: "#incidents"
  - name: hours
    label: Hours to look back
    type: number
    default: 72
  - name: postmortem
    label: Postmortem page
    description: Title (or part of it) of the postmortem page to update.
    required: true
    default: Postmortem
---
1. Read the incident channel for the requested window with `slack_read_channel_history`.
2. Find the postmortem with `notion_search` and read it with `notion_read_page` so you do not duplicate a timeline that is already there.
3. Append one section with `notion_append_to_page`:
   - Heading: `## Timeline from <#channel> (last <N>h)`.
   - One bullet per meaningful update, oldest first: `- YYYY-MM-DD HH:MM UTC, <person>: <what happened>`. Merge chatter that adds nothing; keep severity changes, mitigations and owners.
4. Never rewrite or remove existing content; this skill only appends.
5. Report how many timeline entries were added and to which page.
