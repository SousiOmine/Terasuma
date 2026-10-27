# Creating another Tera

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
