/**
 * 組み込みスキル。
 *
 * スキルは「ひとまとまりの仕事の手順書」で、モデルのツール一覧とは別に置く。
 * 一覧（SKILL_CATALOG）は system プロンプトに定数として載せ、本文はモデルが
 * skill ツールで読んだときにだけ渡す。使わないスキルの本文で文脈を埋めないための分け方。
 *
 * 本文はツールの説明と同じく英語で書く。返事の言語は会話の末尾の指示で切り替わる。
 */

export type Skill = {
  /** カタログに載る名前。モデルはこの名前で skill ツールを呼ぶ。 */
  name: string;
  /** カタログに載る 1 文の説明。何のためのスキルかをここだけで分かるようにする。 */
  description: string;
  /** 読み込んだときに返す本文（SKILL.md に当たる）。 */
  content: string;
};

/**
 * コンテナのデスクトップを操作するためのスキル。
 *
 * computer_ ツールは事前にモデルへ渡さない（tool_search で見つけて tool_call で実行する）。
 * そのことを知らないと、画面を触れることに気づかないままターンが終わってしまう。
 * このスキルは、その穴を埋めるためにある。
 */
const COMPUTER_USE_CONTENT = `# Computer use: the desktop container's screen, mouse and keyboard

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
  the screen size.
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

## Coordinates

The screen size is fixed, so coordinates read off the screenshot can be used as they are.
The origin is the top-left corner. The mouse pointer is not drawn in the screenshot.

## Standard workflow

1. computer_windows — see what is open and which window has the focus
2. computer_screenshot — look at the screen
3. One action at a time: computer_click / computer_type / computer_key / computer_scroll
4. Screenshot again and check the result. Never assume a click worked because the call did
   not fail: it can land on the wrong element, and typing goes to whichever window holds
   the focus.

## Files and the screen are the same machine

read, write, edit and bash already run inside this container. To show a local file on the
screen, write it with write, then open it with computer_open (for example
file:///home/agent/page.html). To show the screen or a file to the user in the chat, use
chat_attach with screenshot true or with files.

## Asking the user

- Hand the screen over with computer_ask_user for logins, two-factor codes, identity
  checks, or any choice only the user can make.
- When a command needs a secret, set it with computer_set_env instead of asking for the
  value in a message. The value is entered in the chat and never reaches you; do not
  print, copy or guess it afterwards.
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
`;

export const COMPUTER_USE_SKILL: Skill = {
  name: "computer-use",
  description:
    "Driving the desktop container's screen, mouse and keyboard: screenshots, clicks, " +
    "typing, keys, windows and applications. The computer_ tools are not preloaded — " +
    "find them with tool_search and run them with tool_call.",
  content: COMPUTER_USE_CONTENT,
};

/** このアプリに組み込まれているスキル。 */
export const BUILTIN_SKILLS: readonly Skill[] = [COMPUTER_USE_SKILL];

/**
 * system プロンプトに載せる一覧。1 スキル 1 行にして、本文を読む前の判断材料だけを与える。
 * system プロンプトは起動中ずっと同じ文字列なので、ここも定数のまま置ける。
 */
export const SKILL_CATALOG: string = BUILTIN_SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
