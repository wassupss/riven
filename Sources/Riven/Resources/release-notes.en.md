## Serial pipeline groups

You can now build an agent team that runs in stages, one after another. In **Agent group panel → "New group" → [Pipeline]**, set up stages like Plan → Design → Build → QA → Ship, **pin each stage's role with a prompt**, enter a task, and:

- Stages run in order, **auto-executed**, and each stage's output is handed to the next.
- The last stage produces the overall wrap-up.
- If you stop a stage midway, the pipeline halts there instead of moving on.

You can also just tell an agent "run this as a pipeline."

## Also fixed

- When a background sub-agent finishes and the conversation continues, the panel correctly shows **in-progress → done** again (it used to stay stuck on "done," so you couldn't tell it had actually finished).

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
