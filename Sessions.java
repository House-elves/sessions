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
@Command(name = "sessions", mixinStandardHelpOptions = true, version = "0.7.1", description = "Coding-agent sessions for Elf Desk")
public class Sessions implements Callable<Integer> {

    static final ObjectMapper JSON = new ObjectMapper();
    static final Path SESSIONS = Config.DIR.resolve("sessions");
    static final Path AGENTS = Config.DIR.resolve("agents");
    /** Files attached to messages: <session>-<id>.<ext>, with <session>-<id>.meta.json ({name, kind}). */
    static final Path ATTACHMENTS = Config.DIR.resolve("attachments");
    static final Pattern FILE_ID = Pattern.compile("[0-9a-f]{16}");
    /** An image as the runner shows it to Claude: at most 3.75 MB, so about 5 MB as a data URL. */
    static final int MAX_IMAGE_CHARS = 5_100_000;
    static final int MAX_IMAGES = 4;
    /** A text file goes into the message: at most this much each, and all of a message's together. */
    static final int MAX_DOC_CHARS = 100_000, MAX_DOCS_CHARS = 150_000;
    static final int MAX_FILES = 10;
    static final int MAX_QUEUED = 5;
    /** A PDF (shown to Claude whole) or a Word file (read as text): at most this big, so about 4 MB as a data URL. */
    static final int MAX_DOCUMENT_BYTES = 3_000_000;
    /** Any other file you attach goes into the session's clone (.attached/), up to this big. */
    static final long MAX_ATTACH_BYTES = 50L * 1024 * 1024;
    static final String DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
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
                case "link-context" -> in.path("link").asText("").startsWith("mvnpm-dependabot:") ? mvnpmContext(config, in) : linkContext(in);
                case "send" -> send(in);
                case "agent-done" -> agentDone(in);
                case "unqueue" -> unqueue(in);
                case "say" -> say(in);
                case "said" -> said(in);
                case "push-preview" -> pushPreview(config, in);
                case "push" -> push(config, in, false);
                case "push-pr" -> push(config, in, true);
                case "vars" -> vars();
                case "var-set" -> varSet(in);
                case "var-remove" -> varRemove(in);
                case "gh-look" -> ghLook(config, in);
                case "gh-close" -> ghDo(config, in, "close");
                case "gh-comment" -> ghDo(config, in, "comment");
                case "gh-merge" -> ghDo(config, in, "merge");
                case "push-done" -> pushDone(config, in);
                case "push-new" -> pushNew(config, in);
                case "repo-owners" -> repoOwners(config);
                case "repo-create" -> repoCreate(config, in);
                case "attach" -> attach(in);
                case "rename" -> rename(in);
                case "archive" -> archive(in);
                case "tag" -> tag(config, in);
                case "edit-goal" -> editGoal(in);
                case "link" -> link(in);
                case "unlink" -> unlink(in);
                case "delete" -> delete(in);
                case "context-clear" -> contextClear(in);
                case "context-compact" -> contextCompact(in);
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
        return turn(s, prompt, in.path("files").asText(""));
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

    /**
     * link-context for a bump in the mvnpm elf (mvnpm-dependabot:owner.repo.pr), from its tab's Let an agent do it:
     * the bump as its board has it (which it only reads), Dependabot's change and the elf's check comment from GitHub,
     * as a goal where the agent makes the same bump itself and fixes what it needs. {title, prompt, repo}, or {}.
     */
    static JsonNode mvnpmContext(Config config, JsonNode in) throws Exception {
        ObjectNode out = JSON.createObjectNode();
        Matcher m = Pattern.compile("mvnpm-dependabot:([A-Za-z0-9-]+)\\.([A-Za-z0-9._-]+)\\.([0-9]{1,7})").matcher(in.path("link").asText(""));
        if (!m.matches()) return out;
        String repo = m.group(1) + "/" + m.group(2);
        int number = Integer.parseInt(m.group(3));
        Path board = Path.of(System.getProperty("user.home"), ".config", "mvnpm-dependabot", "board", "board.json");
        if (!Files.isRegularFile(board) || Files.size(board) > 20_000_000) return out;
        JsonNode row = null;
        for (JsonNode r : JSON.readTree(board.toFile()).path("rows")) {
            if (r.path("pr").path("repo").asText().equalsIgnoreCase(repo) && r.path("pr").path("number").asInt() == number) row = r;
        }
        if (row == null || !REPO.matcher(repo).matches()) return out;
        JsonNode pr = row.path("pr"), bump = row.path("bump");
        String artifact = oneLine(bump.path("groupId").asText("") + ":" + bump.path("artifactId").asText(""), 200);
        String from = oneLine(bump.path("from").asText(""), 40), to = oneLine(bump.path("to").asText(""), 40);
        String title = oneLine(pr.path("title").asText(""), 200);
        String url = "https://github.com/" + repo + "/pull/" + number;

        // From GitHub, as your gh account: what Dependabot changed, and what the elf's check said. Left out if it can't.
        String token = null;
        try {
            token = token(config);
        } catch (Exception e) {
            // Without gh the goal still says where to look.
        }
        String files = null, said = null;
        if (token != null) {
            try {
                files = run(List.of("gh", "api", "repos/" + repo + "/pulls/" + number + "/files?per_page=50", "--jq",
                        ".[] | \"--- \" + .filename + \"\\n\" + (.patch // \"(no diff shown)\")"), token);
            } catch (Exception e) {
                files = null;
            }
            Matcher c = Pattern.compile("#issuecomment-([0-9]{1,15})$").matcher(row.path("check").path("comment").asText(""));
            if (c.find()) {
                try {
                    said = run(List.of("gh", "api", "repos/" + repo + "/issues/comments/" + c.group(1), "--jq", ".body"), token);
                } catch (Exception e) {
                    said = null;
                }
            }
        }
        StringBuilder p = new StringBuilder();
        p.append("Bump ").append(artifact).append(" from ").append(from).append(" to ").append(to).append(" in ").append(repo)
                .append(", the bump Dependabot made in ").append(repo).append("#").append(number).append(" (").append(url)
                .append("), but this time make it work: I'll push yours as my own PR and close Dependabot's.");
        String verdict = row.path("check").path("verdict").asText("");
        if (!verdict.isEmpty() || "FAILURE".equals(pr.path("ci").asText())) {
            p.append("\n\nDependabot's PR isn't good as it is:")
                    .append(verdict.isEmpty() ? "" : " the mvnpm elf's check says " + switch (verdict) {
                        case "NEEDS_HUMAN" -> "it needs a human to look";
                        case "NOT_SAFE" -> "it isn't safe";
                        default -> verdict.toLowerCase(java.util.Locale.ROOT);
                    } + ".")
                    .append("FAILURE".equals(pr.path("ci").asText()) ? " Its CI is failing." : "");
        }
        if (said != null && !said.isBlank()) p.append("\n\nThe mvnpm elf's check, as it commented on that PR:\n\n").append(clip(said.strip(), 8000));
        if (files != null && !files.isBlank()) p.append("\n\nDependabot's change:\n\n```diff\n").append(clip(files.strip(), 8000)).append("\n```");
        p.append("\n\nWhat to do:\n")
                .append("1. On a branch from the default branch, make the same version change (git fetch origin pull/").append(number)
                .append("/head shows Dependabot's).\n")
                .append("2. Fix what the new version needs: code and resources that use it, and any lock files that pin its npm or mvnpm ")
                .append("dependencies (the mvnpm locker's files, an import map, a package-lock), so the build gets ").append(to)
                .append(" and its dependencies.\n")
                .append("3. Build the modules that use it and run their tests, the UI tests too (those that open the page in a browser, ")
                .append("like the Dev UI or web UI tests), and look at the page yourself if you can. Say what you ran and what passed.\n")
                .append("4. Leave it as one commit, with a message like \"").append(title.isEmpty() ? "Bump " + artifact + " from " + from + " to " + to : title)
                .append("\". Don't comment on or close Dependabot's PR: I close it once yours is pushed.");
        out.put("title", oneLine(bump.path("artifactId").asText(artifact) + " " + to, 80));
        out.put("prompt", clip(p.toString(), MAX_TEXT));
        out.put("repo", repo);
        return out;
    }

