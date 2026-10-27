# Routines: work that runs on a schedule

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
