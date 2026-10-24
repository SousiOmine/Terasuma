/**
 * 組み込みスキルと、スキルの一覧。
 *
 * スキルは「ひとまとまりの仕事の手順書」で、モデルのツール一覧とは別に置く。
 * 組み込みスキルと、エージェントが作ったスキルの一覧は、どちらも system プロンプトに載せる。
 * 本文はモデルが skill ツールで読んだときにだけ渡す。
 * ターンの途中でスキルが変わったときは、そのターンの system プロンプトを組み直さず、
 * 次のモデル呼び出しの前に user メッセージで知らせる（engine/sdk.ts）。
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
 * アプリ（コネクタ）に接続するためのスキル。
 *
 * 接続ツールはアプリごとに 1 つあり、アプリ名を列挙するとコネクタを足すたびに書き換えが要る。
 * そこで、探し方（tool_search）とカードの流れだけを書き、名前は検索結果から取らせる。
 */
const CONNECTORS_CONTENT = `# Connecting an app (connectors)

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
`;

export const CONNECTORS_SKILL: Skill = {
  name: "connectors",
  description:
    "Connecting an app before you use it (its API, or a program inside the computer): how " +
    "to find that connector's connect tool with tool_search, and how the user fills in the card.",
  content: CONNECTORS_CONTENT,
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

Built-in skills are read-only. Load one when the work matches it, and check it before
teaching the user a procedure.

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

/**
 * Discord へメッセージを送るためのスキル。
 *
 * 送信先は Tera ごとに保存された webhook が決める（送るたびにチャンネルを選ぶツールではない）。
 * webhook は投稿だけができるので、読み取りや編集の手順は書かない。
 * 制限（文字数・レート・メンション）を先に伝え、無駄な失敗を減らす。
 */
const DISCORD_CONTENT = `# Posting messages to Discord

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
`;

export const DISCORD_SKILL: Skill = {
  name: "discord",
  description:
    "Posting messages to one Discord channel per Tera through a webhook: when to send, " +
    "the 2000-character and embed limits, rate limits, and how to connect a webhook.",
  content: DISCORD_CONTENT,
};

/**
 * 新しい Tera を作るためのスキル。
 *
 * Tera は役割と履歴を持つ単位なので、作る前に何を任せるかをユーザーへ確かめる。
 * 聞き方は既存のフォーム（chat_ui）に寄せ、新しい画面部品を増やさない。
 * ツールは tool_search の向こう側にあるので、検索の言葉まで書いておく。
 */
const TERA_CREATE_CONTENT = `# Creating another Tera

A Tera is an assistant with one conversation, one identity and one workspace folder.
Creating another one gives a different role its own history and its own way of working.

## When to create one

- The user asks for another assistant, a separate role, or a Tera for a different job.
- The work is long-running and belongs to another role: it would bury this conversation, or
  it needs a different way of working.
- Do not create one for a one-off answer, to store notes, or to split work you can finish
  here. Do the work yourself instead.
- Create one per request unless the user asks for several.

## Ask before creating

Ask the user for three things with chat_ui, in one card with one <Form>:

<Card title="...">
<Text>...</Text>
<Form submit="...">
<Field label="Name" type="text" required placeholder="Researcher" />
<Field label="Role" type="text" required placeholder="Research articles and summarize them" />
<Field label="Behavior policy" type="text" required placeholder="Cite sources; ask when unsure" />
</Form>
</Card>

- Write the card, its text, the labels and the submit label in the reply language.
- Name: the label in the sidebar, up to 60 characters.
- Role: what the Tera is responsible for, in one or two sentences.
- Policy: how it works: tone, what it checks, when it asks the user.
- The form is the question. Do not repeat the same questions in your text.

The answer arrives as a message with "label: value" lines. Use those values as written; do
not paraphrase, shorten or translate them.

## Create it

1. tool_search with the query "tera create" to get the arguments of tera_create.
2. tool_call with name "tera_create" and these arguments:
   - id: a short lowercase English slug of the role, for example "researcher". It becomes
     the workspace folder name, so choose it once and keep it.
   - name, role, policy: the values the user wrote.
3. If it fails because the id or the name is taken, choose another id, or ask the user for
   another name. Do not retry the same values.

## What the tool does

- The new Tera's identity is built from its name, role and policy, and is in its system
  prompt from its first turn.
- Its workspace is /home/agent/teras/<id>. The computer, skills and the web work there the
  same way they do for you.
- The new Tera appears in the sidebar as soon as the tool returns. The user opens it there;
  this conversation stays where it is.

## After creating

Tell the user the name, what the Tera will do, and that it is in the sidebar. Do not speak
for the new Tera, and do not copy this conversation into its history.
`;

export const TERA_CREATE_SKILL: Skill = {
  name: "tera-create",
  description:
    "Creating another Tera: when a task needs a separate assistant with its own role and " +
    "history, asking the user for its name, role and behavior policy in a form, then creating " +
    "it with the tera_create tool.",
  content: TERA_CREATE_CONTENT,
};

/**
 * スケジュールされた実行（ルーチン）のスキル。
 *
 * ツールは tool_search の向こう側にあるので、名前と引数の形をここに書いておく。
 * 実行の仕方（何をどこへ届けるか）は、ルーチンを作るときの指示に書くものなので、ここには書かない。
 */
const ROUTINE_CONTENT = `# Routines: work that runs on a schedule

A routine saves an instruction and runs it as this Tera's own turn at a fixed local time
or interval.

## When to use it

- The user asks for work "every morning at 8", "every 30 minutes", "on Friday evening", or
  with any other time or repeat. Do not create a routine the user did not ask for.

## Creating

Ask for what you do not already have: a name, when (daily, weekly, or every N minutes),
and what to do; if the user already said them, do not ask again.

routine_create takes name (1-60 characters), prompt (up to 4000 characters), and schedule:

- {"kind":"daily","time":"08:30"}
- {"kind":"weekly","days":[1,5],"time":"18:00"} (1 = Monday … 7 = Sunday)
- {"kind":"every","minutes":30} (5-1440)

The prompt is sent as the user's message when the routine runs.

## Managing

routine_list shows id, schedule, next run and last result. routine_update changes or
disables one. routine_delete removes it: confirm with the user first. A Tera can have at
most 50 routines.
`;

export const ROUTINE_SKILL: Skill = {
  name: "routine",
  description:
    "Scheduled work (routines) that runs at a set local time or interval: when to create " +
    "one, what the user needs to decide first, the schedule forms, and how to list, change, " +
    "delete or run it.",
  content: ROUTINE_CONTENT,
};

/**
 * pi（pi-coding-agent）にコードを書かせるためのスキル。
 *
 * pi はコンピュータの中の CLI で、tmux 越しに呼ぶ。接続している間だけ一覧に載せ、
 * 切断したら一覧から消す（BUILTIN_SKILLS には入れない）。
 */
const PI_CODING_CONTENT = `# Writing code with pi-coding-agent

pi is a coding agent CLI installed in the computer: the Debian container where read,
write, edit and bash run. tmux, bun, node and git are available there too. When the user
asks for code to be written, fixed or refactored, let pi do the editing instead of editing
the files yourself. Its work files and tmux session are per job, so several jobs can run at once.

## When to use it

- The user asks you to write, implement, fix, refactor or restructure code.
- You are about to change files in a repository.

Do not call write or edit yourself for this work. Load this skill, send the job to pi, and
check what pi produced.

## Call pi through tmux

Give each job its own slot (\`docs\`, \`tests\`, ...): its own files and tmux session, so
several jobs can run at once. Run this in your workspace folder.

\`\`\`sh
slot=docs
work="$HOME/.pi-work/\${PWD##*/}/$slot"; session="pi-work-\${PWD##*/}-$slot"
mkdir -p "$work"

cat > "$work/prompt.md" <<'BRIEF'
<job for pi: files, expected behavior, what not to touch, tests, and "do not commit, push,
delete anything, or send anything outside this computer">
BRIEF

tmux kill-session -t "=$session" 2>/dev/null
tmux new-session -d -s "$session" -c "$PWD" -x 220 -y 60
tmux send-keys -t "$session" -l "pi -p \\"$(cat $work/prompt.md)\\" 2>&1 | tee -a $work/log; echo __PI_DONE__ >> $work/log"
tmux send-keys -t "$session" Enter
\`\`\`

- Put the job in a file: a long request inside the tmux command line is silently dropped.
- \`-t "=$session"\` is an exact match; a prefix would also hit \`job1\` from \`job10\`.
- \`tmux ls\` shows the running jobs.

## While a job runs

Starting a job returns at once; tmux keeps it running in the background. Keep working:
ask the user, start another job in its own slot, or read something else. Check a slot when
you need its result.

\`\`\`sh
slot=docs; work="$HOME/.pi-work/\${PWD##*/}/$slot"
grep -qx __PI_DONE__ "$work/log" && grep -v '^__PI_DONE__$' "$work/log" | tail -60 || echo "still running"
\`\`\`

- No marker: still running. \`tmux capture-pane -p -t "pi-work-<tera id>-$slot" -S -60\` shows where it is.
- Only the marker line \`echo\` wrote means it is over; your own command line contains the word too.
- Stop one job with \`tmux kill-session -t "=pi-work-<tera id>-$slot"\`.
- A bash call is cut off at about 10 minutes; wait in a loop only when you have nothing else to do.

## Running jobs side by side

Start each job in its own slot and wait for the ones you started; keep it to a handful.

- Two jobs that change the same files overwrite each other. Split the files, or give a job
  its own worktree: \`git worktree add -b "pi/$slot" "$work/tree" HEAD\`, start pi with
  \`-c "$work/tree"\`, read \`git -C "$work/tree" diff\`, then \`git worktree remove "$work/tree"\`.
- Do not run git commands that change state (\`checkout\`, \`stash\`, \`rebase\`, ...) while a job runs.

## What to put in the request

Files and directories to change, the behavior you expect and how to check it, what must not
be touched, and whether tests are needed. Always add: "Do not commit, push, delete anything,
or send anything outside this computer." Keep one job to one concern; split a large job.

## Check the result yourself

- Read \`git status --short\` and \`git diff\` before accepting the work.
- Run \`bun run typecheck\`, \`bun run lint\` and \`bun test\` (or the repository's
  equivalents) and read the failures.
- Do not trust pi's "I checked it" message. The files and the command output are the
  evidence.

## When something is wrong

Send the work back to pi with a specific description of what is wrong in the diff. Fix it
yourself only when the change is obviously one or two lines, or after pi has failed twice
in a row. If you do edit it yourself, say so in your reply to the user.

## Rules

- Several jobs at once are fine, one slot each. Two jobs in one slot overwrite each other's
  prompt and log and kill each other's session.
- For a short question that needs no repository changes (a one-line check), calling
  \`pi -p 'question'\` once directly is fine.
- If pi is not connected or not available, ask the user to connect it in Settings >
  Connectors. The agent can also load the connectors skill and call app_connect_pi.
`;

export const PI_CODING_SKILL: Skill = {
  name: "pi-coding",
  description:
    "Writing or changing code with pi-coding-agent (pi) inside the computer through tmux: how to call it, wait for it, and check the result. Load it before you edit code yourself.",
  content: PI_CODING_CONTENT,
};

/** このアプリに組み込まれているスキル。 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  COMPUTER_USE_SKILL,
  CONNECTORS_SKILL,
  SKILL_CREATE_SKILL,
  DISCORD_SKILL,
  TERA_CREATE_SKILL,
  ROUTINE_SKILL,
];

/**
 * system プロンプトに載せる一覧。1 スキル 1 行にして、本文を読む前の判断材料だけを与える。
 * 組み込みと自作の両方を渡す。スキルの一覧が変わったときだけ文字列が変わる。
 */
export function skillCatalogText(skills: readonly Skill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

/**
 * 組み込みスキルと、置き場のスキルをまとめる。
 * 一覧と本文は呼び出しのたびに引き直すので、作成や更新はすぐに見える。
 * extra は接続状態などで変わるスキル（pi-coding など）を、呼ぶたびに評価して足す。
 */
export function createSkillLibrary(store: SkillFileStore, extra: () => readonly Skill[] = () => []): SkillLibrary {
  function available(): readonly Skill[] {
    return [...BUILTIN_SKILLS, ...extra()];
  }

  return {
    all() {
      return [...available(), ...store.scan().skills];
    },
    get(name) {
      const builtin = available().find((skill) => skill.name === name);
      if (builtin !== undefined) {
        return { ...builtin, dir: null, resources: [], resourcesTruncated: false };
      }
      return store.get(name) ?? undefined;
    },
    isBuiltin(name) {
      return available().some((skill) => skill.name === name);
    },
  };
}