    /**
     * attach: a file pasted or picked for a message, in parts (the desk takes up to 64 KB at a time from the tab): the
     * first part starts it and answers its id, each part adds to it, and the one marked done checks it and keeps it.
     * An image (a data URL) must really be a PNG, JPEG, GIF or WebP; a text file must be text. A new session's first
     * message keeps its files under "new" until create moves them to the session.
     */
    static JsonNode attach(JsonNode in) throws IOException {
        String session = in.path("session").asText("");
        if (!session.equals("new")) load(session); // it must be there
        String kind = in.path("kind").asText("");
        if (!List.of("image", "text", "pdf", "docx", "file").contains(kind)) throw new IllegalArgumentException("A file is an image, text, a PDF, a Word file or another file");
        Files.createDirectories(ATTACHMENTS);
        String id = in.path("file").asText("");
        if (id.isEmpty()) {
            // Ones left from a message never sent go after a day.
            java.time.Instant old = Instant.now().minus(java.time.Duration.ofDays(1));
            try (var files = Files.list(ATTACHMENTS)) {
                for (Path f : files.toList()) {
                    String n = f.getFileName().toString();
                    if ((n.endsWith(".part") || n.startsWith("new-")) && Files.getLastModifiedTime(f).toInstant().isBefore(old)) Files.deleteIfExists(f);
                }
            }
            id = "%016x".formatted(new java.security.SecureRandom().nextLong());
            write(ATTACHMENTS.resolve(session + "-" + id + ".meta.json"),
                    JSON.createObjectNode().put("name", oneLine(in.path("name").asText("file"), 120)).put("kind", kind));
        } else if (!FILE_ID.matcher(id).matches() || !Files.isRegularFile(ATTACHMENTS.resolve(session + "-" + id + ".part"))) {
            throw new IllegalStateException("That file is gone: attach it again");
        }
        Path part = ATTACHMENTS.resolve(session + "-" + id + ".part");
        String data = in.path("data").asText("");
        long max = kind.equals("image") ? MAX_IMAGE_CHARS : kind.equals("text") ? MAX_DOC_CHARS * 4L
                : kind.equals("file") ? MAX_ATTACH_BYTES / 3L * 4 + 400 : MAX_DOCUMENT_BYTES / 3L * 4 + 200;
        if ((Files.exists(part) ? Files.size(part) : 0) + data.length() > max) {
            Files.deleteIfExists(part);
            throw new IllegalArgumentException(kind.equals("image") ? "That image is too big" : "That file is too long to put in a message");
        }
        Files.writeString(part, data, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        if (!in.path("done").asBoolean(false)) return JSON.createObjectNode().put("id", id);
        String all = Files.readString(part, StandardCharsets.UTF_8);
        Files.deleteIfExists(part);
        Path meta = ATTACHMENTS.resolve(session + "-" + id + ".meta.json");
        ObjectNode m = (ObjectNode) JSON.readTree(meta.toFile());
        if (kind.equals("file")) {
            // Any other file (a slide deck): the agent finds it in its clone, in .attached/ (the runner copies it there).
            byte[] bytes = dataUrl(all, "application/octet-stream");
            if (bytes.length > MAX_ATTACH_BYTES) throw new IllegalArgumentException("That file is bigger than 50 MB");
            String file = session + "-" + id + ".bin";
            Files.write(ATTACHMENTS.resolve(file), bytes);
            m.put("file", file).put("type", "application/octet-stream").put("size", bytes.length);
        } else if (kind.equals("pdf")) {
            byte[] bytes = dataUrl(all, "application/pdf");
            if (!starts(bytes, 0, '%', 'P', 'D', 'F', '-') || bytes.length > MAX_DOCUMENT_BYTES) throw new IllegalArgumentException("That isn't a PDF of at most 3 MB");
            String file = session + "-" + id + ".pdf";
            Files.write(ATTACHMENTS.resolve(file), bytes);
            m.put("file", file).put("type", "application/pdf");
        } else if (kind.equals("docx")) {
            // Claude has no Word reader: its text goes into the message, as a text file's does.
            byte[] bytes = dataUrl(all, DOCX);
            if (bytes.length > MAX_DOCUMENT_BYTES) throw new IllegalArgumentException("That Word file is too big");
            String text = docxText(bytes);
            if (text.isBlank()) throw new IllegalArgumentException("There's no text in that Word file");
            if (text.length() > MAX_DOC_CHARS) throw new IllegalArgumentException("That Word file is too long to put in a message");
            String file = session + "-" + id + ".txt";
            Files.writeString(ATTACHMENTS.resolve(file), text, StandardCharsets.UTF_8);
            m.put("kind", "text").put("from", "docx").put("file", file).put("type", "text/plain");
        } else if (kind.equals("image")) {
            Matcher d = Pattern.compile("data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)").matcher(all);
            if (!d.matches()) throw new IllegalArgumentException("That isn't a PNG, JPEG, GIF or WebP image");
            byte[] bytes = java.util.Base64.getDecoder().decode(d.group(2));
            if (!d.group(1).equals(imageType(bytes)) || bytes.length > 3_750_000) throw new IllegalArgumentException("That isn't a PNG, JPEG, GIF or WebP image of at most 3.75 MB");
            String file = session + "-" + id + "." + d.group(1).substring(6);
            Files.write(ATTACHMENTS.resolve(file), bytes);
            m.put("file", file).put("type", d.group(1));
        } else {
            if (all.length() > MAX_DOC_CHARS) throw new IllegalArgumentException("That file is too long to put in a message");
            if (all.chars().anyMatch(c -> c == 0)) throw new IllegalArgumentException("That isn't a text file");
            String file = session + "-" + id + ".txt";
            Files.writeString(ATTACHMENTS.resolve(file), all, StandardCharsets.UTF_8);
            m.put("file", file).put("type", "text/plain");
        }
        write(meta, m);
        return JSON.createObjectNode().put("id", id).put("kept", true).put("file", m.path("file").asText());
    }

    /** The bytes of a data URL of that type (what the tab read the file as). */
    static byte[] dataUrl(String url, String type) {
        String head = "data:" + type + ";base64,";
        if (!url.startsWith(head)) throw new IllegalArgumentException("That isn't the kind of file it says");
        try {
            return java.util.Base64.getDecoder().decode(url.substring(head.length()));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("That file didn't arrive whole: attach it again");
        }
    }

    /**
     * A Word (.docx) file's text: its paragraphs one per line, a table's rows as cells joined by " | ". It's a zip of XML:
     * only word/document.xml is read, at most 20 MB of it unpacked, and the XML may not declare a DOCTYPE (so it can't
     * pull in or expand anything).
     */
    static String docxText(byte[] bytes) throws IOException {
        byte[] xml = null;
        try (var zip = new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(bytes))) {
            for (var e = zip.getNextEntry(); e != null; e = zip.getNextEntry()) {
                if (!e.getName().equals("word/document.xml")) continue;
                xml = zip.readNBytes(20_000_001);
                if (xml.length > 20_000_000) throw new IllegalArgumentException("That Word file is too big");
                break;
            }
        } catch (java.util.zip.ZipException e) {
            throw new IllegalArgumentException("That isn't a Word (.docx) file");
        }
        if (xml == null) throw new IllegalArgumentException("That isn't a Word (.docx) file");
        org.w3c.dom.Document doc;
        try {
            var f = javax.xml.parsers.DocumentBuilderFactory.newInstance();
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setExpandEntityReferences(false);
            f.setNamespaceAware(true);
            var b = f.newDocumentBuilder();
            b.setErrorHandler(null);
            doc = b.parse(new java.io.ByteArrayInputStream(xml));
        } catch (Exception e) {
            throw new IllegalArgumentException("That Word file couldn't be read: " + e.getMessage());
        }
        StringBuilder out = new StringBuilder();
        var bodies = doc.getElementsByTagNameNS(W, "body");
        if (bodies.getLength() > 0) block((org.w3c.dom.Element) bodies.item(0), out);
        return out.toString().replaceAll("\\n{3,}", "\n\n").strip();
    }

    static final String W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    /** A body's (or a cell's) paragraphs and tables, in order. */
    static void block(org.w3c.dom.Element parent, StringBuilder out) {
        for (var n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (!(n instanceof org.w3c.dom.Element e) || !W.equals(e.getNamespaceURI())) continue;
            switch (e.getLocalName()) {
                case "p" -> out.append(paragraph(e)).append('\n');
                case "tbl" -> {
                    for (var r = e.getFirstChild(); r != null; r = r.getNextSibling()) {
                        if (!(r instanceof org.w3c.dom.Element row) || !"tr".equals(row.getLocalName())) continue;
                        List<String> cells = new ArrayList<>();
                        for (var c = row.getFirstChild(); c != null; c = c.getNextSibling()) {
                            if (!(c instanceof org.w3c.dom.Element cell) || !"tc".equals(cell.getLocalName())) continue;
                            StringBuilder t = new StringBuilder();
                            block(cell, t);
                            cells.add(t.toString().strip().replace('\n', ' '));
                        }
                        out.append(String.join(" | ", cells)).append('\n');
                    }
                    out.append('\n');
                }
                case "sdt", "sdtContent", "customXml", "ins", "smartTag" -> block(e, out);
                default -> { }
            }
        }
    }

    /** A paragraph's text: its runs' text, tabs and line breaks (deleted text left out). */
    static String paragraph(org.w3c.dom.Element p) {
        StringBuilder s = new StringBuilder();
        var all = p.getElementsByTagNameNS(W, "*");
        for (int i = 0; i < all.getLength(); i++) {
            var e = (org.w3c.dom.Element) all.item(i);
            switch (e.getLocalName()) {
                case "t" -> s.append(e.getTextContent());
                case "tab" -> s.append('\t');
                case "br", "cr" -> s.append('\n');
                default -> { }
            }
        }
        return s.toString();
    }

    /** What the bytes are, by how they start: image/png, image/jpeg, image/gif, image/webp, or null. */
    static String imageType(byte[] b) {
        if (starts(b, 0, 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A)) return "image/png";
        if (starts(b, 0, 0xFF, 0xD8, 0xFF)) return "image/jpeg";
        if (starts(b, 0, 'G', 'I', 'F', '8')) return "image/gif";
        if (starts(b, 0, 'R', 'I', 'F', 'F') && starts(b, 8, 'W', 'E', 'B', 'P')) return "image/webp";
        return null;
    }

    static boolean starts(byte[] b, int at, int... magic) {
        if (b.length < at + magic.length) return false;
        for (int k = 0; k < magic.length; k++) if ((b[at + k] & 0xFF) != magic[k]) return false;
        return true;
    }

    /**
     * The files a message lists (ids, comma-separated), kept for this session: their meta, with the file each is in.
     * A new session's first message finds them under "new" and they move to the session.
     */
    static List<ObjectNode> files(String session, String ids) throws IOException {
        List<ObjectNode> out = new ArrayList<>();
        if (ids.isBlank()) return out;
        List<String> list = List.of(ids.split(","));
        if (list.size() > MAX_FILES) throw new IllegalArgumentException("A message takes at most " + MAX_FILES + " files");
        for (String id : list) {
            if (!FILE_ID.matcher(id).matches()) throw new IllegalArgumentException("Not a file: " + id);
            Path meta = ATTACHMENTS.resolve(session + "-" + id + ".meta.json");
            if (!Files.isRegularFile(meta)) {
                // The first message of a session started just now: its files were kept before it had an id.
                Path waiting = ATTACHMENTS.resolve("new-" + id + ".meta.json");
                if (!Files.isRegularFile(waiting)) throw new IllegalStateException("A file you attached is gone: attach it again");
                ObjectNode m = (ObjectNode) JSON.readTree(waiting.toFile());
                String from = m.path("file").asText(""), to = from.replaceFirst("^new-", session + "-");
                if (!from.startsWith("new-" + id + ".")) throw new IllegalStateException("A file you attached isn't ready yet: attach it again");
                Files.move(ATTACHMENTS.resolve(from), ATTACHMENTS.resolve(to), StandardCopyOption.REPLACE_EXISTING);
                m.put("file", to);
                write(meta, m);
                Files.deleteIfExists(waiting);
            }
            ObjectNode m = (ObjectNode) JSON.readTree(meta.toFile());
            if (!m.path("file").asText("").startsWith(session + "-" + id + ".")) throw new IllegalStateException("A file you attached isn't ready yet: attach it again");
            out.add(m);
        }
        return out;
    }

