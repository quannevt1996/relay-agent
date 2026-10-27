---
id: notion-action-items-to-slack
name: Post a Notion doc's action items to Slack
description: Find a Notion page, pull out its open action items and post them to a Slack channel.
connectors: [notion, slack]
tools:
  - notion_search
  - notion_read_page
  - slack_list_channels
  - slack_post_message
inputs:
  - name: page
    label: Notion page
    description: Title (or part of it) of the page with the action items.
    required: true
    default: Postmortem
  - name: channel
    label: Slack channel
    description: "Where to post, for example #incidents."
    required: true
    default: "#incidents"
---
1. Find the page with `notion_search`. Prefer the closest title match; if several are equally plausible, list them and ask which one.
2. Read it with `notion_read_page`. Open action items are unchecked to-dos (`- [ ]`) and bullets under an "Action items" or "Follow-ups" heading. Skip anything already checked off.
3. If there are no open action items, say so and do not post.
4. Post one message with `slack_post_message`:
   - First line: `*Open action items from <page title>*`
   - One `•` bullet per item, keeping the owner if the page names one.
   - Do not @-mention people; Slack user ids are not available from Notion.
5. Report how many items were posted and the message timestamp.
