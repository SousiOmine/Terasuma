# MCP servers

An MCP server adds tools from outside this conversation. Its tools are named
<server id>_<tool name>, and they are not in your tool list: find one with tool_search and
run it with tool_call.

## Using a server's tools

tool_search with what you want to do, or with the server id, then tool_call with the exact
name from the result. If a tool needs authorization, ask the user to press Authorize in
Settings > MCP.

## Adding a server

Ask for what you do not have: the server id, and how it starts (a command for stdio, a URL
for http). Then tool_search "mcp add" and call mcp_add_server with id, type and
command/args or url.

It saves and connects in the same call. When it connects, the result lists its tool names,
and you can use them right away in this same turn.

mcp_add_server takes no env, because secrets must not stay in the conversation. A server
that needs a secret in its environment is added by the user in Settings > MCP. Never ask
the user to paste a secret in a chat message.

## Removing a server

tool_search "mcp remove", then mcp_remove_server with the id. Remove only a server the user
asked to remove; its tools stop working at once.
