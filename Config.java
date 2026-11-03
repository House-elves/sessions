import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/** ~/.config/sessions/config: KEY=value lines. Elf Desk writes it from the settings in elf.yaml. */
public class Config {

    static final Path DIR = Path.of(System.getProperty("user.home"), ".config", "sessions");
    static final Path FILE = DIR.resolve("config");

    /** The gh account that must be able to see a session's repo; empty to skip the check. */
    String githubLogin;
    /** The tags a session may carry (TAGS, comma-separated), as you spelled them. */
    java.util.List<String> tags;

    static Config load() throws IOException {
        Map<String, String> raw = new HashMap<>();
        if (Files.exists(FILE)) {
            for (String line : Files.readAllLines(FILE)) {
                line = line.strip();
                int eq = line.indexOf('=');
                if (!line.startsWith("#") && eq > 0) raw.putIfAbsent(line.substring(0, eq).strip(), line.substring(eq + 1).strip());
            }
        }
        Config c = new Config();
        c.githubLogin = raw.getOrDefault("GITHUB_LOGIN", "");
        c.tags = java.util.Arrays.stream(raw.getOrDefault("TAGS", "Personal, Work").split(",")).map(String::strip)
                .filter(t -> t.matches("[A-Za-z0-9 ._*/+#&()-]{1,30}")).distinct().limit(30).toList();
        if (!c.githubLogin.isEmpty() && !c.githubLogin.matches("[A-Za-z0-9][A-Za-z0-9-]{0,38}")) {
            throw new IllegalStateException("Set a GitHub account in Sessions' settings on the desk");
        }
        return c;
    }
}
