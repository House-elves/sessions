///usr/bin/env jbang "$0" "$@" ; exit $?
//JAVA 21+
//DEPS info.picocli:picocli:4.7.6
//DEPS com.fasterxml.jackson.core:jackson-databind:2.17.2
//SOURCES Config.java

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * sessions: named chat sessions with a coding agent, for its tab on Elf Desk. Each session is a file in
 * ~/.config/sessions/sessions/, and each message you send is one agent the runner starts in its sandbox, in a clone
 * of the session's repo kept for that session alone (checkout slot), resuming the session's agent so it keeps its
 * context. The session's first message (its goal) goes with every turn. Without --action it lists the sessions.
 */
@Command(name = "sessions", mixinStandardHelpOptions = true, version = "0.5.0", description = "Coding-agent sessions for Elf Desk")
public class Sessions implements Callable<Integer> {

    static final ObjectMapper JSON = new ObjectMapper();
    static final Path SESSIONS = Config.DIR.resolve("sessions");
    static final Path AGENTS = Config.DIR.resolve("agents");
    /** Outside the data folders the tab reads: one action at a time changes the sessions. */
    static final Path LOCK = Config.DIR.resolve("sessions.lock");
    static final Pattern ID = Pattern.compile("s[0-9]{10,16}");
    static final Pattern TURN = Pattern.compile("(s[0-9]{10,16})-t([0-9]{1,5})");
    static final Pattern REPO = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}");
    static final Pattern LINK = Pattern.compile("[a-z0-9][a-z0-9-]{0,40}:[A-Za-z0-9._-]{1,80}");
    /** Turns a session keeps; the oldest go first (the agent still remembers them). */
    static final int MAX_TURNS = 500;
    static final int MAX_TEXT = 20_000;
    static final int MAX_REPLY = 200_000;
    static final int MAX_FILE = 1_200_000;

    @Option(names = "--action", paramLabel = "NAME", description = "For its tab: create, send, agent-done, rename, archive, tag, edit-goal, link, unlink, delete (values as JSON on stdin)")
    String action;

    @Override
    public Integer call() throws Exception {
        Config config;
        try {
            config = Config.load();
        } catch (IllegalStateException e) {
            System.err.println(e.getMessage());
            return 1;
        }
        if (action != null) return action(config);
        return list();
    }

    // ---- the dry run ----

    int list() throws IOException {
        List<ObjectNode> all = all();
        if (all.isEmpty()) System.out.println("No sessions yet. Start one on its tab on the desk.");
        for (ObjectNode s : all) {
            JsonNode last = s.path("turns").path(s.path("turns").size() - 1);
            System.out.println("- " + s.path("name").asText() + " (" + s.path("repo").asText() + "), "
                    + s.path("turns").size() + " turns" + (last.path("status").asText().equals("running") ? ", working" : "")
                    + (s.path("archived").asBoolean() ? ", archived" : "")
                    + (s.path("tags").isEmpty() ? "" : ", tagged " + String.join(", ", JSON.convertValue(s.path("tags"), String[].class))));
        }
        return 0;
    }

    // ---- the tab's actions ----

    int action(Config config) {
        try {
            JsonNode in = JSON.readTree(System.in);
            // Asking GitHub can take a while: done before taking the lock, so it never holds up the other actions.
            if (action.equals("create")) {
                String repo = in.path("repo").asText("").strip();
                if (!REPO.matcher(repo).matches()) throw new IllegalArgumentException("Pick a repo, like owner/name");
                checkRepo(config, repo);
            }
            try (FileChannel ch = lockFile(); FileLock lock = ch.lock()) {
                return act(config, in);
            }
        } catch (IllegalArgumentException | IllegalStateException e) {
            System.err.println(e.getMessage());
            return 1;
        } catch (Exception e) {
            System.err.println("Couldn't do it: " + e.getMessage());
            return 1;
        }
    }

    int act(Config config, JsonNode in) throws Exception {
        {
            JsonNode answer = switch (action) {
                case "create" -> create(config, in);
                case "new-options" -> newOptions(config);
                case "link-context" -> linkContext(in);
                case "send" -> send(in);
                case "agent-done" -> agentDone(in);
                case "rename" -> rename(in);
                case "archive" -> archive(in);
                case "tag" -> tag(config, in);
                case "edit-goal" -> editGoal(in);
                case "link" -> link(in);
                case "unlink" -> unlink(in);
                case "delete" -> delete(in);
                default -> throw new IllegalArgumentException("Not an action: " + action);
            };
            // The last line printed is the action's answer to the tab (or, with "agent", to the runner first).
            System.out.println(answer);
            return 0;
        }
    }

    static FileChannel lockFile() throws IOException {
        Files.createDirectories(Config.DIR);
        return FileChannel.open(LOCK, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
    }

    /**
     * create: a new session on a repo, with its first message, which is also its goal. Answers with the session and
     * the agent for its first turn, which the runner starts.
     */
    static JsonNode create(Config config, JsonNode in) throws Exception {
        String id = in.path("id").asText("");
        if (id.isEmpty()) id = "s" + System.currentTimeMillis();
        if (!ID.matcher(id).matches()) throw new IllegalArgumentException("Not a session");
        if (Files.exists(file(id))) throw new IllegalArgumentException("That session is there already");
        String name = oneLine(in.path("name").asText(""), 80);
        String repo = in.path("repo").asText("").strip();
        String prompt = in.path("prompt").asText("").strip();
        if (name.isEmpty()) throw new IllegalArgumentException("Give the session a name");
        if (!REPO.matcher(repo).matches()) throw new IllegalArgumentException("Pick a repo, like owner/name");
        if (prompt.isEmpty() || prompt.length() > MAX_TEXT) throw new IllegalArgumentException("Say what the session is for");
        String agent = in.path("agent").asText(config.codingAgent);
        if (!SESSION_AGENTS.contains(agent)) throw new IllegalArgumentException("A session's agent is Claude Code or IBM Bob");
        ObjectNode s = JSON.createObjectNode().put("id", id).put("name", name).put("repo", repo).put("agent", agent)
                .put("prompt", prompt).put("created", Instant.now().toString()).put("archived", false);
        setLink(s, in);
        setTags(config, s, in);
        s.putArray("turns");
        return turn(s, prompt);
    }

    /**
     * repos: repos to suggest for a new session, most used first: those on the GitHub elf's board (its own saved
     * board.json, only read, as its README allows), then those of your sessions. Empty without either.
     */
    /**
     * The coding agents, for a new session: which are installed here and which can run a session (Claude Code and IBM
     * Bob; Codex and pi only answer elves' questions so far), with the one in the settings first.
     */
    static final List<String[]> CODING_AGENTS = List.of(new String[] {"claude", "Claude Code", "claude"},
            new String[] {"bob", "IBM Bob", "bob"}, new String[] {"codex", "Codex", "codex"}, new String[] {"pi", "pi", "pi"});
    static final List<String> SESSION_AGENTS = List.of("claude", "bob");

    static JsonNode newOptions(Config config) throws Exception {
        ObjectNode out = (ObjectNode) repos();
        out.put("agent", config.codingAgent);
        ArrayNode agents = out.putArray("agents");
        for (String[] a : CODING_AGENTS) {
            agents.addObject().put("id", a[0]).put("label", a[1]).put("installed", onPath(a[2]))
                    .put("sessions", SESSION_AGENTS.contains(a[0]));
        }
        return out;
    }

    /** The program is on the PATH this elf runs with (the runner's). */
    static boolean onPath(String program) {
        for (String dir : System.getenv().getOrDefault("PATH", "").split(java.io.File.pathSeparator)) {
            if (!dir.isEmpty() && Files.isExecutable(Path.of(dir, program))) return true;
        }
        return false;
    }

    static JsonNode repos() throws IOException {
        java.util.Map<String, Integer> seen = new java.util.LinkedHashMap<>();
        Path board = Path.of(System.getProperty("user.home"), ".config", "github", "board", "board.json");
        if (Files.isRegularFile(board) && Files.size(board) < 20_000_000) {
            try {
                JsonNode b = JSON.readTree(board.toFile());
                for (JsonNode lane : b.path("lanes")) for (JsonNode i : lane.path("items")) count(seen, i.path("repo").asText(""));
                for (JsonNode i : b.path("hidden")) count(seen, i.path("repo").asText(""));
                b.path("threads").fieldNames().forEachRemaining(k -> count(seen, k.replaceFirst("#\\d+$", "")));
            } catch (IOException e) {
                // Half written, or not what it was: suggest what else there is.
            }
        }
        for (ObjectNode s : all()) count(seen, s.path("repo").asText(""));
        ObjectNode out = JSON.createObjectNode();
        ArrayNode list = out.putArray("repos");
        seen.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(300).forEach(e -> list.add(e.getKey()));
        return out;
    }

    static void count(java.util.Map<String, Integer> seen, String repo) {
        if (REPO.matcher(repo).matches()) seen.merge(repo, 1, Integer::sum);
    }

    /**
     * link-context: what a session started from another elf's item is about, as the goal you start from. For now the
     * Todo list's todos (todo-list:<todo> or todo-list:<todo>.<step>): read from its saved list, which it only reads
     * (its README says so), and only for the one todo. {title, prompt}, or {} when it isn't there.
     */
    static JsonNode linkContext(JsonNode in) throws IOException {
        ObjectNode out = JSON.createObjectNode();
        Matcher m = Pattern.compile("todo-list:(t[0-9]{10,16})(?:\\.(c[0-9]{10,16}))?").matcher(in.path("link").asText(""));
        if (!m.matches()) return out;
        Path list = Path.of(System.getProperty("user.home"), ".config", "todo-list", "todos", "todos.json");
        if (!Files.isRegularFile(list) || Files.size(list) > 20_000_000) return out;
        JsonNode todo = null;
        for (JsonNode t : JSON.readTree(list.toFile()).path("todos")) if (t.path("id").asText().equals(m.group(1))) todo = t;
        if (todo == null) return out;
        JsonNode step = null;
        if (m.group(2) != null) for (JsonNode i : todo.path("checklist")) if (i.path("id").asText().equals(m.group(2))) step = i;
        String what = oneLine(todo.path("what").asText(""), 300);
        StringBuilder p = new StringBuilder();
        if (step != null) {
            p.append(oneLine(step.path("text").asText(""), 300)).append("\n\nThis is one step of the todo \"").append(what).append("\".");
        } else {
            p.append(what);
        }
        String who = oneLine(todo.path("who").asText(""), 100), due = todo.path("due").asText("");
        if (!who.isEmpty() || !due.isEmpty()) {
            p.append("\n\n").append(!who.isEmpty() ? "Asked by " + who + "." : "").append(!who.isEmpty() && !due.isEmpty() ? " " : "")
                    .append(!due.isEmpty() ? "Due " + due + "." : "");
        }
        String description = todo.path("description").asText("").strip();
        if (!description.isEmpty()) p.append("\n\n").append(description);
        if (!todo.path("checklist").isEmpty()) {
            p.append("\n\nIts checklist:");
            for (JsonNode i : todo.path("checklist")) {
                p.append("\n- [").append(i.path("done").asBoolean() ? "x" : " ").append("] ").append(oneLine(i.path("text").asText(""), 300))
                        .append(step != null && i.path("id").asText().equals(step.path("id").asText()) ? " (this step)" : "");
            }
        }
        List<String> issues = new ArrayList<>();
        for (JsonNode i : todo.path("issues")) {
            String repo = i.path("repo").asText("");
            if (REPO.matcher(repo).matches() && i.path("number").asInt() > 0) {
                issues.add(repo + "#" + i.path("number").asInt() + (i.path("state").asText("").equals("closed") ? " (closed)" : ""));
            }
        }
        if (!issues.isEmpty()) p.append("\n\nIts GitHub issues: ").append(String.join(", ", issues)).append(".");
        out.put("title", oneLine(step != null ? step.path("text").asText("") : what, 80));
        out.put("prompt", clip(p.toString(), MAX_TEXT));
        return out;
    }

    /** send: your next message in a session, as its next turn. */
    static JsonNode send(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String text = in.path("text").asText("").strip();
        if (text.isEmpty() || text.length() > MAX_TEXT) throw new IllegalArgumentException("Write a message");
        return turn(s, text);
    }

    /**
     * A new turn: saved as running, and answered with the agent the runner starts for it. It works in the session's
     * own clone (slot), resumes the agent's session from the last turn that finished, answers in plain text (no
     * schema) and is given the session's goal again, so a long session doesn't lose it.
     */
    static JsonNode turn(ObjectNode s, String text) throws IOException {
        // An older runner doesn't know agent, and would quietly run Claude Code instead: refused before anything is saved.
        boolean bob = s.path("agent").asText("claude").equals("bob");
        if (bob && !runnerAtLeast(0, 47)) throw new IllegalStateException("IBM Bob sessions need runner 0.47.0 or later: update the desk");
        harvest(s);
        ArrayNode turns = (ArrayNode) s.path("turns");
        for (JsonNode t : turns) {
            if (t.path("status").asText().equals("running")) throw new IllegalStateException("It's still working on your last message");
        }
        int n = turns.isEmpty() ? 1 : turns.get(turns.size() - 1).path("n").asInt() + 1;
        String agentId = s.path("id").asText() + "-t" + n;
        turns.addObject().put("n", n).put("you", text).put("at", Instant.now().toString()).put("agent", agentId)
                .put("status", "running");
        while (turns.size() > MAX_TURNS) turns.remove(0);
        save(s);

        ObjectNode agent = JSON.createObjectNode().put("id", agentId);
        agent.putObject("checkout").put("repo", s.path("repo").asText()).put("number", 0).put("kind", "REPO")
                .put("slot", s.path("id").asText());
        agent.put("prompt", text);
        // The session keeps the agent it started with: neither can resume the other's.
        if (bob) agent.put("agent", "bob");
        if (n > 1) agent.put("goal", goal(s));
        String session = s.path("session").asText("");
        if (!session.isEmpty()) agent.put("session", session);
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText());
        out.set("agent", agent);
        return out;
    }

    /** The runner that started this action is at least major.minor (it says in ELF_RUNNER_VERSION); run by hand, yes. */
    static boolean runnerAtLeast(int major, int minor) {
        String v = System.getenv("ELF_RUNNER_VERSION");
        if (v == null || v.isBlank()) return true;
        Matcher m = Pattern.compile("(\\d+)\\.(\\d+)").matcher(v);
        if (!m.find()) return false;
        int a = Integer.parseInt(m.group(1)), b = Integer.parseInt(m.group(2));
        return a > major || (a == major && b >= minor);
    }

    /** What the agent is given each turn: the goal as you last edited it, or the first message. */
    static String goal(JsonNode s) {
        String g = s.path("goal").asText("");
        return g.isBlank() ? s.path("prompt").asText("") : g;
    }

    /** agent-done: the runner says a turn's agent ended; its reply (or why it didn't answer) goes on the session. */
    static JsonNode agentDone(JsonNode in) throws Exception {
        Matcher m = TURN.matcher(in.path("id").asText(""));
        if (!m.matches()) throw new IllegalArgumentException("Not a turn");
        if (!Files.exists(file(m.group(1)))) return JSON.createObjectNode().put("gone", true); // deleted meanwhile
        ObjectNode s = load(m.group(1));
        harvest(s);
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /**
     * Turns still running whose agent has ended: its reply and session, or what went wrong, copied onto the turn. The
     * agent's report stays in agents/ for its lines (what it did on the way).
     */
    static void harvest(ObjectNode s) {
        for (JsonNode t : s.path("turns")) {
            if (!t.path("status").asText().equals("running")) continue;
            Path f = AGENTS.resolve(t.path("agent").asText() + ".json");
            try {
                if (!Files.exists(f)) {
                    // The runner writes the report as it takes the agent: none after a few minutes means it refused it
                    // (an older runner, say), so the session isn't stuck "working" for ever.
                    if (Instant.parse(t.path("at").asText(Instant.now().toString())).isBefore(Instant.now().minusSeconds(180))) {
                        ((ObjectNode) t).put("status", "failed").put("error", "The runner didn't start it. Sessions needs runner 0.46.0 or later.")
                                .put("finished", Instant.now().toString());
                    }
                    continue;
                }
                JsonNode a = JSON.readTree(f.toFile());
                ObjectNode turn = (ObjectNode) t;
                String status = a.path("status").asText("");
                switch (status) {
                    case "done" -> {
                        turn.put("status", "done").put("reply", clip(a.path("output").path("reply").asText(""), MAX_REPLY));
                        String session = a.path("session").asText("");
                        if (session.matches("[A-Za-z0-9-]{1,100}")) s.put("session", session);
                    }
                    case "failed" -> turn.put("status", "failed").put("error", clip(a.path("error").asText("It failed"), 2000));
                    case "cancelled" -> turn.put("status", "stopped");
                    default -> {
                        continue; // queued or running
                    }
                }
                if (a.path("cost").isNumber()) turn.put("cost", a.path("cost").asDouble());
                // Bob says what its task has cost so far: the turn's own is what it added.
                if (a.path("bobcoins").isNumber()) {
                    double total = a.path("bobcoins").asDouble();
                    turn.put("bobcoins", Math.max(0, total - s.path("bobcoinsTotal").asDouble(0)));
                    s.put("bobcoinsTotal", total);
                }
                // The model it ran as, how long it took, and how full its context is now (runner 0.49.0).
                if (a.path("model").isTextual()) {
                    turn.put("model", oneLine(a.path("model").asText(), 80));
                    s.put("model", turn.path("model").asText());
                }
                if (a.path("durationMs").isNumber()) turn.put("durationMs", a.path("durationMs").asLong());
                if (a.path("context").path("window").asLong() > 0) {
                    turn.put("contextUsed", a.path("context").path("used").asLong()).put("contextWindow", a.path("context").path("window").asLong());
                }
                turn.put("finished", a.path("finished").asText(Instant.now().toString()));
            } catch (IOException e) {
                // Read again next time: it may be half way through being written.
            }
        }
    }

    static JsonNode rename(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String name = oneLine(in.path("name").asText(""), 80);
        if (name.isEmpty()) throw new IllegalArgumentException("Give the session a name");
        s.put("name", name);
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    static JsonNode archive(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        s.put("archived", in.path("archived").asBoolean());
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /** edit-goal: what the agent is given each turn from now on. The first message stays as it was sent. */
    /** tag: the session's tags, some of those in its settings (none clears them). */
    static JsonNode tag(Config config, JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        setTags(config, s, in);
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /**
     * Tags from the tab, each one of the settings' TAGS (as spelled there, whatever the case it came in). A tag since
     * taken out of the settings stays on the sessions that have it until you change their tags.
     */
    static void setTags(Config config, ObjectNode s, JsonNode in) {
        String given = in.path("tags").asText("");
        ArrayNode tags = s.putArray("tags");
        for (String t : given.split(",")) {
            String want = t.strip();
            if (want.isEmpty()) continue;
            String known = config.tags.stream().filter(k -> k.equalsIgnoreCase(want)).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("\"" + oneLine(want, 30) + "\" isn't one of the tags in Sessions' settings"));
            boolean had = false;
            for (JsonNode x : tags) had |= x.asText().equals(known);
            if (!had && tags.size() < 10) tags.add(known);
        }
    }

    static JsonNode editGoal(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String goal = in.path("goal").asText("").strip();
        if (goal.isEmpty() || goal.length() > MAX_TEXT) throw new IllegalArgumentException("Say what the session is for");
        if (goal.equals(s.path("prompt").asText())) s.remove(List.of("goal", "goalEdited"));
        else s.put("goal", goal).put("goalEdited", Instant.now().toString());
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /** link: a pointer to another elf's item (a todo: todo-list:t123), with its title as it was then. */
    static JsonNode link(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        setLink(s, in);
        if (!s.has("link")) throw new IllegalArgumentException("Not a link");
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    static JsonNode unlink(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        s.remove("link");
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    static void setLink(ObjectNode s, JsonNode in) {
        String link = in.path("link").asText("");
        if (link.isEmpty()) return;
        if (!LINK.matcher(link).matches()) throw new IllegalArgumentException("Not a link");
        int colon = link.indexOf(':');
        s.putObject("link").put("elf", link.substring(0, colon)).put("ref", link.substring(colon + 1))
                .put("title", oneLine(in.path("linkTitle").asText(""), 300));
    }

    /**
     * delete: the session's file and its agents' reports. Its clone is the runner's: the tab has it removed first
     * (elf.removeSlot), which the runner refuses while the agent works there.
     */
    static JsonNode delete(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        harvest(s);
        for (JsonNode t : s.path("turns")) {
            if (t.path("status").asText().equals("running")) throw new IllegalStateException("Stop it first: it's still working");
        }
        String id = s.path("id").asText();
        if (Files.isDirectory(AGENTS)) {
            try (var files = Files.list(AGENTS)) {
                for (Path f : files.toList()) {
                    String n = f.getFileName().toString();
                    if (n.startsWith(id + "-t")) Files.deleteIfExists(f);
                }
            }
        }
        Files.deleteIfExists(file(id));
        return JSON.createObjectNode().put("deleted", id);
    }

    // ---- GitHub ----

    /** Your gh account can see the repo (so the runner can clone it); skipped without an account in the settings. */
    static void checkRepo(Config config, String repo) throws Exception {
        if (config.githubLogin.isEmpty()) return;
        String token = run(List.of("gh", "auth", "token", "-u", config.githubLogin), null);
        if (token == null || token.isBlank() || token.contains(" ")) {
            throw new IllegalStateException("Log gh in as " + config.githubLogin + " (gh auth login), or change the account in Sessions' settings");
        }
        String seen = run(List.of("gh", "api", "repos/" + repo, "--jq", ".full_name"), token);
        if (seen == null || !seen.strip().equalsIgnoreCase(repo)) {
            throw new IllegalArgumentException("Your GitHub account can't see " + repo);
        }
    }

    /** A command's output, or null when it failed. With a token, as GH_TOKEN for that command only. */
    static String run(List<String> cmd, String token) throws Exception {
        // Output to a file, so the time limit holds even if it never closes its output.
        Path out = Files.createTempFile("sessions-", ".out");
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.DISCARD).redirectOutput(out.toFile());
            if (token != null) pb.environment().put("GH_TOKEN", token);
            Process p = pb.start();
            if (!p.waitFor(60, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return null;
            }
            return p.exitValue() == 0 ? Files.readString(out, StandardCharsets.UTF_8).strip() : null;
        } finally {
            Files.deleteIfExists(out);
        }
    }

    // ---- files ----

    static Path file(String id) {
        if (!ID.matcher(id).matches()) throw new IllegalArgumentException("Not a session");
        return SESSIONS.resolve(id + ".json");
    }

    static ObjectNode load(String id) throws IOException {
        Path f = file(id);
        if (!Files.exists(f)) throw new IllegalArgumentException("That session isn't there any more");
        return (ObjectNode) JSON.readTree(f.toFile());
    }

    static List<ObjectNode> all() throws IOException {
        List<ObjectNode> out = new ArrayList<>();
        if (!Files.isDirectory(SESSIONS)) return out;
        try (var files = Files.list(SESSIONS)) {
            for (Path f : files.filter(x -> x.getFileName().toString().matches("s[0-9]{10,16}\\.json")).sorted().toList()) {
                out.add((ObjectNode) JSON.readTree(f.toFile()));
            }
        }
        return out;
    }

    /** Written whole or not at all: the tab may read it at any moment. */
    static void save(ObjectNode s) throws IOException {
        Path file = file(s.path("id").asText());
        Files.createDirectories(file.getParent());
        s.put("updated", Instant.now().toString());
        // Small enough for the tab to read (the desk reads 1.5 MB at a time): the oldest turns go first. The agent still
        // remembers them.
        ArrayNode turns = (ArrayNode) s.withArray("turns");
        while (turns.size() > 1 && s.toString().length() > MAX_FILE) turns.remove(0);
        Path tmp = file.resolveSibling(file.getFileName() + ".new");
        Files.writeString(tmp, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(s));
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    static String oneLine(String s, int max) {
        return clip(s.replaceAll("\\p{Cntrl}+", " ").strip(), max);
    }

    static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    public static void main(String[] args) {
        System.exit(new CommandLine(new Sessions()).execute(args));
    }
}
