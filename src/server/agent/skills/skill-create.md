# Creating skills

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
