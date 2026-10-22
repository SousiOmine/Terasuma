/**
 * 組み込みスキルと、スキルの一覧。
 *
 * スキルは「ひとまとまりの仕事の手順書」で、モデルのツール一覧とは別に置く。
 * 組み込みスキルと、エージェントが作ったスキルの一覧は、どちらも system プロンプトに載せる。
 * 本文はモデルが skill ツールで読んだときにだけ渡す。
 * ターンの途中でスキルが変わったときは、そのターンの system プロンプトを組み直さず、
 * 次のモデル呼び出しの前に user メッセージで知らせる（engine.ts）。
 *
 * 本文はツールの説明と同じく英語で書く。返事の言語は会話の末尾の指示で切り替わる。
 */

export type { LoadedSkill, Skill, SkillFileStore, SkillLibrary } from "./skill-types";

import type { Skill, SkillFileStore, SkillLibrary } from "./skill-types";

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
- computer_connect_app(provider, reason) — connect an app with the user's own sign-in
  (GitHub), or point the user at the token to save (Discord). GitHub signs in from a
  card in the chat, and the token becomes an environment variable (GH_TOKEN) for
  commands. Use this when a task needs GitHub and GH_TOKEN is not set.
- app_request(provider, method, path, body?) — call the API of a connected app. The
  token is used by Terasuma and never shown to you. For Discord, the user saves a bot
  token in Settings > Connections first; then use GET or POST /channels/{id}/messages.

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
- When a task needs GitHub and it is not connected, use computer_connect_app instead of
  asking for a personal access token.
- Do not ask for a Discord user token: automating a user account is not allowed. The
  user saves a bot token in Settings > Connections and adds the bot to the server with
  the "Add to server" link.
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

/**
 * スキルの作り方を説明するスキル。
 *
 * スキルの本文は、作るときにだけ読めばよい。標準の置き場と frontmatter の規則を
 * ここにまとめ、skill_manage の使い方と、同梱ファイルの置き方を伝える。
 */
const SKILL_CREATE_CONTENT = `# Creating skills

A skill is a directory with a SKILL.md file, following the Agent Skills format.
The skills you create live in the computer you operate, in
/home/agent/.agents/skills/<name>/SKILL.md. The skill tool lists them in the catalog in
your instructions and loads SKILL.md when you call it.

## When to save one

- The user asks you to remember a procedure, a checklist or a way of doing something.
- You worked out a repeatable sequence of commands, paths and checks.
- A correction should apply to future work.

Do not save one-off facts or secrets.

## Creating one

skill_manage(action: "create", name, description, content)

- name: 1-64 characters of lowercase letters, digits and hyphens. It must not start or
  end with a hyphen, must not contain "--", and becomes the directory name.
- description: 1-1024 characters. Say what the skill does and when to use it. This is the
  only text in the catalog.
- content: the Markdown body of SKILL.md. skill_manage writes the frontmatter
  (name and description) for you.

The file is written as:

---
name: <name>
description: <description>
---

<body>

## Writing the body

- Start with a heading that names the job.
- Say when to use the skill and when not to.
- Give the steps in order, with exact commands, paths and arguments.
- For each step, say what to check and what a failure looks like.
- Write for a reader who has the tools but not this conversation.
- Keep SKILL.md under about 500 lines. Move long reference material to references/.

## Supporting files

You can add files under the skill directory with write or bash:

- scripts/ for executable code
- references/ for longer documentation
- assets/ for templates, images and data

The skill tool lists these files when it loads SKILL.md. Reference them with relative
paths such as scripts/run.sh. The skill directory is the base for those paths. Do not
read every supporting file yourself; load one when the instructions need it.

## Updating and deleting

- skill_manage(action: "update", name, description?, content?) replaces the description
  and/or the body. Optional frontmatter fields written by other tools are preserved.
- skill_manage(action: "delete", name) removes the whole skill directory, including
  scripts, references and assets.
- skill_manage(action: "list") shows the built-in skills, your skills, and directories
  that could not be read.

Built-in skills (computer-use and skill-create) are read-only.

## Checking

After creating or updating a skill, load it with skill(name) and check that the steps are
complete. The catalog in your instructions updates at the start of the next turn. This
turn's conversation also gets a short note about the change, and skill can load a new
skill right away.

## Rules

- One skill is one job. Split unrelated procedures.
- Prefer concrete commands and checks over general advice.
- Do not put secrets, tokens or personal data in a skill.
- Do not duplicate a built-in skill. Load it first.
- A skill is an instruction document. It is not a place for conversation history.
`;

export const SKILL_CREATE_SKILL: Skill = {
  name: "skill-create",
  description:
    "Creating and maintaining skills: the Agent Skills format, where SKILL.md lives under " +
    "/home/agent/.agents/skills, the name and description rules, supporting files, and how " +
    "to update or delete a skill.",
  content: SKILL_CREATE_CONTENT,
};

/** このアプリに組み込まれているスキル。 */
export const BUILTIN_SKILLS: readonly Skill[] = [COMPUTER_USE_SKILL, SKILL_CREATE_SKILL];

/**
 * system プロンプトに載せる一覧。1 スキル 1 行にして、本文を読む前の判断材料だけを与える。
 * 組み込みと自作の両方を渡す。スキルの一覧が変わったときだけ文字列が変わる。
 */
export function skillCatalogText(skills: readonly Skill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

/**
 * 組み込みスキルと、置き場のスキルをまとめる。
 * 一覧と本文は呼び出しのたびにファイルから引き直すので、作成や更新はすぐに見える。
 */
export function createSkillLibrary(store: SkillFileStore): SkillLibrary {
  return {
    all() {
      return [...BUILTIN_SKILLS, ...store.scan().skills];
    },
    get(name) {
      const builtin = BUILTIN_SKILLS.find((skill) => skill.name === name);
      if (builtin !== undefined) {
        return { ...builtin, dir: null, resources: [], resourcesTruncated: false };
      }
      return store.get(name) ?? undefined;
    },
    isBuiltin(name) {
      return BUILTIN_SKILLS.some((skill) => skill.name === name);
    },
  };
}
