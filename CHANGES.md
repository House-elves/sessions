# What's new

## 0.12.0

- New: break out. "break out" (top right of a Claude Code session) gives you a command, house-elves resume <id>, that
  carries the session on in Claude Code in a terminal: in its own clone, with the whole conversation, as your own
  Claude Code. While it's open the session says "in a terminal" and the desk waits; exit Claude Code and your next
  message here carries on from what you did there.
## 0.11.3

- The agent tidies its own clone (like deleting a local branch it no longer needs) instead of telling you to run git
  commands there, since only it can. To update one of your PRs it fetches it and leaves the change as one commit on
  the default branch, for push onto that PR. For a PR on another repo, it tells you to start a session there, with
  the message to start it with.
## 0.11.2

- Each push shows in the chat, where it happened: ✓ where it went and its PR, or ✗ why GitHub refused it, in words
  that say what to do (like gh's login needing the workflow scope for a commit that changes .github/workflows). The
  agent is told too, with your next message.
- With open PRs of yours on the repo, a session's first push asks where it goes (one of them, or a new branch and
  draft PR) instead of defaulting to a new branch.
## 0.11.1

- "push" (or "please push", "push it") typed in the chat opens the push box, since the agent can't push. The agent
  is also told to point you to the push button rather than give you git commands, and to commit without
  Co-Authored-By lines.
- The variable's name box in the settings looks like the others.
## 0.11.0

- New: session variables. Add names and values in Sessions' settings (like ANTHROPIC_API_KEY for an app a session
  builds): every session's agent is told their names, and the commands it runs have them, but the agent itself
  doesn't run with them. They stay on this machine, and once added, only their names show. Needs runner 0.53.0.
- New: push onto an open PR. Before a session's first push, "onto" picks one of your open PRs on the repo (or any
  PR by its number) instead of a new branch: the push replaces what's on that PR's branch with the session's work,
  if nobody pushed there since you looked, and "PR" then links to it.
## 0.10.0

- New: push a session's work to GitHub, when the GitHub elf is on your desk. "push" (top right of a session) shows
  the commits, what they change and the diff, and where they go: a branch, session/<its name>, on the repo (or on
  your fork when you can't push there). Push, confirm in the desk's bar, and the runner pushes it from the session's
  clone with your gh account; the first push opens a draft PR, and "PR" then links to it. Push again after more
  turns to update it. The agent itself never has GitHub credentials, and it's told to commit its work for you to
  push. Needs runner 0.52.0.
## 0.9.0

- New: type and press Enter while the agent works, as in Claude Code: your message is queued (it shows above the
  prompt, with × to take it off) and goes as soon as the turn ends, even with the tab closed. Several queued messages go
  together as one. If you interrupt it (esc), or the turn fails, what you queued waits: it goes with your next message,
  or press "send now". Needs runner 0.51.0.
## 0.8.0

- New: a suggested next message, as in Claude Code. When the agent sees an obvious next step, it suggests what you'd
  likely say next; it shows in the empty prompt, Tab puts it there, and Enter sends it (or change it first). The
  suggestion is kept off the reply. It starts with the next reply in a session, for Claude Code and IBM Bob.
## 0.7.2

- New: drag files onto an open session and it shows where they go ("Drop to attach"); let go and they upload, as with
  attach (no file dialog to wait for).
- New: the New session form takes files for the first message: drop them anywhere on the form, or choose them.
## 0.7.1

- Fixed: a link in the console (attach, show steps, rename…) no longer turns into a white box while the mouse is on it.

## 0.7.0

- New: attach PDFs and Word files. A PDF goes to Claude Code whole, so it reads the text, tables and pictures (up to
  3 MB, and with images up to 4 per message; runner 0.50.0). A Word file (.docx) goes into your message as its text,
  with its tables as rows, for Claude Code and IBM Bob alike. An old .doc file says to save it as .docx or PDF.
- New: a big file's chip shows how much of it has been sent.

## 0.6.1

- Fixed: the tag filter in an open session no longer takes the whole line, so session names show in full.

## 0.6.0

- New: an open session is a console, as close to Claude Code's as a browser gets: its colours and monospace, the
  conversation as ⏺ lines, and the prompt at the bottom. It fills the desk's window, and only the conversation
  scrolls (desk 0.6.38).
- New: type straight into the prompt. Enter sends, Ctrl+Enter starts a new line, Esc interrupts a working turn.
- New: paste a screenshot or drop files on the session, or attach them: images go to Claude Code with your message
  (up to 4), text files go into the message.

## 0.5.0

- New: a session shows its model (like Opus 5.5), what it has cost, how long its agent has worked, and how full its
  context is, as a percentage; each turn shows how long it took and its model. A working turn shows how long it's
  been going. (Runner 0.49.0; turns from before show their cost only.)

## 0.4.0

- New: a session started from a todo, or from one step of its checklist, starts with the todo's description,
  checklist and issues as its goal, for you to change before you start.

## 0.3.1

- New: when IBM Bob (or Claude Code) isn't installed here, the New session form offers Install. The desk asks you
  first and says the npm command it runs, then what's left for you, such as its login (desk with runner 0.48.0).

## 0.3.0

- New: pick the coding agent for a session, Claude Code or IBM Bob, with your default in Settings (Coding agent).
  IBM Bob's turns show what they cost in Bobcoins.
- Fixed: the page has room between the tags, the sessions and the empty state.

## 0.2.0

- New: the Repo field suggests repos as you type: those on your GitHub tab's board and those of your sessions. You can
  still type any repo.
- New: a todo's Start a session (Todo list 0.4.0) opens the New session form with the todo, and its Open session comes
  back to the session. Link a todo goes to the Todo list to pick one.
- Fixed: the New session form has room between its fields, and its fields look like the desk's.

## 0.1.0

- New: named sessions with Claude Code, each in its own clone of a repo, continued from any device signed in to your desk.
- New: the first message is the session's goal, pinned above the chat and given to the agent with every turn.
- New: a session can be linked to a todo.
- New: tag sessions (Personal, Work, or your own tags in Settings) and show one tag at a time.