    /** Written whole or not at all. */
    static void write(Path file, JsonNode n) throws IOException {
        Files.createDirectories(file.getParent());
        Path tmp = file.resolveSibling(file.getFileName() + ".new");
        Files.writeString(tmp, JSON.writeValueAsString(n));
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    /** send: your next message in a session, as its next turn. */
    /**
     * send: your message. While the agent works on the last one it's queued, as in Claude Code, and goes when that turn
     * ends (agent-done starts it, runner 0.51.0), with any others you queued, as one message. A queue left by a turn
     * you stopped or that failed goes with your next message (or alone, with no text).
     */
    static JsonNode send(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String text = in.path("text").asText("").strip();
        String files = in.path("files").asText("");
        boolean queued = !s.path("queued").isEmpty();
        if ((text.isEmpty() && files.isEmpty() && !queued) || text.length() > MAX_TEXT) throw new IllegalArgumentException("Write a message");
        harvest(s);
        if (running(s)) {
            if (text.isEmpty() && files.isEmpty()) throw new IllegalArgumentException("Write a message");
            if (!runnerAtLeast(0, 51)) throw new IllegalStateException("It's still working on your last message. Sending the next one while it works needs runner 0.51.0 or later: update the desk");
            ArrayNode q = s.withArray("queued");
            if (q.size() >= MAX_QUEUED) throw new IllegalStateException("You've queued " + MAX_QUEUED + " messages already: wait for it, or press esc to interrupt it");
            int count = files.isEmpty() ? 0 : files.split(",").length;
            for (JsonNode m : q) count += m.path("files").asText("").isEmpty() ? 0 : m.path("files").asText().split(",").length;
            if (count > MAX_FILES) throw new IllegalArgumentException("A message takes at most " + MAX_FILES + " files, with the ones you queued");
            files(s.path("id").asText(), files); // they must be there
            q.addObject().put("text", text).put("files", files).put("at", Instant.now().toString());
            save(s);
            return JSON.createObjectNode().put("session", s.path("id").asText()).put("queued", q.size());
        }
        return next(s, text, files);
    }

    /** The turn that sends what you queued (oldest first) and this message, as one; the queue goes once it's sent. */
    static JsonNode next(ObjectNode s, String text, String files) throws IOException {
        List<String> texts = new ArrayList<>(), ids = new ArrayList<>();
        for (JsonNode m : s.path("queued")) {
            if (!m.path("text").asText("").isBlank()) texts.add(m.path("text").asText());
            if (!m.path("files").asText("").isBlank()) ids.add(m.path("files").asText());
        }
        if (!text.isEmpty()) texts.add(text);
        if (!files.isEmpty()) ids.add(files);
        String all = String.join("\n\n", texts);
        if (all.length() > MAX_TEXT) throw new IllegalArgumentException("Your queued messages and this one are too long together: take one off");
        s.remove("queued");
        return turn(s, all, String.join(",", ids));
    }

    static boolean running(JsonNode s) {
        for (JsonNode t : s.path("turns")) {
            if (t.path("status").asText().equals("running")) return true;
        }
        return false;
    }

    // ---- push: the session's commits to a branch on GitHub, with a draft PR ----

    static final Pattern SHA = Pattern.compile("[0-9a-f]{40}");

    /**
     * The agent's work as the runner last reported it: its commits on the repo's default branch (one commit, the runner
     * squashes a repo's work), from the newest turn that finished with some.
     */
    static JsonNode work(ObjectNode s) throws IOException {
        JsonNode turns = s.path("turns");
        for (int k = turns.size() - 1; k >= 0; k--) {
            JsonNode t = turns.get(k);
            if (!t.path("status").asText().equals("done")) continue;
            Path f = AGENTS.resolve(t.path("agent").asText() + ".json");
            if (!Files.isRegularFile(f)) continue;
            JsonNode git = JSON.readTree(f.toFile()).path("git");
            if (git.path("error").isTextual()) {
                // Commits with no history in common with the repo (the agent started a new project in its clone): no
                // branch of the repo can take them as a PR.
                if (git.path("error").asText().contains("merge-base")) throw new IllegalStateException("The agent's commits don't "
                        + "share any history with " + s.path("repo").asText() + "'s default branch (it started afresh), so they "
                        + "can't go to a branch and PR there. They can go to a new repository: send the agent a short message (like \"ready to "
                        + "push\"), so the runner reports them again, then push and choose a new repository");
                throw new IllegalStateException(git.path("error").asText());
            }
            if (git.path("commits").isEmpty()) continue;
            if (!SHA.matcher(git.path("from").asText()).matches() || !SHA.matcher(git.path("to").asText()).matches()
                    || !BRANCH.matcher(git.path("base").asText("")).matches()) throw new IllegalStateException("The runner's report of its commits is incomplete");
            return git;
        }
        throw new IllegalStateException("There are no commits to push yet: ask the agent to commit its work");
    }

    static final Pattern BRANCH = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._/-]{0,100}");

    /** The branch a session pushes to: session/<its name>, kept once it's pushed, so a rename doesn't move it. */
    static String branch(ObjectNode s) {
        if (BRANCH.matcher(s.path("branch").asText("")).matches()) return s.path("branch").asText();
        String slug = s.path("name").asText("").toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-+|-+$", "");
        if (slug.length() > 40) slug = slug.substring(0, 40).replaceAll("-+$", "");
        return "session/" + (slug.isEmpty() ? s.path("id").asText() : slug);
    }

    static String token(Config config) throws Exception {
        if (config.githubLogin.isEmpty()) throw new IllegalStateException("Set your GitHub account in Sessions' settings to push");
        String token = run(List.of("gh", "auth", "token", "-u", config.githubLogin), null);
        if (token == null || token.isBlank() || token.contains(" ")) {
            throw new IllegalStateException("Log gh in as " + config.githubLogin + " (gh auth login), or change the account in Sessions' settings");
        }
        return token;
    }

    /** Where it goes: the repo itself when you can push to it, or your fork of it. */
    static String headRepo(Config config, ObjectNode s, String token) throws Exception {
        if (REPO.matcher(s.path("headRepo").asText("")).matches()) return s.path("headRepo").asText();
        String repo = s.path("repo").asText();
        if ("true".equals(run(List.of("gh", "api", "repos/" + repo, "--jq", ".permissions.push"), token))) return repo;
        String fork = config.githubLogin + "/" + repo.substring(repo.indexOf('/') + 1);
        String parent = run(List.of("gh", "api", "repos/" + fork, "--jq", ".parent.full_name"), token);
        if (parent != null && parent.strip().equalsIgnoreCase(repo)) return fork;
        throw new IllegalStateException(config.githubLogin + " can't push to " + repo + " and has no fork of it at " + fork
                + ": fork it on GitHub first");
    }

