<img src="https://raw.githubusercontent.com/House-elves/elf-desk/main/docs/brand/mark.svg" width="72" alt="House Elves logo: a checkmark that ends in an elf's hat">

# sessions

A [House Elf](https://github.com/House-elves) that comes with [Elf Desk](https://github.com/House-elves/elf-desk):
named chat sessions with a coding agent, each working in its own clone of a repo. Sessions live on your machine, not
in the browser, so you can start one on your laptop and continue it from your phone or another computer signed in to
your desk.

## What it does

- **New session:** pick a repo, name the session, and say what it's for. That first message is the session's
  **goal**: it stays pinned above the chat, and the agent gets it again with every turn, so a long session doesn't
  lose it. **Edit goal** changes what the agent gets from then on; the first message stays as you sent it.
- **Chat:** each message you send is one turn. The tab shows what the agent is doing as it works (its text, and
  `▸ Bash: mvn test` for each step), then its reply. **Stop** ends a turn early.
- **Your choice of agent:** Claude Code or IBM Bob, picked on the New session form, with your default in Settings
  (`CODING_AGENT`). A session keeps its agent. Agents not installed here, or that can't run a session yet (Codex,
  pi), are listed but can't be picked. IBM Bob uses the API key in the runner's settings, and needs runner 0.47.0.
- **Its own clone:** each session works in a clone of the repo kept for it alone (the runner's `checkout.slot`), so
  the agent picks up where it left off, and two sessions on one repo never touch each other's work.
- **Linked to a todo:** a session can point at a todo in the [Todo list](https://github.com/phillip-kruger/todo-list)
  elf, and a todo can start a session (see Links).
- **Tags:** put tags on a session, from the ones in its settings (`TAGS`, "Personal, Work" to start), and show only
  the sessions with one tag. The tag you show is remembered per browser.
- **Tabs you manage:** rename, archive (hidden, kept) and delete (its chat and its clone go).

## What it reads and writes

- It keeps your sessions in `~/.config/sessions/sessions/`, one JSON file each, and the agents' reports in
  `~/.config/sessions/agents/`.
- When you start a session, it checks with your gh account (`GITHUB_LOGIN`) that you can see the repo.
- To suggest repos for a new session, it reads the repos on the [GitHub elf](https://github.com/House-elves/github)'s
  board, from `~/.config/github/board/board.json`, which it only reads. You can still type any repo.
- Each turn is an agent the [runner](https://github.com/House-elves/elf-runner) starts in its sandbox: Claude Code or
  IBM Bob, in the session's clone, with no GitHub credentials and nothing of your home. It can commit there; nothing is pushed.
  It can reach the internet, as the desk's other coding agents can.

## Links

Elves can't read each other's data, so a link is two halves, handed over through the desk's navigation:

- `#sessions/new/<elf>/<ref>/<title>[/<session>]` opens the New session form linked to that item, with its title as
  the start of the goal. With a session id (`s` and digits), the session gets that id, so the other elf can keep its
  half of the link before it starts; if it's started already, the route opens it. The title is %-escaped (`encodeURIComponent`, and `!'()*` too).
- `#sessions/link/<session>/<elf>/<ref>/<title>` links an existing session, then opens it.
- **Link a todo** opens the Todo list at `#todo-list/pick-session/<session>`, and **Linked to** opens
  `#<elf>/todo/<ref>`.

A link is only a pointer: nothing runs until you click Start or Send.

A session started from a todo (or one step of its checklist, `<todo>.<step>`) starts from what the todo says: Sessions
reads that one todo from the Todo list's saved list (`~/.config/todo-list/todos/todos.json`, which it only reads) and
puts its title, who asked, its due date, description, checklist and GitHub issues in the goal, for you to read and
change before you start.

## Running it by hand

```
jbang Sessions.java                          # lists the sessions (the desk's dry run)
echo '{"session":"s1793749520389","name":"New name"}' | jbang Sessions.java --action=rename
```

It needs runner 0.46.0 or later (slots, plain replies and goals) and a desk that knows `elf.removeSlot`.
