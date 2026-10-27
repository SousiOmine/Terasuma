# Connecting an app (connectors)

Some work needs something outside this conversation: an API (for example GitHub's), or a
program installed in the computer (for example pi, a coding agent). Each one is a
connector. A connector stores what that app needs, either a token or the settings of the
program, and makes it available to your tools.

## When to use it

- A task needs an app and its tool says it is not connected.
- You are about to call an API, or to write code with a program inside the computer.
- No secret for that app is available yet. Never ask the user to paste a token or an API
  key in a chat message.

## The flow

1. Pick the connector the task needs.
2. tool_search with the app's name and "connect" (for example "github connect"). Every
   connector has its own connect tool, named app_connect_<app id>, and its description says
   what that connector needs.
3. tool_call with the exact tool name from the result, and {"reason": "<why you need it>"}.
   A card opens in the chat and the user fills it in. The values never reach you.
4. When the call returns, the app is ready. Continue the task.

Take the tool name from the search result. Do not build app_connect_<app id> from memory
and do not guess an app id. If the search finds no connect tool, tell the user the app
cannot be connected here.

## After connecting

- An app with an API: call it with app_request (find it with tool_search). The token is used
  by Terasuma and never shown to you.
- A program inside the computer: its skill appears in your skill catalog. Load it with the
  skill tool and follow it. Such a program has no API, so app_request does not apply.
- Disconnecting is the user's job (Settings > Connectors). Do not try to remove a
  connection, and never print a saved secret.

## If the user asks to connect something

You can start the same flow: find the connect tool, call it with a reason written for the
user, and wait for the card. You never type the secret yourself.