    /**
     * What a push would send, and where. With pr (a number, before the session's first push): onto that open PR's
     * branch instead of a new one, replacing what's on it with the session's work, if the PR goes into the branch the
     * session works on.
     */
    static ObjectNode preview(Config config, ObjectNode s, String token, int pr) throws Exception {
        harvest(s);
        if (running(s)) throw new IllegalStateException("It's still working: push when this turn is done");
        JsonNode last = lastGit(s);
        if (pr == 0 && staleUnrelated(last) && runnerAtLeast(0, 57)) return readAgain(s);
        if (pr == 0 && last != null && last.path("unrelated").asBoolean() && SHA.matcher(last.path("to").asText("")).matches()) {
            return unrelatedPreview(config, s, last);
        }
        JsonNode git = work(s);
        // Its PR was merged or closed (on GitHub, not here): its branch is done with, and the next push starts over,
        // on a new branch and PR (or one of your open PRs), as a first push does.
        String done = finishedPr(s, token);
        if (done != null) {
            s.remove("pushed");
            s.remove("pr");
            s.put("branch", freshBranch(config, s, token));
        }
        String pushed = s.path("pushed").asText("");
        if (pr > 0 && (!pushed.isEmpty() || s.path("pr").isTextual())) {
            throw new IllegalStateException("This session pushes to its own PR already");
        }
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText()).put("repo", s.path("repo").asText())
                .put("base", git.path("base").asText())
                .put("from", git.path("from").asText()).put("to", git.path("to").asText()).put("as", config.githubLogin)
                .put("update", !pushed.isEmpty()).put("already", pushed.equals(git.path("to").asText()));
        if (pr > 0) {
            String repo = s.path("repo").asText();
            String json = run(List.of("gh", "api", "repos/" + repo + "/pulls/" + pr, "--jq", "{state, merged, base: .base.ref, "
                    + "headRepo: .head.repo.full_name, headRef: .head.ref, sha: .head.sha, url: .html_url, commits, title}"), token);
            if (json == null || json.isBlank()) throw new IllegalArgumentException(repo + " has no PR #" + pr + " that " + config.githubLogin + " can see");
            JsonNode p = JSON.readTree(json);
            if (!p.path("state").asText().equals("open")) throw new IllegalStateException("PR #" + pr + " isn't open");
            if (!p.path("base").asText().equals(git.path("base").asText())) {
                throw new IllegalStateException("PR #" + pr + " goes into " + p.path("base").asText() + ", and the session works on "
                        + git.path("base").asText());
            }
            if (!REPO.matcher(p.path("headRepo").asText("")).matches() || !BRANCH.matcher(p.path("headRef").asText("")).matches()
                    || p.path("headRef").asText().contains("..") || !SHA.matcher(p.path("sha").asText("")).matches()) {
                throw new IllegalStateException("PR #" + pr + "'s branch can't take a push (its fork is gone?)");
            }
            out.put("headRepo", p.path("headRepo").asText()).put("headRef", p.path("headRef").asText())
                    .put("prNumber", pr).put("prTitle", oneLine(p.path("title").asText(), 200)).put("pr", p.path("url").asText())
                    .put("replaces", p.path("sha").asText()).put("replacesCommits", p.path("commits").asInt());
        } else {
            out.put("headRepo", headRepo(config, s, token)).put("headRef", branch(s));
        }
        out.put("target", out.path("headRepo").asText() + ":" + out.path("headRef").asText());
        // Before the first push: your open PRs on the repo, any of which it could go onto instead.
        if (pushed.isEmpty() && !s.path("pr").isTextual()) {
            String mine = run(List.of("gh", "api", "repos/" + s.path("repo").asText() + "/pulls?state=open&per_page=100", "--jq",
                    "[.[] | select(.user.login | ascii_downcase == \"" + config.githubLogin.toLowerCase(java.util.Locale.ROOT)
                            + "\") | {number, title, base: .base.ref}]"), token);
            ArrayNode prs = out.putArray("prs");
            if (mine != null && !mine.isBlank()) {
                for (JsonNode p : JSON.readTree(mine)) {
                    prs.addObject().put("number", p.path("number").asInt()).put("title", oneLine(p.path("title").asText(), 200))
                            .put("base", p.path("base").asText());
                }
            }
        }
        out.set("commits", git.path("commits"));
        out.put("diffstat", git.path("diffstat").asText(""));
        out.put("patch", clip(git.path("patch").asText(""), 150_000));
        out.put("patchCut", git.path("patchCut").asBoolean(false) || git.path("patch").asText("").length() > 150_000);
        if (s.path("pr").isTextual()) out.put("pr", s.path("pr").asText());
        if (done != null) out.put("finished", done);
        out.put("title", oneLine(s.path("name").asText(), 200));
        return out;
    }

    /** "PR #311 was merged" when the session's PR is merged or closed on GitHub, else null (none, or still open). */
    static String finishedPr(ObjectNode s, String token) throws Exception {
        Matcher m = Pattern.compile("https://github\\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\\d{1,9})").matcher(s.path("pr").asText(""));
        if (!m.matches()) return null;
        String json = run(List.of("gh", "api", "repos/" + m.group(1) + "/pulls/" + m.group(2), "--jq", "{state, merged}"), token);
        if (json == null || json.isBlank()) return null;
        JsonNode p = JSON.readTree(json);
        if (p.path("state").asText().equals("open")) return null;
        return "PR #" + m.group(2) + (p.path("merged").asBoolean() ? " was merged" : " was closed");
    }

    /** A branch for the session's next PR: its usual name with -2, -3… after it, the first not on GitHub yet. */
    static String freshBranch(Config config, ObjectNode s, String token) throws Exception {
        String had = s.path("branch").asText("");
        String base = had.replaceFirst("-\\d{1,3}$", "");
        if (!BRANCH.matcher(base).matches()) {
            s.remove("branch");
            base = branch(s);
        }
        String headRepo = headRepo(config, s, token);
        for (int i = 2; i < 100; i++) {
            String name = base + "-" + i;
            String sha = run(List.of("gh", "api", "repos/" + headRepo + "/branches/" + name, "--jq", ".commit.sha"), token);
            if (sha == null || sha.isBlank()) return name;
        }
        throw new IllegalStateException("Couldn't find a free branch name after " + base);
    }

    /** push-preview: what a push would send, and where, for you to read before you push. */
    static JsonNode pushPreview(Config config, JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String token = token(config);
        if (!in.path("newRepo").asText("").isEmpty()) return previewNew(config, s, token, in.path("newRepo").asText().strip(), in);
        return preview(config, s, token, in.path("pr").asInt(0));
    }

    // ---- a session's work to a new repository of yours: it's pushed there, and the session moves there ----

    /** The newest finished turn's report of the clone's commits, whatever it says; null before there is one. */
    static JsonNode lastGit(ObjectNode s) throws IOException {
        // The runner's read of the clone without a turn (slotGit, runner 0.57.1), when it's newer than the last turn's.
        Path read = AGENTS.resolve("slot-" + s.path("id").asText() + ".json");
        long readAt = Files.isRegularFile(read) ? Files.getLastModifiedTime(read).toMillis() : -1;
        JsonNode turns = s.path("turns");
        for (int k = turns.size() - 1; k >= 0; k--) {
            JsonNode t = turns.get(k);
            if (!t.path("status").asText().equals("done")) continue;
            Path f = AGENTS.resolve(t.path("agent").asText() + ".json");
            if (!Files.isRegularFile(f)) continue;
            if (readAt > Files.getLastModifiedTime(f).toMillis()) break;
            JsonNode git = JSON.readTree(f.toFile()).path("git");
            if (git.isObject() && !git.isEmpty()) return git;
        }
        if (readAt < 0) return null;
        JsonNode git = JSON.readTree(read.toFile());
        return git.isObject() && !git.isEmpty() ? git : null;
    }

    /** A report from before runner 0.57.0 that says the history is the agent's own, without its commits. */
    static boolean staleUnrelated(JsonNode git) {
        return git != null && git.path("error").asText("").contains("merge-base") && !SHA.matcher(git.path("to").asText("")).matches();
    }

    /** Asks the runner to read the session's clone again (no turn): the tab then looks again. */
    static ObjectNode readAgain(ObjectNode s) {
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText()).put("readAgain", true);
        out.putObject("slotGit").put("repo", s.path("repo").asText()).put("slot", s.path("id").asText());
        return out;
    }

    /** Work with a history of its own (the agent started a new project): it can only go to a new repository. */
    static ObjectNode unrelatedPreview(Config config, ObjectNode s, JsonNode git) {
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText()).put("repo", s.path("repo").asText())
                .put("as", config.githubLogin).put("unrelated", true).put("to", git.path("to").asText())
                .put("count", git.path("count").asInt(git.path("commits").size()));
        out.set("commits", git.path("commits"));
        return out;
    }

    /**
     * What a push to a new repository would send: the clone as it is, to target's default branch, only if target is
     * yours to push to and empty. Work on the session's repo goes as one commit with all the clone's files and none of
     * the repo's history; a history of the agent's own goes as it is. {missing} when target isn't on GitHub yet.
     */
    static ObjectNode previewNew(Config config, ObjectNode s, String token, String target, JsonNode in) throws Exception {
        harvest(s);
        if (running(s)) throw new IllegalStateException("It's still working: push when this turn is done");
        if (!runnerAtLeast(0, 57)) throw new IllegalStateException("Pushing to a new repository needs runner 0.57.0 or later: update the desk");
        if (!REPO.matcher(target).matches()) throw new IllegalArgumentException("A repository is owner/name");
        if (target.equalsIgnoreCase(s.path("repo").asText())) throw new IllegalArgumentException("That's the session's own repo");
        JsonNode git = lastGit(s);
        if (staleUnrelated(git)) return readAgain(s);
        if (git == null || !SHA.matcher(git.path("to").asText("")).matches()) {
            throw new IllegalStateException("There are no commits to push yet: ask the agent to commit its work");
        }
        // A history of its own goes as it is, or as one commit when you ask (its steps' messages stay here).
        boolean own = git.path("unrelated").asBoolean() && !in.path("oneCommit").asBoolean();
        String message = oneLine(in.path("message").asText(""), 200);
        if (message.isEmpty()) message = oneLine(s.path("name").asText(), 200);
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText()).put("repo", s.path("repo").asText())
                .put("as", config.githubLogin).put("newRepo", target).put("headRepo", target).put("to", git.path("to").asText())
                .put("squash", !own).put("unrelated", git.path("unrelated").asBoolean()).put("message", message);
        out.set("owners", owners(config, token));
        String info = run(List.of("gh", "api", "repos/" + target, "--jq", "{push: .permissions.push, private, url: .html_url, branch: .default_branch}"), token);
        if (info == null || info.isBlank()) return out.put("missing", true);
        JsonNode r = JSON.readTree(info);
        if (!r.path("push").asBoolean()) throw new IllegalStateException(config.githubLogin + " can't push to " + target);
        String branches = run(List.of("gh", "api", "repos/" + target + "/branches", "--jq", "length"), token);
        if (branches == null || !branches.strip().equals("0")) {
            throw new IllegalStateException(target + " isn't empty: a session moves only to a new, empty repository");
        }
        String branch = BRANCH.matcher(r.path("branch").asText("")).matches() ? r.path("branch").asText() : "main";
        out.put("headRef", branch).put("target", target + ":" + branch).put("private", r.path("private").asBoolean())
                .put("url", r.path("url").asText());
        ArrayNode commits = out.putArray("commits");
        JsonNode had = git.path("commits");
        if (own) {
            commits.addAll((ArrayNode) had);
            out.put("count", git.path("count").asInt(had.size())).put("diffstat", git.path("diffstat").asText(""));
        } else {
            commits.addObject().put("sha", git.path("to").asText()).put("subject", message);
            out.put("count", 1).put("was", git.path("count").asInt(had.size()));
            if (git.path("unrelated").asBoolean()) out.put("diffstat", git.path("diffstat").asText(""));
        }
        return out.put("title", oneLine(s.path("name").asText(), 200));
    }

    /** Who can own a new repository: you, then your organizations. */
    static ArrayNode owners(Config config, String token) throws Exception {
        ArrayNode list = JSON.createArrayNode().add(config.githubLogin);
        String orgs = run(List.of("gh", "api", "user/orgs?per_page=100", "--jq", ".[].login"), token);
        if (orgs != null) orgs.lines().map(String::strip).filter(o -> REPO.matcher(o + "/x").matches()).forEach(list::add);
        return list;
    }

    static JsonNode repoOwners(Config config) throws Exception {
        ObjectNode out = JSON.createObjectNode().put("as", config.githubLogin);
        out.set("owners", owners(config, token(config)));
        return out;
    }

    /**
     * repo-create (on your click in the desk's bar): a new repository on GitHub, yours or your organization's, with
     * your gh account. Empty, to push a session to; or with a README (init), to start a session on.
     */
    static JsonNode repoCreate(Config config, JsonNode in) throws Exception {
        String owner = in.path("owner").asText("").strip(), name = in.path("name").asText("").strip();
        String visibility = in.path("visibility").asText("private");
        if (!REPO.matcher(owner + "/" + name).matches() || name.equals(".") || name.equals("..")) throw new IllegalArgumentException("A repository is owner/name");
        if (!in.path("as").asText("").equalsIgnoreCase(config.githubLogin)) throw new IllegalArgumentException("Not the account in Sessions' settings");
        if (!visibility.equals("private") && !visibility.equals("public")) throw new IllegalArgumentException("Private or public?");
        String token = token(config);
        if (run(List.of("gh", "api", "repos/" + owner + "/" + name, "--jq", ".full_name"), token) != null) {
            throw new IllegalStateException(owner + "/" + name + " is on GitHub already");
        }
        List<String> cmd = new ArrayList<>(List.of("gh", "api", "-X", "POST",
                owner.equalsIgnoreCase(config.githubLogin) ? "user/repos" : "orgs/" + owner + "/repos",
                "-f", "name=" + name, "-F", "private=" + visibility.equals("private"), "-F", "auto_init=" + in.path("init").asBoolean(false)));
        String about = oneLine(in.path("description").asText(""), 350);
        if (!about.isEmpty()) cmd.addAll(List.of("-f", "description=" + about));
        cmd.addAll(List.of("--jq", "{repo: .full_name, url: .html_url}"));
        Path out = Files.createTempFile("sessions-", ".out");
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(out.toFile());
            pb.environment().put("GH_TOKEN", token);
            Process p = pb.start();
            if (!p.waitFor(60, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new IllegalStateException("GitHub didn't answer in time");
            }
            String said = Files.readString(out, StandardCharsets.UTF_8).strip();
            if (p.exitValue() != 0) {
                Matcher m = Pattern.compile("\"message\"\\s*:\\s*\"([^\"]{1,300})\"").matcher(said);
                String why = said.contains("name already exists") ? owner + "/" + name + " is on GitHub already"
                        : m.find() ? m.group(1) : clip(said, 300);
                throw new IllegalStateException("GitHub didn't create it: " + why
                        + (said.contains("HTTP 403") || said.contains("HTTP 404") ? " (can " + config.githubLogin + " create repositories in " + owner + "?)" : ""));
            }
            JsonNode r = JSON.readTree(said.lines().reduce((a, b) -> b).orElse("{}"));
            if (!REPO.matcher(r.path("repo").asText("")).matches()) throw new IllegalStateException("GitHub didn't say what it made");
            return JSON.createObjectNode().put("repo", r.path("repo").asText()).put("url", r.path("url").asText());
        } finally {
            Files.deleteIfExists(out);
        }
    }

    /**
     * push-new (on your click in the desk's bar): the session's work to a new, empty repository, by the runner, which
     * then moves the session's clone there; push-done moves the session too, so its next turns and pushes are there.
     */
    static JsonNode pushNew(Config config, JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String token = token(config);
        ObjectNode p = previewNew(config, s, token, in.path("newRepo").asText("").strip(), in);
        if (p.path("missing").asBoolean()) throw new IllegalStateException(p.path("newRepo").asText() + " isn't on GitHub: create it first");
        if (!in.path("as").asText("").equalsIgnoreCase(config.githubLogin)) throw new IllegalArgumentException("Not the account in Sessions' settings");
        int n = p.path("count").asInt();
        if (!in.path("to").asText("").equals(p.path("to").asText()) || !in.path("target").asText("").equals(p.path("target").asText())
                || !in.path("commits").asText("").equals(n + (n == 1 ? " commit" : " commits"))) {
            throw new IllegalStateException("The work changed since you looked: look at it again");
        }
        ObjectNode push = JSON.createObjectNode().put("repo", s.path("repo").asText()).put("number", 0)
                .put("slot", s.path("id").asText()).put("headRepo", p.path("headRepo").asText())
                .put("headRef", p.path("headRef").asText()).put("from", p.path("to").asText()).put("to", p.path("to").asText())
                .put("newRepo", true).put("squash", p.path("squash").asBoolean()).put("message", p.path("message").asText());
        s.putObject("pendingPush").put("to", p.path("to").asText()).put("target", p.path("target").asText())
                .put("headRepo", p.path("headRepo").asText()).put("headRef", p.path("headRef").asText())
                .put("newRepo", true).put("at", Instant.now().toString());
        save(s);
        push.put("token", token);
        return JSON.createObjectNode().put("session", s.path("id").asText()).set("push", push);
    }

    /**
     * push-done after a push to a new repository: it's there (as GitHub shows), and the session moves to that repo,
     * when the runner moved its clone; its old branch and PR stay with the old repo.
     */
    static JsonNode pushNewDone(Config config, ObjectNode s, JsonNode in, JsonNode pending) throws Exception {
        String to = pending.path("to").asText(), pushed = in.path("pushed").asText("");
        String headRepo = pending.path("headRepo").asText(""), headRef = pending.path("headRef").asText("");
        if (!REPO.matcher(headRepo).matches() || !BRANCH.matcher(headRef).matches() || !SHA.matcher(pushed).matches()) {
            throw new IllegalStateException("The runner didn't say what it pushed");
        }
        String there = run(List.of("gh", "api", "repos/" + headRepo + "/branches/" + headRef, "--jq", ".commit.sha"), token(config));
        if (!pushed.equals(there == null ? "" : there.strip())) throw new IllegalStateException("GitHub doesn't show that commit on " + headRepo + ":" + headRef);
        String old = s.path("repo").asText(), note;
        if (in.path("moved").asText("").equalsIgnoreCase(headRepo)) {
            s.put("repo", headRepo).put("movedFrom", old);
            for (String k : List.of("headRepo", "branch", "pushed", "pushedAt", "pr")) s.remove(k);
            note = "The session moved from " + old + " to " + headRepo + ": its next turns and pushes are there.";
        } else {
            note = oneLine(in.path("notMoved").asText("Pushed, but the session stays on " + old + "."), 400);
        }
        pushed(s, pushed, pending, true, null, note);
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText()).put("pushed", pushed)
                .put("target", headRepo + ":" + headRef).put("note", note).put("moved", s.path("repo").asText().equals(headRepo))
                .put("url", "https://github.com/" + headRepo);
    }

    /**
     * push (on your click in the desk's bar): the commits you read go to the session's branch, by the runner, from the
     * session's clone, with your gh account's token lent for that push only. The first push makes the branch; later
     * ones replace it (the runner keeps a session's work as one commit), refused if it changed on GitHub since.
     * push-pr (its own words in the bar): the first push goes onto an open PR's branch instead, replacing what's there
     * if it's still what the preview showed.
     */
    static JsonNode push(Config config, JsonNode in, boolean ontoPr) throws Exception {
        if (!runnerAtLeast(0, 52)) throw new IllegalStateException("Pushing a session needs runner 0.52.0 or later: update the desk");
        ObjectNode s = load(in.path("session").asText(""));
        String token = token(config);
        int pr = ontoPr ? in.path("pr").asInt(0) : 0;
        if (ontoPr && pr <= 0) throw new IllegalArgumentException("Which PR?");
        ObjectNode p = preview(config, s, token, pr);
        if (!in.path("as").asText("").equalsIgnoreCase(config.githubLogin)) throw new IllegalArgumentException("Not the account in Sessions' settings");
        if (!in.path("to").asText("").equals(p.path("to").asText()) || !in.path("target").asText("").equals(p.path("target").asText())) {
            throw new IllegalStateException("The work changed since you looked: look at it again");
        }
        int n = p.path("commits").size();
        if (!in.path("commits").asText("").equals(n + (n == 1 ? " commit" : " commits"))) {
            throw new IllegalStateException("The work changed since you looked: look at it again");
        }
        if (p.path("already").asBoolean()) throw new IllegalStateException("That's pushed already");
        ObjectNode push = JSON.createObjectNode().put("repo", s.path("repo").asText()).put("number", 0)
                .put("slot", s.path("id").asText()).put("headRepo", p.path("headRepo").asText())
                .put("headRef", p.path("headRef").asText()).put("to", p.path("to").asText());
        String pushed = s.path("pushed").asText("");
        // Onto a PR: replaces its branch, only if it's still at the commit the preview showed (the runner's lease).
        if (pr > 0) push.put("from", p.path("replaces").asText()).put("squash", true).put("base", p.path("base").asText());
        else if (pushed.isEmpty()) push.put("from", p.path("from").asText());
        else push.put("from", pushed).put("squash", true).put("base", p.path("base").asText());
        // What push-done may finish: only this push, handed to the runner now, and only for a while.
        ObjectNode pending = s.putObject("pendingPush").put("to", p.path("to").asText()).put("target", p.path("target").asText())
                .put("headRepo", p.path("headRepo").asText()).put("headRef", p.path("headRef").asText())
                .put("at", Instant.now().toString());
        if (pr > 0) pending.put("pr", p.path("pr").asText());
        save(s);
        push.put("token", token);
        return JSON.createObjectNode().put("session", s.path("id").asText()).set("push", push);
    }

    /**
     * push-done: how the runner's push went. Pushed, it's kept on the session (the branch, and the commit, which the
     * next push replaces), and the first time a draft PR opens for it, with your gh account.
     */
    static JsonNode pushDone(Config config, JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String to = in.path("to").asText("");
        // Only the push the push action just handed to the runner (on your confirm), once.
        JsonNode pending = s.path("pendingPush");
        boolean fresh = pending.path("at").isTextual()
                && Instant.parse(pending.path("at").asText()).isAfter(Instant.now().minusSeconds(900));
        if (!fresh || !SHA.matcher(to).matches() || !to.equals(pending.path("to").asText())) {
            throw new IllegalStateException("No push of that is waiting: push it again");
        }
        s.remove("pendingPush");
        if (in.path("status").asInt() == 200 && pending.path("newRepo").asBoolean()) return pushNewDone(config, s, in, pending);
        if (in.path("status").asInt() != 200) {
            String why = pushError(in.path("error").asText("It wasn't pushed"), config);
            pushed(s, to, pending, false, null, why);
            save(s);
            throw new IllegalStateException(why);
        }
        String token = token(config);
        String headRepo = pending.path("headRepo").asText(""), headRef = pending.path("headRef").asText("");
        if (!REPO.matcher(headRepo).matches() || !BRANCH.matcher(headRef).matches()
                || !pending.path("target").asText().equals(headRepo + ":" + headRef)) throw new IllegalStateException("No push there is waiting: push it again");
        String there = run(List.of("gh", "api", "repos/" + headRepo + "/branches/" + headRef, "--jq", ".commit.sha"), token);
        if (!to.equals(there == null ? "" : there.strip())) throw new IllegalStateException("GitHub doesn't show that commit on " + headRepo + ":" + headRef);
        s.put("pushed", to).put("branch", headRef).put("headRepo", headRepo).put("pushedAt", Instant.now().toString());
        if (pending.path("pr").asText("").startsWith("https://github.com/")) s.put("pr", pending.path("pr").asText());
        String repo = s.path("repo").asText(), head = headRepo.equals(repo) ? headRef : headRepo.substring(0, headRepo.indexOf('/')) + ":" + headRef;
        String note = null;
        if (!s.path("pr").isTextual()) {
            String open = run(List.of("gh", "api", "repos/" + repo + "/pulls?state=open&head=" + headRepo.substring(0, headRepo.indexOf('/')) + ":" + headRef,
                    "--jq", ".[0].html_url // empty"), token);
            String base = work(s).path("base").asText();
            if (open == null || open.isBlank()) {
                List<String> cmd = new ArrayList<>(List.of("gh", "api", "-X", "POST", "repos/" + repo + "/pulls", "-f", "title=" + oneLine(s.path("name").asText(), 200),
                        "-f", "head=" + head, "-f", "base=" + base, "-f", "body=" + prBody(s), "--jq", ".html_url"));
                open = run(append(cmd, "-F", "draft=true"), token);
                if (open == null || open.isBlank()) {
                    // A private repo on a free plan can't have draft PRs: an open one, said so.
                    open = run(cmd, token);
                    if (open != null && !open.isBlank()) note = "GitHub doesn't allow a draft PR there, so it opened as ready for review.";
                }
            }
            if (open == null || open.isBlank()) note = "Pushed, but GitHub didn't open the PR: open it from " + headRepo + ":" + headRef + ".";
            else s.put("pr", open.strip());
        }
        pushed(s, to, pending, true, s.path("pr").asText(null), note);
        save(s);
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText()).put("pushed", to)
                .put("target", headRepo + ":" + headRef);
        if (s.path("pr").isTextual()) out.put("pr", s.path("pr").asText());
        if (note != null) out.put("note", note);
        return out;
    }

    /**
     * A push as the chat shows it, between the turns, and as the agent is told with your next message: where it went,
     * or why it didn't.
     */
    static void pushed(ObjectNode s, String to, JsonNode pending, boolean ok, String pr, String text) {
        ArrayNode list = s.withArray("pushes");
        ObjectNode e = list.addObject().put("at", Instant.now().toString()).put("to", to)
                .put("target", pending.path("target").asText()).put("ok", ok);
        if (pr != null) e.put("pr", pr);
        if (text != null) e.put(ok ? "note" : "error", clip(text, 600));
        while (list.size() > 20) list.remove(0);
    }

    /** GitHub's refusals, in words that say what to do. */
    static String pushError(String error, Config config) {
        if (error.contains("workflow") && error.contains("scope")) {
            return "GitHub refused it: the commit changes GitHub Actions workflows (.github/workflows), and gh's login for "
                    + config.githubLogin + " isn't allowed to. Run gh auth refresh -h github.com -s workflow (as "
                    + config.githubLogin + "), then push again.";
        }
        if (error.contains("Permission") && error.contains("denied") || error.contains("403")) {
            return "GitHub refused it: " + config.githubLogin + " can't push to that branch. " + clip(error, 200);
        }
        return error;
    }

    static List<String> append(List<String> cmd, String... more) {
        List<String> out = new ArrayList<>(cmd);
        out.addAll(List.of(more));
        return out;
    }

    /** The PR's description: what the agent committed. Not the session's goal or chat, which may be private notes. */
    static String prBody(ObjectNode s) throws IOException {
        StringBuilder b = new StringBuilder();
        for (JsonNode c : work(s).path("commits")) b.append("- ").append(oneLine(c.path("subject").asText(), 200)).append('\n');
        return b.append("\nPushed from a Sessions chat on Elf Desk.").toString();
    }

    // ---- variables every session's agent has, for the commands it runs (an API key for what it builds, say) ----

    /** Kept next to the settings, never in a folder the tab reads: the tab only ever gets their names. */
    static final Path VARS = Config.DIR.resolve("vars.json");
    static final Pattern VAR_NAME = Pattern.compile("[A-Z_][A-Z0-9_]{0,63}");
    /** The runner's own, and those that change how a shell, git or the agent runs (as the runner refuses them). */
    static final Pattern VAR_TAKEN = Pattern.compile("(HOME|USER|LOGNAME|SHELL|PATH|PWD|OLDPWD|TMPDIR|TERM|LANG|IFS|ENV|BASH_ENV|"
            + "PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|JAVA_HOME|XDG_.*|LD_.*|DYLD_.*|GIT_.*|GH_.*|CLAUDE_.*|BOB_.*|ELF_.*|SESSION_ENV_FILE|"
            + "DOCKER_HOST|CONTAINER_HOST|CONTAINERS_CONF|TESTCONTAINERS_.*|DISABLE_AUTOUPDATER)");
    static final int MAX_VARS = 30;

    static ObjectNode readVars() throws IOException {
        if (!Files.isRegularFile(VARS)) return JSON.createObjectNode();
        JsonNode n = JSON.readTree(VARS.toFile());
        return n instanceof ObjectNode o ? o : JSON.createObjectNode();
    }

    static void writeVars(ObjectNode vars) throws IOException {
        Files.createDirectories(Config.DIR);
        Path tmp = Config.DIR.resolve("vars.json.tmp");
        Files.deleteIfExists(tmp);
        Files.createFile(tmp, java.nio.file.attribute.PosixFilePermissions.asFileAttribute(
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
        Files.writeString(tmp, JSON.writeValueAsString(vars));
        Files.move(tmp, VARS, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    /** vars: their names, never their values. */
    static JsonNode vars() throws IOException {
        ObjectNode out = JSON.createObjectNode();
        ArrayNode names = out.putArray("vars");
        readVars().fieldNames().forEachRemaining(names::add);
        return out;
    }

    /** var-set: adds a variable, or changes its value. */
    static JsonNode varSet(JsonNode in) throws IOException {
        String name = in.path("name").asText("").strip(), value = in.path("value").asText("");
        if (!VAR_NAME.matcher(name).matches()) throw new IllegalArgumentException("A name is capitals, digits and _, like ANTHROPIC_API_KEY");
        if (VAR_TAKEN.matcher(name).matches()) throw new IllegalArgumentException(name + " is the sandbox's own: pick another name");
        if (value.isEmpty() || value.length() > 8192 || value.chars().anyMatch(c -> c == 0 || c == '\n' || c == '\r')) {
            throw new IllegalArgumentException("A value is text on one line, up to 8192 characters");
        }
        ObjectNode vars = readVars();
        if (!vars.has(name) && vars.size() >= MAX_VARS) throw new IllegalStateException("That's " + MAX_VARS + " already: remove one first");
        vars.put(name, value);
        writeVars(vars);
        return vars();
    }

    /** var-remove: takes one off. */
    static JsonNode varRemove(JsonNode in) throws IOException {
        ObjectNode vars = readVars();
        vars.remove(in.path("name").asText(""));
        writeVars(vars);
        return vars();
    }

    /** What every turn is told about them: their names, and how to have them (Claude Code's shell has them already). */
    static String varsNote(ObjectNode vars, boolean bob) {
        if (vars.isEmpty()) return "";
        List<String> names = new ArrayList<>();
        vars.fieldNames().forEachRemaining(names::add);
        return "\n<desk-note>These variables are set for the commands you run: " + String.join(", ", names) + ". "
                + (bob ? "Run `set -a; . \"$SESSION_ENV_FILE\"; set +a` first in a command that needs them. "
                       : "Your shell commands have them already. ")
                + "Use them by name; never print, log or commit their values.</desk-note>";
    }

    /** The pushes since the agent last heard: what it's told with this message, once. */
    static String pushesNote(ObjectNode s) {
        StringBuilder b = new StringBuilder();
        for (JsonNode e : s.withArray("pushes")) {
            if (e.path("told").asBoolean()) continue;
            String commit = e.path("to").asText();
            commit = commit.length() > 8 ? commit.substring(0, 8) : commit;
            b.append(e.path("ok").asBoolean()
                    ? "I pushed " + commit + " to " + e.path("target").asText() + (e.path("pr").isTextual() ? " (" + e.path("pr").asText() + ")" : "") + ". "
                    : "My push of " + commit + " to " + e.path("target").asText() + " failed: " + e.path("error").asText() + " ");
            ((ObjectNode) e).put("told", true);
        }
        return b.isEmpty() ? "" : "\n<desk-note>Since your last reply: " + b.toString().strip() + "</desk-note>";
    }


    // ---- what the agent asks you to do on GitHub (it has no GitHub access): close, comment, merge, on your click ----

    /** "Ask: close #298: Thanks, covered by #300", on a line of its own: a button under the reply. */
    static final Pattern ASK = Pattern.compile("(?im)^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*|_)?Ask:(?:\\*\\*|_)?[ \\t]*`?(close|comment|merge)[ \\t]+#([0-9]{1,7})`?"
            + "(?:[ \\t]*[:\u2014-][ \\t]*(.{1,2000}?))?[ \\t]*$\\n?");
    static final int MAX_ASKS = 10;

    /** The reply without its asks, and the asks: [{kind, number, text}]. */
    static Object[] asks(String reply) {
        ArrayNode list = JSON.createArrayNode();
        Matcher m = ASK.matcher(reply);
        while (m.find() && list.size() < MAX_ASKS) {
            ObjectNode a = list.addObject().put("kind", m.group(1).toLowerCase(java.util.Locale.ROOT)).put("number", Integer.parseInt(m.group(2)));
            String text = m.group(3) == null ? "" : m.group(3).strip().replaceAll("^\"|\"$", "").replaceAll("^\u201c|\u201d$", "");
            if (!text.isEmpty() && !a.path("kind").asText().equals("merge")) a.put("text", text);
            if (a.path("kind").asText().equals("comment") && text.isEmpty()) list.remove(list.size() - 1);
        }
        return new Object[] { ASK.matcher(reply).replaceAll("").strip(), list };
    }

    static final Pattern GH_NUMBER = Pattern.compile("[0-9]{1,7}");

    /** gh-look: the issue or PR an ask is about, as GitHub has it now, for you to read before you click. */
    static JsonNode ghLook(Config config, JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        return look(s, in.path("number").asInt(0), token(config), config);
    }

    static ObjectNode look(ObjectNode s, int number, String token, Config config) throws Exception {
        if (number <= 0) throw new IllegalArgumentException("Which one?");
        String repo = s.path("repo").asText();
        String json = run(List.of("gh", "api", "repos/" + repo + "/issues/" + number, "--jq",
                "{title, state, url: .html_url, author: .user.login, pr: (.pull_request != null)}"), token);
        if (json == null || json.isBlank()) throw new IllegalArgumentException(repo + " has no #" + number + " that " + config.githubLogin + " can see");
        ObjectNode out = (ObjectNode) JSON.readTree(json);
        out.put("session", s.path("id").asText()).put("repo", repo).put("number", number).put("as", config.githubLogin)
                .put("title", oneLine(out.path("title").asText(), 200));
        if (out.path("pr").asBoolean()) {
            String pr = run(List.of("gh", "api", "repos/" + repo + "/pulls/" + number, "--jq",
                    "{sha: .head.sha, merged, mergeable_state, draft}"), token);
            if (pr != null && !pr.isBlank()) out.setAll((ObjectNode) JSON.readTree(pr));
        }
        return out;
    }

    /**
     * gh-close, gh-comment, gh-merge (each on your click in the desk's bar, which says what it does, as whom, and the
     * comment word for word): on the session's repo only, with your gh account. What the bar showed is checked again
     * here, and the ask is marked done on its turn.
     */
    static JsonNode ghDo(Config config, JsonNode in, String kind) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        int number = in.path("number").asInt(0);
        if (!in.path("repo").asText("").equals(s.path("repo").asText())) throw new IllegalArgumentException("Only on the session's repo");
        if (!in.path("as").asText("").equalsIgnoreCase(config.githubLogin)) throw new IllegalArgumentException("Not the account in Sessions' settings");
        String token = token(config);
        ObjectNode it = look(s, number, token, config);
        String repo = s.path("repo").asText();
        String comment = in.path("comment").asText("");
        String done;
        switch (kind) {
            case "close" -> {
                if (!it.path("state").asText().equals("open")) throw new IllegalStateException("#" + number + " is closed already");
                if (!in.path("saying").asText("").equals(saying(comment))) throw new IllegalStateException("The comment changed since you looked: look again");
                if (!comment.isBlank() && post(repo, number, comment, token) == null) throw new IllegalStateException("GitHub didn't take the comment, so it isn't closed");
                String path = it.path("pr").asBoolean() ? "repos/" + repo + "/pulls/" + number : "repos/" + repo + "/issues/" + number;
                if (run(List.of("gh", "api", "-X", "PATCH", path, "-f", "state=closed", "--jq", ".state"), token) == null) {
                    throw new IllegalStateException("GitHub didn't close #" + number);
                }
                done = "closed";
            }
            case "comment" -> {
                if (comment.isBlank()) throw new IllegalArgumentException("Say what to comment");
                if (post(repo, number, comment, token) == null) throw new IllegalStateException("GitHub didn't take the comment");
                done = "commented";
            }
            case "merge" -> {
                if (!it.path("pr").asBoolean() || !it.path("state").asText().equals("open")) throw new IllegalStateException("#" + number + " isn't an open PR");
                String sha = in.path("sha").asText("");
                if (!SHA.matcher(sha).matches() || !sha.equals(it.path("sha").asText()) || !sha.startsWith(in.path("short").asText("-"))) throw new IllegalStateException("#" + number + " changed since you looked: look again");
                String methods = run(List.of("gh", "api", "repos/" + repo, "--jq", "[.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge] | @csv"), token);
                String[] m = methods == null ? new String[0] : methods.split(",");
                String method = m.length == 3 ? (m[0].equals("true") ? "merge" : m[1].equals("true") ? "squash" : m[2].equals("true") ? "rebase" : null) : null;
                if (method == null) throw new IllegalStateException(repo + " allows no merge method");
                if (run(List.of("gh", "api", "-X", "PUT", "repos/" + repo + "/pulls/" + number + "/merge", "-f", "merge_method=" + method,
                        "-f", "sha=" + sha, "--jq", ".merged"), token) == null) {
                    throw new IllegalStateException("GitHub didn't merge #" + number + " (are its checks and reviews done?)");
                }
                done = "merged";
            }
            default -> throw new IllegalArgumentException(kind);
        }
        // On its turn: the button says it's done.
        for (JsonNode t : s.path("turns")) {
            for (JsonNode a : t.path("asks")) {
                if (a.path("number").asInt() == number && a.path("kind").asText().equals(kind) && !a.has("done")) {
                    ((ObjectNode) a).put("done", done).put("at", Instant.now().toString());
                }
            }
        }
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText()).put("number", number).put("done", done)
                .put("url", it.path("url").asText());
    }

    /** What the desk's bar says about a close's comment, word for word. */
    static String saying(String comment) {
        return comment.isBlank() ? "No comment." : "With the comment: \u201c" + comment.strip() + "\u201d";
    }

    static String post(String repo, int number, String body, String token) throws Exception {
        return run(List.of("gh", "api", "-X", "POST", "repos/" + repo + "/issues/" + number + "/comments", "-f", "body=" + body, "--jq", ".html_url"), token);
    }

    /** The turn the agent is working on, or null. */
    static ObjectNode workingTurn(JsonNode s) {
        for (JsonNode t : s.path("turns")) {
            if (t.path("status").asText().equals("running")) return (ObjectNode) t;
        }
        return null;
    }

    /**
     * say: a message for the agent while it works, read at its next step (as in Claude Code), not after its turn: this
     * text, or a message you queued (n). Answers {say: {agent, text}}, which the runner (0.55.0) answers in its place
     * with {said} or {said: false, why}; said records it in the turn. Claude Code only, and text only.
     */
    static JsonNode say(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        harvest(s);
        ObjectNode t = workingTurn(s);
        if (t == null) throw new IllegalStateException("It isn't working: send it as your next message");
        if (s.path("agent").asText("claude").equals("bob")) throw new IllegalStateException("IBM Bob only reads messages between turns: queue it");
        if (!runnerAtLeast(0, 55)) throw new IllegalStateException("Sending while it works needs runner 0.55.0 or later: queue it, or update the desk");
        String text = in.path("text").asText("").strip();
        if (in.hasNonNull("n") && !in.path("n").asText("").isEmpty()) {
            ArrayNode q = s.withArray("queued");
            int n = in.path("n").asInt(-1);
            if (n < 0 || n >= q.size()) throw new IllegalArgumentException("It isn't queued any more");
            if (!q.get(n).path("files").asText("").isEmpty()) throw new IllegalStateException("A message with files goes when the turn ends");
            text = q.get(n).path("text").asText("").strip();
        }
        if (text.isEmpty() || text.length() > MAX_TEXT) throw new IllegalArgumentException("Write a message");
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText());
        out.putObject("say").put("agent", t.path("agent").asText()).put("text", text);
        return out;
    }

    /** said: the runner took what you said: it shows in the turn, and a queued one (n) comes off the queue. */
    static JsonNode said(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        String text = in.path("text").asText("").strip();
        if (text.isEmpty() || text.length() > MAX_TEXT) throw new IllegalArgumentException("Write a message");
        ObjectNode t = null;
        for (JsonNode x : s.path("turns")) {
            if (x.path("agent").asText().equals(in.path("agent").asText("-"))) t = (ObjectNode) x;
        }
        if (t == null) throw new IllegalArgumentException("Not one of its turns");
        ArrayNode said = t.withArray("said");
        if (said.size() < 50) said.addObject().put("text", text).put("at", Instant.now().toString());
        ArrayNode q = s.withArray("queued");
        int n = in.path("n").asInt(-1);
        if (n >= 0 && n < q.size() && q.get(n).path("text").asText("").strip().equals(text)) q.remove(n);
        if (q.isEmpty()) s.remove("queued");
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /** unqueue: takes a message you queued off, before it's sent. */
    static JsonNode unqueue(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        ArrayNode q = s.withArray("queued");
        int n = in.path("n").asInt(-1);
        if (n < 0 || n >= q.size()) throw new IllegalArgumentException("It isn't queued any more");
        q.remove(n);
        if (q.isEmpty()) s.remove("queued");
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText());
    }

    /**
     * A new turn: saved as running, and answered with the agent the runner starts for it. It works in the session's
     * own clone (slot), resumes the agent's session from the last turn that finished, answers in plain text (no
     * schema) and is given the session's goal again, so a long session doesn't lose it.
     */
    static JsonNode turn(ObjectNode s, String text, String fileIds) throws IOException {
        // An older runner doesn't know agent, and would quietly run Claude Code instead: refused before anything is saved.
        boolean bob = s.path("agent").asText("claude").equals("bob");
        if (bob && !runnerAtLeast(0, 47)) throw new IllegalStateException("IBM Bob sessions need runner 0.47.0 or later: update the desk");
        ObjectNode vars = readVars();
        if (!vars.isEmpty() && !runnerAtLeast(0, 53)) {
            throw new IllegalStateException("Session variables need runner 0.53.0 or later: update the desk, or remove them in Sessions' settings");
        }
        harvest(s);
        if (inTerminal(s)) {
            throw new IllegalStateException("It's open in a terminal (house-elves resume): exit Claude Code there, then send it from here");
        }
        ArrayNode turns = (ArrayNode) s.path("turns");
        for (JsonNode t : turns) {
            if (t.path("status").asText().equals("running")) throw new IllegalStateException("It's still working on your last message");
        }
        int n = turns.isEmpty() ? 1 : turns.get(turns.size() - 1).path("n").asInt() + 1;
        String agentId = s.path("id").asText() + "-t" + n;
        // Its files: images shown to the agent with the message, text files put in the message.
        List<ObjectNode> files = files(s.path("id").asText(), fileIds);
        ArrayNode images = JSON.createArrayNode();
        ArrayNode attach = JSON.createArrayNode();
        StringBuilder docs = new StringBuilder();
        for (ObjectNode f : files) {
            Path p = ATTACHMENTS.resolve(f.path("file").asText());
            if (f.path("kind").asText().equals("file")) {
                if (!runnerAtLeast(0, 56)) throw new IllegalStateException("Giving the agent " + f.path("name").asText() + " needs runner 0.56.0 or later: update the desk");
                String name = attachedName(f.path("name").asText("file"), attach);
                attach.addObject().put("folder", "attachments").put("file", f.path("file").asText()).put("name", name);
            } else if (List.of("image", "pdf").contains(f.path("kind").asText())) {
                if (bob) throw new IllegalArgumentException("IBM Bob isn't shown images or PDFs: attach text or Word files");
                if (images.size() >= MAX_IMAGES) throw new IllegalArgumentException("A message takes at most " + MAX_IMAGES + " images and PDFs");
                if (f.path("kind").asText().equals("pdf") && !runnerAtLeast(0, 50)) throw new IllegalStateException("Showing PDFs needs runner 0.50.0 or later: update the desk");
                images.addObject().put("type", f.path("type").asText())
                        .put("data", java.util.Base64.getEncoder().encodeToString(Files.readAllBytes(p)));
            } else {
                docs.append("\n\n<attached-file name=\"").append(f.path("name").asText().replace("\"", "'")).append("\">\n")
                        .append(Files.readString(p).replace("</attached-file", "<\\/attached-file")).append("\n</attached-file>");
            }
        }
        if (docs.length() > MAX_DOCS_CHARS) throw new IllegalArgumentException("The attached text files are too long for one message");
        ObjectNode turnNode = turns.addObject().put("n", n).put("you", text).put("at", Instant.now().toString()).put("agent", agentId)
                .put("status", "running");
        if (!files.isEmpty()) {
            ArrayNode list = turnNode.putArray("files");
            for (ObjectNode f : files) list.addObject().put("name", f.path("name").asText()).put("kind", f.path("kind").asText()).put("file", f.path("file").asText());
        }
        while (turns.size() > MAX_TURNS) turns.remove(0);
        String pushes = pushesNote(s);
        String fresh = freshNote(s);
        save(s);

        ObjectNode agent = JSON.createObjectNode().put("id", agentId);
        agent.putObject("checkout").put("repo", s.path("repo").asText()).put("number", 0).put("kind", "REPO")
                .put("slot", s.path("id").asText());
        if (!vars.isEmpty()) agent.set("env", vars);
        StringBuilder given = new StringBuilder();
        if (!attach.isEmpty()) {
            given.append("\n\nI attached ").append(attach.size() == 1 ? "a file" : "files").append(" for you, in the .attached folder of your working directory (git leaves it out):");
            for (JsonNode a : attach) given.append("\n- .attached/").append(a.path("name").asText());
        }
        agent.put("prompt", (text.isEmpty() ? "See the attached files." : text) + docs + given + SUGGEST_RULE + varsNote(vars, bob) + pushes + fresh);
        if (!images.isEmpty()) agent.set("images", images);
        if (!attach.isEmpty()) agent.set("attach", attach);
        // The session keeps the agent it started with: neither can resume the other's.
        if (bob) agent.put("agent", "bob");
        if (n > 1) agent.put("goal", goal(s));
        String session = s.path("session").asText("");
        if (!session.isEmpty()) agent.put("session", session);
        ObjectNode out = JSON.createObjectNode().put("session", s.path("id").asText());
        out.set("agent", agent);
        return out;
    }

    /** A file's name in .attached/: as you named it, safe for a file name, and not one another file there has. */
    static String attachedName(String name, ArrayNode taken) {
        String n = name.replaceAll("[/\\\\\\p{Cntrl}]", "_").strip().replaceFirst("^\\.+", "");
        if (n.isEmpty()) n = "file";
        if (n.length() > 100) n = n.substring(0, 100);
        String base = n;
        for (int i = 2; ; i++) {
            String c = n;
            boolean used = false;
            for (JsonNode t : taken) used |= t.path("name").asText().equalsIgnoreCase(c);
            if (!used) return n;
            int dot = base.lastIndexOf('.');
            n = dot > 0 ? base.substring(0, dot) + " (" + i + ")" + base.substring(dot) : base + " (" + i + ")";
        }
    }

    /**
     * Open in Claude Code in a terminal (house-elves resume <id>, which marks it, and unmarks it when you exit): the
     * desk's agent waits, so the two don't work in its clone at once. A mark whose terminal is gone counts for nothing.
     */
    static boolean inTerminal(JsonNode s) {
        long pid = s.path("terminal").path("pid").asLong(0);
        return pid > 0 && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
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

    /**
     * Asked of the agent with every message: the message you'd most likely send next, on a last line of its own. The
     * console shows it in the empty prompt, and Tab takes it, as in Claude Code; it's kept off the reply.
     */
    static final String SUGGEST_RULE = "\n\n<desk-note>You can't push or open PRs from here: when work is ready, commit it in "
            + "this clone (as one commit on the default branch, with no Co-Authored-By or other attribution lines). I push it with "
            + "the push button at the top of this chat, onto a new branch and draft PR or onto one of my open PRs; if I ask you to "
            + "push, tell me to use that button, and don't give me git push commands. When the work belongs in a new repository "
            + "(a new project), commit it here as it should start there, and tell me to push it to a new repository with that button: "
            + "I can create the repository there, and this session then moves to it. Don't make bundles or patches for me to push. To update one of my PRs, fetch it "
            + "(git fetch origin pull/<n>/head) and leave its change as one commit on the default branch, conflicts resolved; "
            + "pushing onto that PR then replaces what's on its branch (also someone else's PR, when they let maintainers edit it). "
            + "You have no GitHub access, but you can ask me to close, comment on or merge this repo's issues and PRs: put each on "
            + "a line of its own, before any Next line, as \"Ask: close #12\", \"Ask: close #12: <closing comment>\", "
            + "\"Ask: comment #12: <comment>\" or \"Ask: merge #12\". I see each as a button, and decide. This clone is yours alone: I can't run commands in it, so "
            + "do housekeeping in it yourself (like deleting local branches you made that are no longer needed) rather than "
            + "telling me to. It holds only this repo: for another repo's PR, tell me to start a session on that repo (+ new), "
            + "and give me the message to start it with. To give me a file you made (a video, a report), say its path in this clone in `code` "
            + "(`target/demo.mp4`, or `fix.patch` at its top): I can click it to download it. If there is an obvious next step for me, end your reply with one last line: "
            + "\"Next: \" and the message I would most likely send you next, in my own words, under 100 characters "
            + "(like \"Yes, go ahead\" or \"Run the tests\"). Leave the line out when there isn't one. My chat shows it as a "
            + "suggestion I can take, not as part of your answer.</desk-note>";
    static final Pattern SUGGESTION = Pattern.compile("(?s)^(?:(.*)\\n)?[ \\t]*(?:\\*\\*|_)?Next:(?:\\*\\*|_)?[ \\t]*`?\"?([^\\n]{1,300}?)\"?`?[ \\t]*$");

    /** A reply's last line "Next: …" taken off it: the reply without it, and the suggestion (or null). */
    static String[] suggestion(String reply) {
        Matcher m = SUGGESTION.matcher(reply.stripTrailing());
        if (!m.matches() || m.group(2).isBlank()) return new String[] { reply, null };
        return new String[] { m.group(1) == null ? "" : m.group(1).stripTrailing(), oneLine(m.group(2).strip(), 200) };
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
        // What you queued while it worked goes now, if it finished; after a stop or a failure it waits for you.
        JsonNode last = s.path("turns").path(s.path("turns").size() - 1);
        if (!s.path("queued").isEmpty() && !running(s) && last.path("status").asText().equals("done")) {
            try {
                return next(s, "", "");
            } catch (IllegalArgumentException | IllegalStateException e) {
                System.err.println("Couldn't send what you queued: " + e.getMessage()); // it stays queued, for you to see
            }
        }
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
                        String[] r = suggestion(a.path("output").path("reply").asText(""));
                        Object[] asked = asks(r[0]);
                        r[0] = (String) asked[0];
                        if (!((ArrayNode) asked[1]).isEmpty()) turn.set("asks", (ArrayNode) asked[1]);
                        turn.put("status", "done").put("reply", clip(r[0], MAX_REPLY));
                        if (r[1] != null) turn.put("suggest", r[1]);
                        String session = a.path("session").asText("");
                        if (session.matches("[A-Za-z0-9-]{1,100}")) s.put("session", session);
                        // Its handover written: the next turn starts a new conversation with it.
                        if (turn.path("kind").asText().equals("compact") && !r[0].isBlank()) {
                            s.remove("session");
                            s.put("carry", clip(r[0], MAX_CARRY)).put("contextReset", Instant.now().toString());
                            turn.put("compacted", true);
                        }
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

    // ---- the agent's context: cleared, or compacted into a summary it carries into a new conversation ----

    static final int MAX_CARRY = 30_000;

    static final String COMPACT_PROMPT = "Your context is getting full, so this conversation will end after this answer, and the "
            + "next message starts a new one with only your answer to this. Write a handover for yourself: what this session is "
            + "for and where it stands; what has been done and decided (and why, where it matters); what's in this clone (branches, "
            + "files, anything not committed) and anything running or set up; what's open or next, with what I last asked; and the "
            + "gotchas you learned. Be complete but brief: facts, names and paths, not the story. Change nothing in the clone.";

    /** Once, in the first turn of a new conversation: why it starts afresh, with the summary it carries. */
    static String freshNote(ObjectNode s) {
        String carry = s.path("carry").asText("");
        boolean cleared = s.path("cleared").asBoolean(false);
        s.remove("carry");
        s.remove("cleared");
        if (!carry.isEmpty()) {
            return "\n<desk-note>This is a new conversation: the earlier one was compacted to free up your context. Your own "
                    + "handover from it:\n<handover>\n" + carry.replace("</handover", "<\\/handover") + "\n</handover>\n"
                    + "Your clone is as you left it.</desk-note>";
        }
        if (cleared) {
            return "\n<desk-note>This is a new conversation: I cleared the earlier one. Your clone is as it was (git log and git "
                    + "status show the work so far); ask me if you need to know more about what we did.</desk-note>";
        }
        return "";
    }

    /** context-clear (on your click in the desk's bar): the next turn starts a new conversation, with none of this one. */
    static JsonNode contextClear(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        harvest(s);
        if (running(s)) throw new IllegalStateException("It's working: clear its context when this turn is done");
        if (!s.path("session").isTextual() && !s.has("carry")) throw new IllegalStateException("Its context is clear already");
        s.remove("session");
        s.remove("carry");
        s.put("cleared", true).put("contextReset", Instant.now().toString());
        s.withArray("resets").addObject().put("at", Instant.now().toString()).put("kind", "cleared");
        save(s);
        return JSON.createObjectNode().put("session", s.path("id").asText()).put("cleared", true);
    }

    /**
     * context-compact: a turn in which the agent writes its own handover; once it's done, the next turn starts a new
     * conversation with only that (harvest).
     */
    static JsonNode contextCompact(JsonNode in) throws Exception {
        ObjectNode s = load(in.path("session").asText(""));
        harvest(s);
        if (running(s)) throw new IllegalStateException("It's working: compact its context when this turn is done");
        if (!s.path("session").isTextual()) throw new IllegalStateException("There's no conversation to compact yet");
        JsonNode out = turn(s, COMPACT_PROMPT, "");
        ObjectNode t = (ObjectNode) s.withArray("turns").get(s.withArray("turns").size() - 1);
        t.put("kind", "compact").put("you", "/compact");
        save(s);
        return out;
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
     * delete: the session's file, its agents' reports and its files, once you confirmed it in the desk's bar. Its clone
     * is the runner's: the tab has it removed after (elf.removeSlot). Refused while the agent works, as the runner would.
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
        if (Files.isDirectory(ATTACHMENTS)) {
            try (var files = Files.list(ATTACHMENTS)) {
                for (Path f : files.toList()) if (f.getFileName().toString().startsWith(id + "-")) Files.deleteIfExists(f);
            }
        }
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
