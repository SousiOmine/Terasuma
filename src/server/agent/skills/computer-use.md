# Computer use: the desktop container's screen, mouse and keyboard

The Debian desktop container that read, write, edit and bash run in also has a screen.
These tools drive that screen: take screenshots, click, type, press keys, scroll, list
windows, start applications, and hand the screen to the user.

## When to use it

- A GUI application that has no CLI or API (a browser, an installer, a desktop app)
- Checking what the user would see: whether a dialog opened, what a window shows
- Reproducing manual steps ("open the browser and go to ...")
- Anything a screenshot answers faster than a description would

## The computer_ tools are not preloaded

They are held behind tool_search, so they are not in your tool list until you look for
them. Two steps:

1. tool_search with query "computer" — the result lists the tools with their descriptions
   and argument schemas
2. tool_call with name "computer_screenshot" and args {} — runs it

Use tool_call for every computer_* call, with the exact name from the search result. A
computer_* name called directly fails, because the tool is not in your tool list.

If tool_search finds no computer_ tools, the container is not available on this machine
(podman is missing). Tell the user; do not retry.

## The tools

- computer_screenshot() — capture the screen and return it as an image. The result says
  the screen size, and the mouse pointer is drawn in it.
- computer_move(x, y) — move the pointer without clicking. Take a screenshot afterwards
  to check the target and its hover state.
- computer_click(x, y, button?, count?) — click at screen coordinates. button is left,
  right or middle (default left); count is 1-3 (default 1).
- computer_scroll(x, y, direction, amount?) — wheel at coordinates. direction is up,
  down, left or right; amount is 1-20 (default 3).
- computer_type(text) — type text into the focused window. Click the target first.
- computer_key(key) — press one key or a combination: "Return", "Escape", "ctrl+c",
  "alt+Tab". The names are the ones xdotool accepts.
- computer_windows() — list the visible windows and which one has the keyboard focus.
- computer_open(command, args?) — start an application (for example command "chromium").
  It keeps running after the call returns.
- computer_wait(seconds) — wait up to 60 seconds, for example while an application starts.
- computer_ask_user(question) — hand the screen to the user and wait. What the user
  replies, or that the user finished, comes back as the result.
- computer_set_env(name, description) — ask the user for a secret (an API key, token or
  password) and set it as an environment variable for commands in this container. The
  value comes from the user and you never see it. Use this instead of asking the user to
  paste a secret into the chat.
- app_request(provider, method, path, body?) — call the API of a connected app. The
  token is used by Terasuma and never shown to you. An app that runs inside this computer
  has no API.

Connecting an app at all (its API, or a program inside this computer): load the connectors
skill; it has the flow and the connect tools.

## Coordinates

The screen size is fixed, so coordinates read off the screenshot can be used as they are.
The origin is the top-left corner. The mouse pointer is drawn in the screenshot: its
position shows where the last move or click landed, and its shape (an arrow, an I-beam, a
hand) shows what is under it.

## Standard workflow

1. computer_windows — see what is open and which window has the focus
2. computer_screenshot — look at the screen
3. When a target is small or you are unsure, computer_move to it and screenshot again:
   the pointer must sit on the target, and the hover state shows whether it is clickable.
4. One action at a time: computer_click / computer_type / computer_key / computer_scroll
5. Screenshot again and check the result. Never assume a click worked because the call did
   not fail: it can land on the wrong element, and typing goes to whichever window holds
   the focus.

## Files and the screen are the same machine

read, write, edit and bash already run inside this container. To show a local file on the
screen, write it with write, then open it with computer_open using its absolute path as a
file:// URL. To show the screen or a file to the user in the chat, use chat_attach with
screenshot true or with files.

## Asking the user

- Hand the screen over with computer_ask_user for logins, two-factor codes, identity
  checks, or any choice only the user can make.
- When a command needs a secret, set it with computer_set_env instead of asking for the
  value in a message. The value is entered in the chat and never reaches you; do not
  print, copy or guess it afterwards.
- When a task needs an app that is not connected, load the connectors skill and use that
  app's connect tool instead of asking for a token or an API key in a message.
- For Discord, load the discord skill. The user saves a channel webhook URL per Tera with
  discord_connect; a webhook can only post, so do not offer to read or edit messages.
- Write the question for the user to read, in the reply language.
- Do not take screenshots or type while the user is working on the screen; wait for the
  result.
- Never type passwords, tokens or card numbers yourself.

## Rules

- Ask before anything destructive or hard to undo: deleting or moving files, sending
  messages or mail, purchases, installing software, changing settings, closing unsaved
  work.
- Act on what the screenshot shows, one step at a time, and verify each step.
- A timeout means the command did not finish within 15 seconds; a non-zero exit means
  xdotool refused. Read the message and decide the next step instead of repeating it.
