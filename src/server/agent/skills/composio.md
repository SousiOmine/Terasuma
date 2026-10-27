# Calling apps through Composio

Composio is one connection that reaches over 1,600 apps: Gmail, Google Calendar, Slack,
Notion, Linear, HubSpot, GitHub, and many others. Each app contributes tools with
SCREAMING_SNAKE_CASE slugs such as GMAIL_SEND_EMAIL or LINEAR_CREATE_ISSUE.

Two tools, both behind tool_search. Find them and run them with tool_call:

- app_composio_search(query, toolkit?) — search the catalog. Returns slugs, a short
  description and the arguments of each tool. toolkit narrows it to one app ("gmail").
- app_composio_execute(toolSlug, args?) — run one tool by slug. It runs as the account the
  user already connected in Composio.

## When to use it

- A task needs an app that Composio covers, and no MCP server or connector provides it.
- The user asks for something "in Gmail", "in Slack", "in my Notion", and so on.
- Do not use it for files in the computer: read, write, edit and bash work on those.

## Searching

1. tool_search "composio" to get the argument shapes.
2. app_composio_search with what you want to do, in a few words: "list unread emails",
   "create a calendar event". Add toolkit when you know the app.
3. Read the arguments in the result. They are the tool's input fields, with type and
   whether they are required.

If a search returns nothing, try other words or drop the toolkit filter. Do not invent a
slug: an unknown slug fails.

## Running

app_composio_execute with the exact slug from the search result and the arguments as an
object. Pass only the arguments the schema names; leave optional ones out rather than
guessing.

- The result is JSON. Large results are cut at 20,000 characters; ask for less (a smaller
  page size, a narrower filter) instead of repeating the call.
- "it failed" in the result means Composio ran the tool and it returned an error. Read the
  reason: usually a wrong argument, or the app is not connected.
- An app that is not connected yet must be connected in the Composio dashboard. If a tool
  fails because of that, tell the user which app to connect; you cannot connect it
  yourself.

## Rest API

app_request works with Composio too, using the same key. Reach for it when you need
something the two tools do not give, for example GET /tools/<slug> for a full schema.

## Rules

- Never print or ask for the API key. It stays in Terasuma.
