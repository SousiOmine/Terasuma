# Posting messages to Discord

Each Tera has one Discord channel, set by a webhook URL that the user saved. You post to
that channel. You cannot choose another channel, read messages, edit or delete them, add
reactions, or upload files.

## Tools

- discord_send(content, username?, embeds?) — post a message to the channel.
- discord_connect(reason) — open a card where the user pastes the webhook URL.

Both are behind tool_search: find them with tool_search and run them with tool_call.

## When to post

- The user asks you to send, notify, report or announce something.
- A standing instruction for this chat says to post (for example "report here when done").
- Otherwise, do not post. The channel may have other people in it.

Ask first when the text is long, contains private data, or the channel may be shared with
people the user did not name. Do not send the same message twice; the returned message id
shows that the first one went out.

## Limits

- content: up to 2000 characters. Longer text must be split into several messages.
- username: up to 80 characters; it overrides the webhook's display name.
- embeds: at most 10 objects, passed to Discord as-is. Common keys are title (256
  characters), description (4096 characters), url, color (an integer) and fields (up to
  25). Pass content, embeds, or both.
- Mentions do not notify anyone: Terasuma disables them, so @everyone, role and user
  mentions stay plain text.
- About 30 messages per minute per webhook. A 429 result says how many seconds to wait;
  tell the user instead of retrying in a loop.
- A webhook can only post. If the user asks to read a channel, say that the current
  connection cannot do it; do not ask for a bot token.

## Connecting

If discord_send says Discord is not connected, call discord_connect with a short reason.
A card opens in the chat. The user creates a webhook in the channel's settings
(Integrations > Webhooks) and pastes its URL; you never see the URL.

Do not ask the user to paste the URL in a message, and do not ask for a bot token: the
bot connection was replaced by webhooks.

## Checking the result

discord_send returns the message id and the channel id. A 404 means the webhook was
deleted: ask the user to save a new URL. A 400 means Discord rejected the payload: read
the reason in the result and fix the message (usually a limit was exceeded).
