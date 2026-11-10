// Sessions' tab on Elf Desk: one sub-tab per session, its goal pinned above the chat, and the agent's live lines while
// it works. It runs in the desk's sandboxed frame: everything goes through `elf`, and only what elf.yaml declares.
// Sessions live on the host (~/.config/sessions), so every device signed in to the desk sees the same ones.
import {
    LitElement, html, css, nothing, shared, cardStyles, markdown, markdownStyles, spinner, ago, count, settingsButton,
    Ticking, elf,
} from '/elf-kit/1/kit.js';

const SESSION = /^s[0-9]{10,16}$/;
/** A PR's link as "PR #140". */
const prLabel = url => { const m = /\/pull\/(\d+)/.exec(url ?? ''); return m ? `PR #${m[1]}` : 'its PR'; };
/** A message that only asks to push: the desk does that, with the push box. */
const PUSH_ASK = /^(please\s+|ok(ay)?,?\s+|yes,?\s+)?(go ahead and\s+)?push(\s+(it|this|that|them|the (commit|commits|work|changes|branch)))?(\s+(now|please|to github|to (the )?pr))*[.!]*$/i;
const FILE = /^(s[0-9]{10,16})\.json$/;
/** Routes: '', s/<id>, new, new/<elf>/<ref>/<title> (from another elf, a todo say), link/<id>/<elf>/<ref>/<title>. */
const ELF = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REF = /^[A-Za-z0-9._-]{1,80}$/;

function fromRoute(s) {
    try { return decodeURIComponent(s ?? '').replace(/\p{Cc}+/gu, ' ').slice(0, 300); } catch { return ''; }
}

async function loadSessions() {
    const files = (await elf.list('sessions').catch(() => [])) ?? [];
    const names = (Array.isArray(files) ? files : files.files ?? []).map(f => (typeof f === 'string' ? f : f.name))
        .filter(n => FILE.test(n ?? ''));
    const all = await Promise.all(names.map(n => elf.readJson('sessions', n).catch(() => null)));
    return all.filter(s => s && SESSION.test(s.id ?? '')).sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
}

const working = s => (s.turns ?? []).some(t => t.status === 'running');

// Files with a message: at most this many; an image no bigger than Claude reads one (1568 pixels on the long side),
// about 450 KB; a text file up to 100 KB. Each goes to the elf in parts: the desk takes up to 64 KB at a time.
const MAX_FILES = 10;
const MAX_SIDE = 1568;
const MAX_IMAGE_CHARS = 600_000;
const MAX_DOC_BYTES = 100_000;
// A PDF (Claude reads it whole: text, tables and pictures) or a Word file (its text goes in the message).
const MAX_DOCUMENT_BYTES = 3_000_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What a file is to a message: an image, a PDF, a Word file, or text. */
function kindOf(file) {
    const name = (file.name ?? '').toLowerCase();
    if (file.type.startsWith('image/')) return 'image';
    if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (file.type === DOCX || name.endsWith('.docx')) return 'docx';
    if (file.type === 'application/msword' || name.endsWith('.doc')) return 'doc';
    if (TEXT_TYPE.test(file.type) || (!file.type && !BINARY_NAME.test(name))) return 'text';
    // Anything else (a slide deck, a spreadsheet, a zip, a video): copied into its clone, for the agent to open there.
    return 'file';
}

/** Text that goes into the message, by its type (a file with no type is text unless its name says otherwise). */
const TEXT_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|x-shellscript|sql|toml|x-httpd-php)$)/;
const BINARY_NAME = /\.(zip|jar|war|gz|tgz|bz2|xz|7z|rar|pptx?|xlsx?|odt|ods|odp|key|numbers|pages|mp4|mov|webm|mkv|avi|mp3|wav|ogg|flac|bin|exe|so|dll|dylib|class|psd|ai|sketch|fig|sqlite|db|ttf|otf|woff2?|ico|heic)$/;
/** A file the agent opens in its clone (.attached/) may be this big. */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

/** A file as a data URL of the type it should be. */
function dataUrl(file, type) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^;,]*(;base64)?,/, `data:${type};base64,`));
        r.onerror = () => reject(new Error('couldn\'t read it'));
        r.readAsDataURL(file);
    });
}
const PART = 60_000;

/** An image file as a data URL that fits: PNG if it's small enough (sharpest for text), else WebP or JPEG, smaller. */
async function fit(file) {
    const bitmap = await createImageBitmap(file);
    let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    for (let tries = 0; tries < 8; tries++, scale *= 0.75) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; // what's transparent, on white (JPEG has no transparency)
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const [type, quality] of [['image/png'], ['image/webp', 0.92], ['image/webp', 0.8], ['image/jpeg', 0.85]]) {
            const url = canvas.toDataURL(type, quality);
            if (url.startsWith(`data:${type};`) && url.length <= MAX_IMAGE_CHARS) return url;
        }
    }
    throw new Error('too big to send');
}
const AGENT_NAMES = { claude: 'Claude Code', bob: 'IBM Bob', codex: 'Codex', pi: 'pi' };
const agentName = id => AGENT_NAMES[id] ?? 'Claude Code';

/** A model's id as people say it: claude-opus-5-5 is Opus 5.5, with (1M) for a 1M-context variant. */
function modelName(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id ?? '');
    if (!m) return id ?? '';
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}

/** A time it took: 45s, 3m 20s, 1h 05m. */
function took(ms) {
    const s = Math.round((ms ?? 0) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

/**
 * A session's numbers: what it has cost (dollars for Claude Code, Bobcoins for IBM Bob), how long its agent has worked,
 * the model of its last turn, and how full its context is after it.
 */
function totals(s) {
    const turns = s.turns ?? [];
    const sum = k => turns.reduce((n, t) => n + (typeof t[k] === 'number' ? t[k] : 0), 0);
    const last = [...turns].reverse().find(t => t.contextWindow > 0);
    return {
        cost: turns.some(t => typeof t.cost === 'number') ? sum('cost') : null,
        bobcoins: turns.some(t => typeof t.bobcoins === 'number') ? sum('bobcoins') : null,
        ms: turns.some(t => typeof t.durationMs === 'number') ? sum('durationMs') : null,
        model: [...turns].reverse().find(t => t.model)?.model ?? s.model ?? null,
        context: last ? Math.min(100, Math.round(last.contextUsed / last.contextWindow * 100)) : null,
    };
}
/** The tags in its settings (TAGS), as spelled there. */
/** The message you'd most likely send next, as the agent suggested at the end of its last reply; none while it works. */
const suggestion = (s, busy) => {
    const last = s?.turns?.at(-1);
    return !busy && last?.status === 'done' && typeof last.suggest === 'string' ? last.suggest : '';
};

const settingsTags = values => [...new Set((values?.TAGS ?? '').split(',').map(t => t.trim()).filter(Boolean))];
const tagged = (s, tag) => !tag || (s.tags ?? []).includes(tag);


/** 6.5 MB, 820 KB */
function size(n) {
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// A full path into the session's clone (…/worktrees/slots/<owner_repo>/sessions_<id>/…), as the agent says where a file
// is; and in `code`, a path of the clone's own (control-plane/target/x.mp4).
const PATH_CHARS = '[^\\s`\'"<>()\\[\\]{}|]';
const RELATIVE = /^(?:\.\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,10}$/;

function linkFiles(root, id) {
    const full = new RegExp(`/${PATH_CHARS}*/sessions_${id}/${PATH_CHARS}+`, 'g');
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.parentElement.closest('a')) texts.push(n);
    }
    for (const t of texts) {
        const text = t.nodeValue;
        full.lastIndex = 0;
        const parts = [];
        let at = 0;
        for (let m = full.exec(text); m; m = full.exec(text)) {
            const path = m[0].replace(/[.,;:!?]+$/, '');
            // A file, not a folder: its last part has an extension (demo.mp4).
            if (!/\.[A-Za-z0-9]{1,10}$/.test(path.split('/').pop())) continue;
            parts.push(text.slice(at, m.index), link(root, path));
            at = m.index + path.length;
            full.lastIndex = at;
        }
        if (parts.length) {
            parts.push(text.slice(at));
            t.replaceWith(...parts.filter(p => p !== ''));
            continue;
        }
        // A path of the clone's own, alone in `code`: Wrote it to `target/cast/demo.mp4`.
        const code = t.parentElement;
        if (code.tagName === 'CODE' && code.parentElement?.tagName !== 'PRE' && code.childNodes.length === 1
                && text.includes('/') && RELATIVE.test(text.trim()) && !text.includes('..')) {
            t.replaceWith(link(root, text.trim(), text));
        }
    }
}

function link(root, path, shown = path) {
    const a = root.ownerDocument.createElement('a');
    a.className = 't-dl';
    a.href = '#';
    a.dataset.path = path;
    a.title = `Download ${path.split('/').pop()}`;
    a.textContent = shown;
    return a;
}

class SessionsTab extends LitElement {
    static properties = {
        _sessions: { state: true }, _route: { state: true }, _error: { state: true }, _live: { state: true },
        _busy: { state: true }, _goalOpen: { state: true }, _editing: { state: true }, _archived: { state: true },
        _lines: { state: true }, _confirmDelete: { state: true }, _tags: { state: true }, _filter: { state: true },
        _tagging: { state: true }, _options: { state: true }, _installed: { state: true }, _context: { state: true },
        _files: { state: true }, _sayMode: { state: true }, _fillOk: { state: true }, _dragging: { state: true }, _github: { state: true }, _push: { state: true },
        _pushDiff: { state: true }, _pushed: { state: true }, _otherPr: { state: true }, _breakout: { state: true }, _copied: { state: true }, _look: { state: true }, _listening: { state: true },
        _newRepo: { state: true }, _repoMade: { state: true },
    };

    static styles = [shared, markdownStyles, css`
        :host { display: block; }
        .page { display: grid; gap: 18px; }
        .page-top p.hint { margin: 6px 0 0; }
        .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0; }
        .bar a { display: inline-flex; gap: 6px; align-items: center; padding: 6px 12px; border-radius: 999px;
            border: 1px solid var(--line); color: var(--ink); text-decoration: none; background: var(--surface); max-width: 16rem; }
        .bar a span.n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bar a[aria-current="page"] { border-color: var(--accent); background: var(--accent-soft); }
        .bar a.archived { opacity: .65; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
        .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
        .head h2 { margin: 0; font-size: 18px; }
        .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
        .goal { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 12px;
            background: var(--surface-2); margin: 10px 0; }
        .goal .label { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; justify-content: space-between; }
        .goal .text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; }
        .goal .text.folded { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .chat { overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--surface);
            display: flex; flex-direction: column; gap: 14px; }
        .you { align-self: flex-end; max-width: 85%; background: var(--accent-soft); border-radius: 10px; padding: 8px 12px;
            white-space: pre-wrap; overflow-wrap: anywhere; }
        .agent { max-width: 100%; }
        .lines { font-family: var(--font-code); font-size: 12px; color: var(--muted); white-space: pre-wrap;
            overflow-wrap: anywhere; max-height: 18rem; overflow-y: auto; border-left: 2px solid var(--line); padding-left: 8px; }
        .when { font-size: 12px; color: var(--muted); }
        input, textarea, select { font: inherit; color: var(--ink); }
        /* The desk's shared styles leave text fields to the browser, so give them the desk's look here. */
        input:not([type="checkbox"]):not([type="radio"]), textarea, select {
            box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 11px; font-size: 14px;
            background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-control, 9px);
            color-scheme: inherit; transition: border-color 0.15s, box-shadow 0.15s; }
        input:not([type="checkbox"]):not([type="radio"]):hover, textarea:hover, select:hover { border-color: var(--muted); }
        input:not([type="checkbox"]):not([type="radio"]):focus, textarea:focus, select:focus {
            outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        input:disabled, textarea:disabled { opacity: 0.6; cursor: not-allowed; }
        input::placeholder, textarea::placeholder { color: var(--muted); opacity: 0.8; }
        input[type="checkbox"] { accent-color: var(--accent); }
        textarea { min-height: 5rem; resize: vertical; line-height: 1.5; }
        .compose { margin-top: 10px; display: grid; gap: 6px; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        form.new { display: grid; gap: 18px; max-width: 46rem; padding: 20px 22px; }
        form.new h2 { margin: 0 0 2px; }
        form.new label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
        form.new .field-hint { font-size: 12px; color: var(--muted); }
        form.new textarea { min-height: 9rem; }
        form.new fieldset { border: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        form.new legend { font-size: 13px; color: var(--muted); padding: 0; margin-bottom: 6px; }
        form.new .tagbox label { display: inline-flex; flex-direction: row; font-size: 14px; color: var(--ink); }
        form.new .hint { margin: 0; }
        form.new .row { padding-top: 4px; }
        /* Files for the first message: drop them anywhere on the form, or choose them. */
        .dropbox { display: grid; gap: 8px; padding: 14px 16px; border: 1.5px dashed var(--line, #ccc); border-radius: 8px;
            font-size: 13px; color: var(--muted); transition: border-color .12s, background .12s; }
        form.new.dragging .dropbox { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--ink); }
        .dropbox .files { display: flex; gap: 8px; flex-wrap: wrap; }
        .dropbox .file { display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px; border-radius: 6px;
            background: color-mix(in srgb, var(--ink) 7%, transparent); color: var(--ink); }
        .dropbox .file.failed { color: var(--danger, #c0392b); }
        .dropbox .file button { background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; }
        .linkish { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
        .confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .panel.empty { display: grid; gap: 16px; justify-items: start; padding: 22px 24px; margin-top: 4px; }
        .panel.empty p { margin: 0; }
        .bar { row-gap: 10px; }
        .filter { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .filter button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
        .tagbox { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
        .tagbox label { display: inline-flex; gap: 4px; align-items: center; font-weight: 400; }

        /* An open session: a console like Claude Code's, in its colours and monospace, whatever the desk's theme. */
        .term {
            --t-bg: #1a1918; --t-bg2: #262524; --t-ink: #e8e6e1; --t-dim: #8f8c86; --t-line: #3b3936;
            --t-acc: #d97757; --t-green: #6cc28a; --t-red: #e5786d; --t-warn: #e3b25c;
            height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;
            background: var(--t-bg); color: var(--t-ink); border-radius: 10px; border: 1px solid var(--t-line);
            font: 13.5px/1.55 var(--font-code); }
        .term a { color: var(--t-acc); }
        .term b { font-weight: 600; }
        .t-head { padding: 6px 12px 4px; border-bottom: 1px solid var(--t-line); display: grid; gap: 4px; }
        .t-tabs { display: flex; gap: 4px; align-items: center; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; }
        .t-tabs a { color: var(--t-dim); text-decoration: none; padding: 2px 10px; border-radius: 6px; max-width: 24rem; flex: none;
            overflow: hidden; text-overflow: ellipsis; }
        .t-tabs a:hover { color: var(--t-ink); }
        .t-tabs a.on { color: var(--t-ink); background: var(--t-bg2); }
        .t-logo { color: var(--t-acc); margin-right: 4px; }
        .t-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
        .t-name { color: var(--t-ink); }
        .t-model { color: var(--t-acc); }
        .t-dim, .t-foot, .t-turn-foot { color: var(--t-dim); }
        .t-acc { color: var(--t-acc); }
        .t-warn { color: var(--t-warn); }
        .t-red { color: var(--t-red); }
        .t-green { color: var(--t-green); }
        .t-tag { color: var(--t-green); }
        .t-grow { flex: 1; }
        .t-btn { all: unset; cursor: pointer; color: var(--t-dim); text-decoration: underline dotted; text-underline-offset: 3px; }
        .t-btn:hover { color: var(--t-ink); }
        /* The desk's buttons get a light background on hover; the console's are links, and stay so. */
        .term button.t-btn, .term button.t-btn:hover:not(:disabled), .term button.t-btn:focus {
            background: none; border: 0; padding: 0; box-shadow: none; font: inherit; }
        .t-btn:focus-visible { outline: 1px solid var(--t-acc); }
        .t-btn[disabled] { opacity: .5; cursor: default; }
        .term .t-select { font: inherit; color: var(--t-dim); background: var(--t-bg); border: 1px solid var(--t-line); border-radius: 6px;
            padding: 0 4px; width: auto; flex: none; box-shadow: none; }
        .t-inline { display: inline-flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
        .t-inline input:not([type=checkbox]) { font: inherit; color: var(--t-ink); background: var(--t-bg2); border: 1px solid var(--t-line);
            border-radius: 4px; padding: 0 6px; width: auto; }
        .t-inline label { display: inline-flex; gap: 4px; align-items: center; }
        .t-err { color: var(--t-red); }
        .t-goal { padding: 6px 12px; border-bottom: 1px solid var(--t-line); background: var(--t-bg2); }
        .t-goal-row { display: flex; gap: 10px; align-items: baseline; }
        .t-goal-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--t-ink); }
        .t-goal-text.folded { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .t-log { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 6px; }
        .t-you { display: flex; gap: 8px; margin-top: 12px; padding: 6px 10px; background: var(--t-bg2); border-radius: 6px; }
        .t-you:first-child { margin-top: 0; }
        .t-you-text { white-space: pre-wrap; overflow-wrap: anywhere; }
        .t-midturn { display: flex; gap: 8px; color: var(--t-ink); }
        .t-midturn .t-you-text { flex: 1; }
        .t-said-note { color: var(--t-dim); font-size: .9em; white-space: nowrap; }
        .t-prompt { color: var(--t-dim); user-select: none; }
        .t-line { display: flex; gap: 8px; align-items: baseline; }
        .t-line > :last-child { min-width: 0; overflow-wrap: anywhere; }
        .t-dot { flex: none; width: 1ch; user-select: none; }
        .t-said { white-space: pre-wrap; color: var(--t-dim); }
        .t-reply .md { color: var(--t-ink); font: inherit; line-height: 1.6; }
        .t-reply .md pre, .t-reply .md code { font: inherit; background: var(--t-bg2); }
        .t-reply .md pre { padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
        .t-reply .md h1, .t-reply .md h2, .t-reply .md h3 { font-size: 1em; font-family: inherit; }
        .t-turn-foot { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12.5px; }
        .t-working { color: var(--t-acc); }
        .t-spin { color: var(--t-acc); display: inline-block; animation: t-spin 1.6s linear infinite; }
        @keyframes t-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .t-spin { animation: none; } }
        .t-files { display: flex; gap: 8px; flex-wrap: wrap; }
        /* A push to read before it goes. */
        .t-push { margin: 0 12px; padding: 8px 10px; border: 1px solid var(--t-line); border-radius: 8px; background: var(--t-bg2);
            display: grid; gap: 4px; max-height: 45vh; overflow-y: auto; }
        .t-push .t-ink, .t-ask .t-ink { color: var(--t-ink); }
        .t-ask { color: var(--t-warn); }
        .t-ask > div { display: grid; gap: 3px; }
        .t-ask .t-row { display: flex; gap: 14px; align-items: baseline; }
        .t-push pre { margin: 0; white-space: pre; overflow-x: auto; font: inherit; font-size: 12.5px; color: var(--t-dim); }
        .t-push pre.t-diff { color: var(--t-ink); max-height: 30vh; overflow-y: auto; }
        .t-push .t-row { display: flex; gap: 14px; align-items: baseline; padding-top: 4px; }
        .term button.t-acc { color: var(--t-acc); font-weight: 600; }
        .t-push .t-sel { font: inherit; font-size: 13px; color: var(--t-ink); background: var(--t-bg); border: 1px solid var(--t-line);
            border-radius: 6px; padding: 2px 6px; max-width: min(36rem, 100%); }
        .term .t-push input.t-cmd { font: inherit; flex: 1; min-width: 0; height: auto; color: var(--t-ink); background: var(--t-bg);
            border: 1px solid var(--t-line); border-radius: 6px; padding: 3px 8px; box-shadow: none; }
        .t-push .t-inline { display: inline-flex; gap: 6px; align-items: baseline; }
        .t-push .t-num { font: inherit; width: 6em; color: var(--t-ink); background: var(--t-bg); border: 1px solid var(--t-line);
            border-radius: 6px; padding: 2px 6px; }
        /* Dragging files over the console: it says where they go. */
        .term { position: relative; }
        .t-dropzone { position: absolute; inset: 8px; z-index: 5; pointer-events: none; display: grid; place-items: center;
            border: 2px dashed var(--t-acc); border-radius: 8px; background: color-mix(in srgb, var(--t-bg) 94%, transparent);
            color: var(--t-acc); font-size: 15px; text-align: center; }
        .t-file { color: var(--t-acc); position: relative; text-decoration: none; }
        .t-file.failed { color: var(--t-red); }
        .t-reply a.t-dl { color: var(--t-acc); text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
        .t-reply a.t-dl:hover { text-decoration-style: solid; }
        .t-reply a.t-dl.busy { color: var(--t-dim); cursor: progress; }
        .t-reply a.t-dl.failed { color: var(--t-red); }
        .t-file.sending { color: var(--t-dim); }
        .t-file img { display: none; position: absolute; left: 0; bottom: 1.6em; max-width: 280px; max-height: 200px;
            border: 1px solid var(--t-line); border-radius: 6px; background: #fff; z-index: 2; }
        .t-file:hover img { display: block; }
        .t-input { padding: 6px 12px 8px; display: grid; gap: 4px; }
        /* Messages you sent while it worked: they go when the turn ends. */
        .t-queue { display: grid; gap: 2px; color: var(--t-dim); }
        .t-queue div { display: flex; gap: 8px; align-items: baseline; }
        .t-queue .t-qtext { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--t-ink); opacity: .75; flex: 1; }
        .t-mic { align-self: center; font-size: 15px; line-height: 1; padding: 2px 6px; text-decoration: none; }
        .t-mic.on { color: var(--t-red); animation: t-blink 1.2s ease-in-out infinite; }
        @keyframes t-blink { 50% { opacity: 0.4; } }
        @media (prefers-reduced-motion: reduce) { .t-mic.on { animation: none; } }
        .t-box { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--t-line); border-radius: 8px; padding: 6px 10px; }
        .t-box:focus-within { border-color: var(--t-dim); }
        .t-box.busy { border-style: dashed; }
        .term .t-area { all: unset; flex: 1; min-width: 0; box-sizing: border-box; width: 100%; color: var(--t-ink); font: inherit;
            white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: none; caret-color: var(--t-acc); }
        .term .t-area::placeholder { color: var(--t-dim); opacity: .8; }
        .t-goal .t-area { border: 1px solid var(--t-line); border-radius: 6px; padding: 6px 8px; margin: 4px 0; }
        .t-foot { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; }
    `];

    constructor() {
        super();
        new Ticking(this);
        this._sessions = null;
        this._route = elf.route();
        this._live = {};
        this._lines = {};
        this._goalOpen = false;
        this._archived = false;
        this._tags = [];
        this._filter = '';
        // Which tag the bar shows, per browser.
        elf.store.get('filter').then(f => { this._filter = f ?? ''; }).catch(() => {});
    }

    connectedCallback() {
        super.connectedCallback();
        this._load();
        // While it works, Enter sends your message at once (it reads it at its next step) or queues it for after.
        this._sayMode = 'now';
        elf.store.get('say-mode').then(v => { if (v === 'queue') this._sayMode = 'queue'; }).catch(() => {});
        // Pushing a session's work comes with the GitHub elf: offered only when it's on the desk. (An older desk has no hasElf.)
        (typeof elf.hasElf === 'function' ? elf.hasElf('github') : Promise.resolve(false))
            .then(v => { this._github = !!v; }).catch(() => { this._github = false; });
        // A session changed, or an agent said something: read again.
        this._off = elf.onChange(() => this._load());
        this._offRoute = elf.onRoute(r => { this._route = r; this._routeChanged(); });
        this._routeChanged();
    }

    disconnectedCallback() {
        this._off?.();
        this._offRoute?.();
        super.disconnectedCallback();
    }

    // ---- loading ----

    async _load() {
        try {
            this._sessions = await loadSessions();
            this._tags = settingsTags(await elf.values().catch(() => ({})));
            // Turns still running: their live lines, from the agent's report.
            const live = {};
            for (const s of this._sessions) {
                for (const t of s.turns ?? []) {
                    if (t.status === 'running') live[t.agent] = await elf.agent(t.agent).catch(() => null);
                }
            }
            this._live = live;
            // Only clears its own error: an action's (which reloads after) stays until you dismiss it.
            if (this._loadFailed) this._error = null;
            this._loadFailed = false;
        } catch (e) {
            this._error = e.message;
            this._loadFailed = true;
        }
    }

    get _current() {
        const m = /^s\/(s[0-9]{10,16})$/.exec(this._route ?? '');
        if (m) return (this._sessions ?? []).find(s => s.id === m[1]) ?? null;
        if ((this._route ?? '') === '') return (this._sessions ?? []).filter(s => !s.archived && tagged(s, this._filter)).at(-1) ?? null;
        return null;
    }

    /** A link handed over by another elf (a todo's Link session): kept on the session, then its page. */
    async _routeChanged() {
        const p = (this._route ?? '').split('/');
        if (p[0] === 'new') {
            // Repos to suggest (those on the GitHub elf's board, and of your sessions; typing any other works too), and
            // the coding agents: which are installed, which can run a session, and the one in the settings.
            if (!this._options) {
                elf.act('new-options', {}).then(r => { this._options = r ?? {}; })
                    .catch(() => { this._options = { repos: [], agents: [{ id: 'claude', label: 'Claude Code', installed: true, sessions: true }], agent: 'claude' }; });
            }
            // From another elf's item (a todo): what it's about, read by the elf, as the goal to start from.
            this._context = null;
            if (ELF.test(p[1] ?? '') && REF.test(p[2] ?? '')) {
                const link = `${p[1]}:${p[2]}`;
                elf.act('link-context', { link }).then(c => { if (this._route?.startsWith('new')) this._context = { link, ...(c ?? {}) }; })
                    .catch(() => {});
            }
            // Started already (you came back to a todo's Start a session): its page.
            if (SESSION.test(p[4] ?? '')) {
                await this._ready();
                if ((this._sessions ?? []).some(x => x.id === p[4])) this._go(`s/${p[4]}`, true);
            }
        }
        if (p[0] === 'link' && SESSION.test(p[1] ?? '') && ELF.test(p[2] ?? '') && REF.test(p[3] ?? '')) {
            await this._act('link', { session: p[1], link: `${p[2]}:${p[3]}`, linkTitle: fromRoute(p[4]) }, 'Couldn\'t link it');
            this._go(`s/${p[1]}`, true);
        }
    }

    /** Waits for the first load of the sessions. */
    async _ready() {
        for (let i = 0; this._sessions === null && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    }

    _go(route, replace = false) {
        this._route = route;
        this._confirmDelete = false;
        this._editing = null;
        this._tagging = false;
        elf.go(route, { replace });
        this._routeChanged();
    }

    async _act(action, params, failed) {
        this._busy = action;
        this._error = null;
        try {
            return await elf.act(action, params);
        } catch (e) {
            if (!e.cancelled && e.message !== 'cancelled') this._error = `${failed}: ${e.message}`;
            return null;
        } finally {
            this._busy = null;
            await this._load();
        }
    }

    // ---- drawing ----

    render() {
        const sessions = this._sessions;
        const route = this._route ?? '';
        const current = this._current;
        // An open session is a console that fills the window: none of the page around it.
        if (sessions !== null && current && !route.startsWith('new')) return this._session(current);
        return html`<div class="page">
            <div class="page-top"><div>
                <h1>Sessions</h1>
                <p class="hint">Chat with a coding agent in its own clone of a repo. Continue on any device signed in to your desk.</p>
            </div>${settingsButton()}</div>
            ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
            ${sessions === null ? html`<div class="skeleton" style="height:12rem"></div>` : html`
                ${this._bar(sessions, current, route)}
                ${route.startsWith('new') ? this._newForm(route)
                    : html`<div class="panel empty"><p>${/^s\//.test(route) ? 'That session isn\'t here: it was never started, or it was deleted.'
                        : sessions.length ? 'Pick a session above, or start a new one.'
                        : 'No sessions yet. Start one: pick a repo and say what it\'s for.'}</p>
                        <button class="primary" @click=${() => this._go('new')}>New session</button></div>`}`}
        </div>`;
    }

    /** Every tag in the settings, and any a session still has that the settings no longer list. */
    _allTags(sessions) {
        return [...new Set([...this._tags, ...sessions.flatMap(s => s.tags ?? [])])];
    }

    _setFilter(tag) {
        this._filter = tag;
        elf.store.set('filter', tag).catch(() => {});
    }

    _bar(sessions, current, route) {
        const tags = this._allTags(sessions);
        const filter = tags.includes(this._filter) ? this._filter : '';
        const shown = sessions.filter(s => (this._archived || !s.archived || s === current) && (tagged(s, filter) || s === current));
        const archived = sessions.filter(s => s.archived && tagged(s, filter)).length;
        return html`${tags.length ? html`<div class="filter" role="group" aria-label="Show sessions tagged">
                <button class="sm quiet" aria-pressed=${filter === ''} @click=${() => this._setFilter('')}>All</button>
                ${tags.map(t => html`<button class="sm quiet" aria-pressed=${filter === t} @click=${() => this._setFilter(t)}>${t}</button>`)}
            </div>` : nothing}
            <nav class="bar" aria-label="Sessions">
            ${shown.map(s => html`<a href="#" title=${(s.prompt ?? '').split('\n')[0]} class=${s.archived ? 'archived' : ''}
                aria-current=${s === current ? 'page' : 'false'} @click=${e => { e.preventDefault(); this._go(`s/${s.id}`); }}>
                ${working(s) ? html`<span class="dot" title="Working"></span>` : nothing}<span class="n">${s.name}</span></a>`)}
            <button class=${route.startsWith('new') ? 'primary sm' : 'sm'} @click=${() => this._go('new')}>New session</button>
            ${archived ? html`<button class="quiet sm" @click=${() => { this._archived = !this._archived; }}>
                ${this._archived ? 'Hide archived' : `Show archived (${archived})`}</button>` : nothing}
        </nav>`;
    }

    _newForm(route) {
        // From another elf: new/<elf>/<ref>/<title>[/<session id>], the link, the text to start from, and the id it
        // already keeps on its side of the link.
        const p = route.split('/');
        const link = ELF.test(p[1] ?? '') && REF.test(p[2] ?? '') ? { elf: p[1], ref: p[2], title: fromRoute(p[3]),
            id: SESSION.test(p[4] ?? '') ? p[4] : null } : null;
        const mine = [...new Set((this._sessions ?? []).map(x => x.repo))];
        const repos = [...new Set([...(this._options?.repos ?? []), ...mine])];
        const agents = this._options?.agents ?? [{ id: 'claude', label: 'Claude Code', installed: true, sessions: true }];
        const usable = a => a.installed && a.sessions;
        const chosen = agents.find(a => a.id === this._options?.agent && usable(a)) ?? agents.find(usable);
        return html`<form class="new panel ${this._dragging ? 'dragging' : ''}" @submit=${e => this._create(e, link)}
                @dragover=${e => this._dragOver(e)} @drop=${e => this._drop(e, () => this._newSession(e.currentTarget))}>
            <h2>New session</h2>
            ${link ? html`<p class="hint">Linked to ${link.title || link.ref} (${link.elf}).</p>` : nothing}
            <label>Name <input type="text" name="name" required maxlength="80" .value=${link?.title?.slice(0, 80) ?? ''}
                placeholder="mvnpm search fix"></label>
            <label>Repo <input type="text" name="repo" required maxlength="140" placeholder="owner/name" list="repo-list"
                autocomplete="off" spellcheck="false" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}/[A-Za-z0-9._\\-]{1,100}">
                <span class="field-hint">${repos.length ? 'Type any repo, or pick one from your GitHub board and your sessions.'
                    : 'Type a repo you can read, like owner/name.'}</span></label>
            <datalist id="repo-list">${repos.map(r => html`<option value=${r}></option>`)}</datalist>
            ${this._newRepoForSession()}
            ${this._tags.length ? html`<fieldset class="tagbox"><legend>Tags</legend>${this._tags.map(t => html`<label>
                <input type="checkbox" name="tag" value=${t} ?checked=${t === this._filter}>${t}</label>`)}</fieldset>` : nothing}
            <label>Coding agent <select name="agent" required>
                ${agents.map(a => html`<option value=${a.id} ?disabled=${!usable(a)} ?selected=${a === chosen}>${a.label}${
                    !a.installed ? ' (not installed)' : !a.sessions ? ' (not for sessions yet)' : ''}</option>`)}
                </select>
                <span class="field-hint">The session keeps this agent. Your default is in Settings.</span></label>
            ${this._installable(agents)}
            <label>What it's for <textarea name="prompt" required maxlength="20000"
                placeholder="The first message. It stays pinned above the chat, and the agent gets it with every turn."
                .value=${this._context?.prompt ?? link?.title ?? ''}></textarea>
                ${link && this._context?.prompt ? html`<span class="field-hint">From the ${link.elf === 'todo-list' ? 'todo' : link.elf}: its
                    description, checklist and issues. Change it as you like.</span>` : nothing}</label>
            ${this._newFiles()}
            <p class="hint">The agent works in its own clone of the repo, in the runner's sandbox, with no GitHub credentials:
                it commits there, and nothing is pushed.</p>
            <div class="row">
                <button class="primary" type="submit" ?disabled=${!!this._busy}>${this._busy === 'create' ? spinner : ''}Start</button>
                <button class="quiet" type="button" @click=${() => this._go('')}>Cancel</button>
            </div>
        </form>`;
    }

    /** A new repository to start the session on: created with a README (you confirm in the desk's bar), then picked. */
    _newRepoForSession() {
        const r = this._newRepo?.session === 'new' ? this._newRepo : null;
        const made = this._repoMade;
        return html`<div class="tagbox new-repo">
            ${made ? html`<span class="chip ok">Created ${made}</span>` : nothing}
            ${r ? html`${this._repoForm(r, x => this._createForSession(x), this._busy === 'repo-create' ? 'creating…' : 'create it')}
                <span class="field-hint">A new repository on GitHub, with a README, as ${r.as ?? 'you'}. You confirm in the desk's bar.</span>`
                : html`<button type="button" class="sm quiet" ?disabled=${!!this._busy} @click=${() => this._startNewRepo({ id: 'new' })}>
                    Or create a new repository…</button>`}
        </div>`;
    }

    async _createForSession(x) {
        const repo = await this._act('repo-create', { owner: x.owner, name: x.name, visibility: x.visibility, as: x.as ?? x.owner, init: 'true' },
            'Couldn\'t create it');
        if (!repo?.repo) return;
        this._newRepo = null;
        this._repoMade = repo.repo;
        const box = this.renderRoot.querySelector('form.new input[name=repo]');
        if (box) box.value = repo.repo;
    }

    /**
     * Agents that can run a session but aren't installed here: Install, through the desk (it asks you first and says
     * what it runs), then what's left for you, such as its login.
     */
    _installable(agents) {
        const missing = agents.filter(a => a.sessions && !a.installed);
        const done = this._installed;
        if (!missing.length && !done) return nothing;
        return html`<div class="tagbox">
            ${done ? html`<span class="chip ok">${done.label} installed</span>${done.next ? html`<span class="field-hint">${done.next}</span>` : nothing}` : nothing}
            ${missing.map(a => html`<span class="field-hint">${a.label} isn't installed here.</span>
                <button type="button" class="sm" ?disabled=${!!this._busy} @click=${() => this._installAgent(a)}>
                    ${this._busy === `install:${a.id}` ? spinner : ''}Install ${a.label}</button>`)}
        </div>`;
    }

    async _installAgent(a) {
        this._busy = `install:${a.id}`;
        try {
            const r = await elf.installAgent(a.id);
            this._installed = { label: a.label, next: r?.next ?? '' };
            this._options = null;
            const o = await elf.act('new-options', {}).catch(() => null);
            this._options = o ?? {};
        } catch (e) {
            if (!e.cancelled && e.message !== 'cancelled') this._error = `Couldn't install ${a.label}: ${e.message}`;
        } finally {
            this._busy = null;
        }
    }

    async _create(e, link) {
        e.preventDefault();
        const f = new FormData(e.target);
        const params = { name: String(f.get('name')).trim(), repo: String(f.get('repo')).trim(), prompt: String(f.get('prompt')).trim() };
        if (link) Object.assign(params, { link: `${link.elf}:${link.ref}`, linkTitle: link.title });
        if (link?.id) params.id = link.id;
        if (f.get('agent')) params.agent = String(f.get('agent'));
        const tags = f.getAll('tag').map(String);
        if (tags.length) params.tags = tags.join(',');
        const files = this._files ?? [];
        if (files.some(x => x.status === 'sending')) {
            this._error = 'A file is still on its way: start it again in a moment.';
            return;
        }
        const ready = files.filter(x => x.status === 'ready');
        if (ready.length) params.files = ready.map(x => x.id).join(',');
        const r = await this._act('create', params, 'Couldn\'t start it');
        if (r?.session) this._go(`s/${r.session}`, true);
    }

    // ---- an open session: a console, as close to Claude Code's as a browser page gets ----

    /** The open session, filling the desk's window: its tabs, its numbers and goal, the log (which scrolls), the prompt. */
    _session(s) {
        const busy = working(s);
        return html`<div class="term" style=${this._fillOk ? '' : 'height:720px'}
                @dragover=${e => this._dragOver(e)} @drop=${e => this._drop(e, s)}>
            ${this._dragging ? html`<div class="t-dropzone">Drop to attach<br>images, PDFs, Word and text files</div>` : nothing}
            <header class="t-head">
                ${this._termTabs(s)}
                <div class="t-meta">
                    ${this._editing === 'name' ? html`<form class="t-inline" @submit=${e => this._rename(e, s)}>
                        <input name="name" required maxlength="80" .value=${s.name} aria-label="Name">
                        <button class="t-btn" type="submit">rename</button>
                        <button class="t-btn" type="button" @click=${() => { this._editing = null; }}>cancel</button></form>`
                        : html`<b class="t-name">${s.name}</b>`}
                    <span class="t-dim">${s.repo}</span>
                    ${this._numbers(s)}
                    ${this._tagsOf(s)}
                    ${s.link ? html`<span class="t-dim">linked to <a href="#" @click=${e => { e.preventDefault(); this._openLink(s.link); }}>${s.link.title || s.link.ref}</a>
                        <button class="t-btn" @click=${() => this._act('unlink', { session: s.id }, 'Couldn\'t unlink it')}>unlink</button></span>`
                        : html`<button class="t-btn" @click=${() => this._linkTodo(s)}>link a todo</button>`}
                    <span class="t-grow"></span>
                    ${s.pr ? html`<a href=${s.pr} target="_blank" rel="noopener" title=${s.branch ? `Branch ${s.branch}` : ''}>PR</a>` : nothing}
                    ${this._github ? html`<button class="t-btn" ?disabled=${busy || !!this._busy} title=${busy ? 'When this turn is done' : 'Read the commits, then push them to GitHub'}
                        @click=${() => this._pushPreview(s)}>${this._busy === 'push-preview' ? 'reading…' : 'push'}</button>` : nothing}
                    ${s.terminal ? html`<span class="t-warn" title="house-elves resume: the desk waits until you exit Claude Code there">in a terminal</span>`
                        : (s.agent ?? 'claude') === 'claude' && s.session ? html`<button class="t-btn" ?disabled=${busy}
                        title=${busy ? 'When this turn is done' : 'Carry on in Claude Code in a terminal'}
                        @click=${() => { this._breakout = this._breakout === s.id ? null : s.id; }}>break out</button>` : nothing}
                    ${this._editing ? nothing : html`<button class="t-btn" @click=${() => { this._editing = 'name'; }}>rename</button>`}
                    <button class="t-btn" @click=${() => this._act('archive', { session: s.id, archived: !s.archived }, 'Couldn\'t archive it')}>
                        ${s.archived ? 'unarchive' : 'archive'}</button>
                    <button class="t-btn" ?disabled=${busy || !!this._busy} title=${busy ? 'Stop it first' : 'The desk asks you first'}
                        @click=${() => this._delete(s)}>delete</button>
                </div>
                ${this._error ? html`<div class="t-err" role="alert">⚠ ${this._error} <button class="t-btn" @click=${() => { this._error = null; }}>dismiss</button></div>` : nothing}
            </header>
            ${this._goal(s)}
            <div class="t-log" aria-live="polite" @scroll=${e => { this._stick = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 40; }}>
                ${(s.turns ?? []).map((t, i, all) => html`${this._turn(t, i)}${this._asks(s, t)}${this._pushes(s, t, all[i + 1])}`)}
            </div>
            ${this._pushBox(s, busy)}
            ${this._breakoutBox(s)}
            ${this._compose(s, busy)}
        </div>`;
    }

    /** The command that carries this session on in Claude Code in a terminal, to copy. */
    _breakoutBox(s) {
        if (this._breakout !== s.id || s.terminal) return nothing;
        const cmd = `house-elves resume ${s.id}`;
        const copy = async () => {
            try {
                await navigator.clipboard.writeText(cmd);
                this._copied = true;
            } catch {
                this.renderRoot.querySelector('.t-cmd')?.focus();
                this._copied = false;
            }
        };
        return html`<div class="t-push">
            <div><b>Break out</b> <span class="t-dim">carry this session on in Claude Code in a terminal on this machine:</span></div>
            <div class="t-row"><input class="t-cmd" readonly .value=${cmd} aria-label="The command to run" @focus=${e => e.target.select()}>
                <button class="t-btn t-acc" @click=${copy}>${this._copied ? 'copied' : 'copy'}</button></div>
            <div class="t-dim">It opens in the session's own clone with the whole conversation, as your Claude Code: your login and settings,
                outside the runner's sandbox. The desk waits while it's open; exit Claude Code and the next message here carries on
                from what you did there. Commit there for push.</div>
            <div class="t-row"><button class="t-btn" @click=${() => { this._breakout = null; this._copied = false; }}>close</button></div>
        </div>`;
    }

    // ---- pushing the session's work: read it, then the desk's bar asks, then the runner pushes and a draft PR opens ----

    /** What a push to a new repository would send (it must be yours and empty), or that it isn't on GitHub yet. */
    async _pushPreviewNew(s, target) {
        this._pushed = null;
        this._pushDiff = false;
        const p = await this._act('push-preview', { session: s.id, newRepo: target }, 'Couldn\'t look at it');
        if (p && p.session === s.id) this._push = { ...p, chosen: true };
    }

    /** The owner and name of a new repository, and whether it's private: for a push, or for a new session. */
    _repoForm(r, onSubmit, label) {
        const owners = r.owners ?? [];
        // Not a <form>: it also sits inside the new-session form.
        const go = e => {
            const box = e.target.closest('.repo-form');
            const name = box.querySelector('[name=rname]');
            if (!name.reportValidity()) return;
            this._newRepo = { ...r, owner: box.querySelector('[name=rowner]').value, name: name.value.trim(),
                visibility: box.querySelector('[name=rvis]').value };
            onSubmit(this._newRepo);
        };
        return html`<div class="t-row t-inline repo-form" @keydown=${e => { if (e.key === 'Enter') { e.preventDefault(); go(e); } }}>
            <select class="t-sel" name="rowner" aria-label="Owner">${owners.map(o => html`<option ?selected=${o === r.owner}>${o}</option>`)}</select>
            <span class="t-dim">/</span>
            <input name="rname" class="t-cmd" required maxlength="100" pattern="[A-Za-z0-9._\-]{1,100}" placeholder="new-repo"
                aria-label="Repository name" spellcheck="false" autocomplete="off" .value=${r.name ?? ''}>
            <select class="t-sel" name="rvis" aria-label="Who can see it">
                <option value="private" ?selected=${r.visibility !== 'public'}>private</option>
                <option value="public" ?selected=${r.visibility === 'public'}>public</option></select>
            <button type="button" class="t-btn sm" ?disabled=${!!this._busy} @click=${go}>${label}</button>
        </div>`;
    }

    async _startNewRepo(s) {
        this._newRepo = { session: s.id, owners: [], visibility: 'private' };
        const o = await this._act('repo-owners', {}, 'Couldn\'t read who can own it');
        if (o) this._newRepo = { ...this._newRepo, owners: o.owners ?? [o.as], owner: o.as, as: o.as };
    }

    /** Creates the repository (you confirm in the desk's bar), then looks at the push again. */
    async _createRepo(s, p) {
        const [owner, name] = p.newRepo.split('/');
        const r = await this._act('repo-create', { owner, name, visibility: this._newRepo?.visibility ?? 'private', as: p.as },
            'Couldn\'t create it');
        if (r?.repo) await this._pushPreviewNew(s, r.repo);
    }

    async _pushPreview(s, pr) {
        this._pushed = null;
        this._newRepo = null;
        this._pushDiff = false;
        const prs = this._push?.session === s.id ? this._push.prs : null;
        const p = await this._act('push-preview', { session: s.id, ...(pr ? { pr } : {}) }, 'Couldn\'t read its commits');
        // With open PRs of yours on the repo, where the first push goes is yours to pick, not a default.
        if (p && p.session === s.id) this._push = { ...p, prs: p.prs ?? prs, chosen: pr !== undefined };
        else if (!pr) this._push = null;
    }

    /** Before the first push: a branch of its own and a new draft PR, or one of your open PRs (or any by its number). */
    _pushWhere(s, p, busy) {
        if (p.update || p.already || (p.pr && !p.prNumber)) return nothing;
        const pick = e => {
            const v = e.target.value;
            if (v === 'newrepo') {
                e.target.value = '';
                this._push = { ...p, prs: p.prs, chosen: false, newRepoForm: true };
                this._startNewRepo(s);
                return;
            }
            if (v === 'other') {
                e.target.value = p.prNumber ?? '';
                this._otherPr = true;
                return;
            }
            this._otherPr = false;
            this._pushPreview(s, v === 'new' ? 0 : Number(v));
        };
        const mine = p.prs ?? [];
        return html`<div class="t-row"><span class="t-dim">onto</span>
            <select class="t-sel" aria-label="Where it goes" ?disabled=${busy || !!this._busy} @change=${pick}>
                ${p.chosen || !mine.length ? nothing : html`<option value="" selected disabled>choose where it goes…</option>`}
                <option value="new" ?selected=${p.chosen && !p.prNumber || !mine.length && !p.prNumber}>a new branch and draft PR</option>
                ${mine.map(x => html`<option value=${x.number} ?selected=${p.prNumber === x.number}>PR #${x.number}: ${x.title}</option>`)}
                ${p.prNumber && !mine.some(x => x.number === p.prNumber) ? html`<option value=${p.prNumber} selected>PR #${p.prNumber}: ${p.prTitle}</option>` : nothing}
                <option value="other">another PR, by its number…</option>
                <option value="newrepo">a new repository of yours…</option>
            </select>
            ${this._otherPr ? html`<form class="t-inline" @submit=${e => { e.preventDefault();
                    const n = Number(new FormData(e.target).get('n')); if (n > 0) { this._otherPr = false; this._pushPreview(s, n); } }}>
                <span class="t-dim">#</span><input name="n" class="t-num" inputmode="numeric" pattern="[0-9]{1,7}" aria-label="PR number" autofocus>
                <button class="t-btn">look</button></form>` : nothing}
        </div>`;
    }

    _pushBox(s, busy) {
        const done = this._pushed?.session === s.id ? this._pushed : null;
        if (done) {
            return html`<div class="t-push"><div>✓ Pushed to <b>${done.target}</b>${done.pr ? html` · <a href=${done.pr} target="_blank" rel="noopener">${done.opened ? 'draft PR opened' : 'its PR'}</a>` : ''}
                ${done.note ? html`<span class="t-warn"> ${done.note}</span>` : nothing}
                <button class="t-btn" @click=${() => { this._pushed = null; }}>ok</button></div></div>`;
        }
        const p = this._push?.session === s.id ? this._push : null;
        if (!p) return nothing;
        if (p.unrelated || p.newRepoForm || p.newRepo) return this._pushNewBox(s, p, busy);
        const n = (p.commits ?? []).length;
        const unchosen = !p.update && !p.already && !p.chosen && (p.prs ?? []).length > 0 && !(p.pr && !p.prNumber);
        return html`<div class="t-push">
            ${p.finished ? html`<div class="t-dim">${p.finished}, so this goes to a new branch and PR, or onto one of your open PRs.</div>` : nothing}
            ${this._pushWhere(s, p, busy)}
            ${unchosen ? html`<div class="t-dim">You have open PRs on ${p.repo}: push onto one of them, or to a new branch and draft PR.</div>` : html`
            <div><b>${p.already ? 'Already pushed' : p.update ? 'Update' : 'Push to'}</b> ${p.target}
                ${p.update ? html`<span class="t-dim">(replaces what's there: the session's work is kept as one commit on ${p.base})</span>`
                    : p.prNumber ? html`<span class="t-warn">replaces the ${count(p.replacesCommits, 'commit')} on PR #${p.prNumber} with the session's work, as one commit on ${p.base}</span>`
                    : html`<span class="t-dim">a new branch from ${p.base}, then a draft PR on ${p.repo}</span>`}</div>`}
            ${(p.commits ?? []).map(c => html`<div class="t-dim">${c.sha.slice(0, 7)} <span class="t-ink">${c.subject}</span></div>`)}
            ${p.diffstat ? html`<pre class="t-stat">${p.diffstat.replace(/^(?=\S)/, ' ')}</pre>` : nothing}
            ${this._pushDiff ? html`<pre class="t-diff">${p.patch}${p.patchCut ? '\n… (cut short: see it all on GitHub)' : ''}</pre>` : nothing}
            <div class="t-row">
                ${p.already ? nothing : unchosen ? html`<span class="t-warn">choose where it goes first</span>` : html`<button class="t-btn t-acc" ?disabled=${busy || !!this._busy} @click=${() => this._doPush(s, p)}>
                    ${this._busy === 'push' || this._busy === 'push-done' ? 'pushing…' : `push ${n} commit${n === 1 ? '' : 's'} as ${p.as}`}</button>`}
                ${p.patch ? html`<button class="t-btn" @click=${() => { this._pushDiff = !this._pushDiff; }}>${this._pushDiff ? 'hide the diff' : 'show the diff'}</button>` : nothing}
                ${p.pr ? html`<a href=${p.pr} target="_blank" rel="noopener">${p.prNumber ? `PR #${p.prNumber}` : 'its PR'}</a>` : nothing}
                <button class="t-btn" @click=${() => { this._push = null; this._otherPr = false; }}>${p.already ? 'close' : 'cancel'}</button>
            </div>
        </div>`;
    }

    /**
     * To a new repository: pick it (yours or your organization's), create it if it isn't there, read what goes, push.
     * The session then moves to it.
     */
    _pushNewBox(s, p, busy) {
        const close = html`<button class="t-btn" @click=${() => { this._push = null; this._newRepo = null; }}>cancel</button>`;
        const r = this._newRepo?.session === s.id ? this._newRepo : null;
        if (!p.newRepo) {
            return html`<div class="t-push">
                ${p.unrelated ? html`<div><b>A history of its own</b> <span class="t-dim">the agent's ${count(p.count, 'commit')} share no history with
                    ${p.repo}, so they can't go to a branch there. Push them to a new repository of yours: the session moves there.</span></div>`
                    : html`<div><b>To a new repository</b> <span class="t-dim">the clone's files as one commit, with none of ${p.repo}'s history.
                    The session then moves to it.</span></div>`}
                ${r ? this._repoForm(r, x => this._pushPreviewNew(s, `${x.owner}/${x.name}`), 'look')
                    : html`<div class="t-row"><button class="t-btn t-acc" ?disabled=${busy || !!this._busy} @click=${() => this._startNewRepo(s)}>choose the repository…</button></div>`}
                <div class="t-row">${close}</div></div>`;
        }
        if (p.missing) {
            return html`<div class="t-push">
                <div><b>${p.newRepo}</b> <span class="t-dim">isn't on GitHub yet. Create it (empty, ${this._newRepo?.visibility ?? 'private'}), then push to it.</span></div>
                <div class="t-row"><button class="t-btn t-acc" ?disabled=${busy || !!this._busy} @click=${() => this._createRepo(s, p)}>
                    ${this._busy === 'repo-create' ? 'creating…' : `create ${p.newRepo}`}</button>
                    <button class="t-btn" @click=${() => { this._push = { ...p, newRepo: null, missing: false, newRepoForm: true }; }}>another name</button>
                    ${close}</div></div>`;
        }
        const n = p.count ?? (p.commits ?? []).length;
        return html`<div class="t-push">
            <div><b>Push to the new repository</b> <a href=${p.url} target="_blank" rel="noopener">${p.target}</a>
                <span class="t-dim">${p.squash ? `as one commit: all the clone's files, with none of ${p.repo}'s history`
                    : `the agent's own history, as it is`}${p.private ? ' · private' : ' · public'}. The session then moves to ${p.newRepo}.</span></div>
            ${(p.commits ?? []).slice(-20).map(c => html`<div class="t-dim">${c.sha.slice(0, 7)} <span class="t-ink">${c.subject}</span></div>`)}
            ${(p.commits ?? []).length > 20 ? html`<div class="t-dim">… and ${(p.commits.length - 20)} more before them</div>` : nothing}
            ${p.diffstat ? html`<pre class="t-stat">${p.diffstat}</pre>` : nothing}
            <div class="t-row">
                <button class="t-btn t-acc" ?disabled=${busy || !!this._busy} @click=${() => this._doPushNew(s, p)}>
                    ${this._busy === 'push-new' || this._busy === 'push-done' ? 'pushing…' : `push ${count(n, 'commit')} as ${p.as}`}</button>
                ${close}
            </div></div>`;
    }

    async _doPushNew(s, p) {
        const n = p.count ?? (p.commits ?? []).length;
        const r = await this._act('push-new', { session: s.id, newRepo: p.newRepo, to: p.to, as: p.as, target: p.target,
            commits: `${n} commit${n === 1 ? '' : 's'}` }, 'Couldn\'t push it');
        if (!r?.push) return;
        const x = r.push;
        const done = await this._act('push-done', { session: s.id, to: p.to, status: x.status ?? 0,
            ...(x.error ? { error: String(x.error).slice(0, 4000) } : {}), ...(x.pushed ? { pushed: x.pushed } : {}),
            ...(x.moved ? { moved: x.moved } : {}), ...(x.notMoved ? { notMoved: String(x.notMoved).slice(0, 1000) } : {}) }, 'Couldn\'t push it');
        if (!done) return;
        this._push = null;
        this._newRepo = null;
        this._pushed = { ...done, pr: null };
    }

    async _doPush(s, p) {
        const n = (p.commits ?? []).length;
        const r = await this._act(p.prNumber ? 'push-pr' : 'push', { session: s.id, to: p.to, as: p.as, target: p.target,
            commits: `${n} commit${n === 1 ? '' : 's'}`, ...(p.prNumber ? { pr: p.prNumber } : {}) }, 'Couldn\'t push it');
        if (!r?.push) return; // you said no in the desk's bar, or it was refused (it says why)
        const done = await this._act('push-done', { session: s.id, to: p.to, status: r.push.status ?? 0,
            ...(r.push.error ? { error: String(r.push.error).slice(0, 4000) } : {}) }, 'Couldn\'t push it');
        if (!done) return;
        this._push = null;
        this._pushed = { ...done, opened: !p.pr && !!done.pr };
        this._otherPr = false;
    }

    /** The sessions as a strip of tabs, a tag to show, New and Settings: one line, scrolling sideways when they're many. */
    _termTabs(s) {
        const sessions = this._sessions ?? [];
        const tags = this._allTags(sessions);
        const filter = tags.includes(this._filter) ? this._filter : '';
        const shown = sessions.filter(x => (this._archived || !x.archived || x === s) && (tagged(x, filter) || x === s));
        return html`<nav class="t-tabs" aria-label="Sessions">
            <span class="t-logo">✻</span>
            ${shown.map(x => html`<a href="#" class=${x === s ? 'on' : ''} title=${(x.prompt ?? '').split('\n')[0]}
                aria-current=${x === s ? 'page' : 'false'} @click=${e => { e.preventDefault(); this._go(`s/${x.id}`); }}>
                ${working(x) ? html`<span class="t-spin">✻</span>` : nothing}${x.name}</a>`)}
            <button class="t-btn" @click=${() => this._go('new')}>+ new</button>
            <span class="t-grow"></span>
            ${tags.length ? html`<select class="t-select" aria-label="Show sessions tagged" @change=${e => this._setFilter(e.target.value)}>
                <option value="" ?selected=${filter === ''}>all tags</option>
                ${tags.map(t => html`<option value=${t} ?selected=${filter === t}>${t}</option>`)}</select>` : nothing}
            ${sessions.some(x => x.archived) ? html`<button class="t-btn" @click=${() => { this._archived = !this._archived; }}>
                ${this._archived ? 'hide archived' : 'archived'}</button>` : nothing}
            <button class="t-btn" @click=${() => elf.settings()}>settings</button>
        </nav>`;
    }

    /** Its tags, and tags to change them: the ones in the settings, plus any it has that they no longer list. */
    _tagsOf(s) {
        const mine = s.tags ?? [];
        if (!this._tagging) {
            return html`${mine.map(t => html`<span class="t-tag">#${t}</span>`)}
                ${this._tags.length || mine.length ? html`<button class="t-btn" @click=${() => { this._tagging = true; }}>${mine.length ? 'tags' : 'add tags'}</button>` : nothing}`;
        }
        const choices = [...new Set([...this._tags, ...mine])];
        return html`<form class="t-inline" @submit=${e => this._saveTags(e, s)}>
            ${choices.map(t => html`<label><input type="checkbox" name="tag" value=${t} ?checked=${mine.includes(t)}>${t}</label>`)}
            <button class="t-btn" type="submit">save</button>
            <button class="t-btn" type="button" @click=${() => { this._tagging = false; }}>cancel</button>
        </form>`;
    }

    async _saveTags(e, s) {
        e.preventDefault();
        // The elf accepts only the settings' tags, so one they no longer list comes off when the tags are saved.
        const tags = new FormData(e.target).getAll('tag').map(String).filter(t => this._tags.includes(t));
        this._tagging = false;
        await this._act('tag', { session: s.id, tags: tags.join(',') }, 'Couldn\'t tag it');
    }

    /** The goal: pinned above the log, folded to two lines, the first message as it was sent. */
    _goal(s) {
        const edited = !!s.goal;
        if (this._editing === 'goal') {
            return html`<form class="t-goal" @submit=${e => this._saveGoal(e, s)}>
                <div class="t-dim">goal: the agent gets it with every turn</div>
                <textarea class="t-area" name="goal" required maxlength="20000" rows="4" .value=${s.goal || s.prompt}></textarea>
                <div><button class="t-btn" type="submit">save goal</button>
                    <button class="t-btn" type="button" @click=${() => { this._editing = null; }}>cancel</button></div>
            </form>`;
        }
        return html`<div class="t-goal">
            <div class="t-goal-row"><span class="t-acc">goal</span>${edited ? html`<span class="t-dim">edited ${ago(s.goalEdited)}</span>` : nothing}
                <span class="t-grow"></span>
                <button class="t-btn" @click=${() => { this._goalOpen = !this._goalOpen; }} aria-expanded=${this._goalOpen}>${this._goalOpen ? 'fold' : 'show all'}</button>
                <button class="t-btn" @click=${() => { this._editing = 'goal'; }}>edit</button></div>
            <div class="t-goal-text ${this._goalOpen ? '' : 'folded'}">${s.goal || s.prompt}</div>
            ${edited && this._goalOpen ? html`<details><summary class="t-dim">the first message</summary>
                <div class="t-goal-text">${s.prompt}</div></details>` : nothing}
        </div>`;
    }

    /** The model, then what it has cost, how long it has worked and how full its context is. */
    _numbers(s) {
        const n = totals(s);
        return html`<span class="t-model" title=${n.model ?? ''}>${n.model ? modelName(n.model) : agentName(s.agent)}</span>
            ${n.cost !== null ? html`<span class="t-dim" title="What its turns have cost, at list price">$${n.cost.toFixed(2)}</span>` : nothing}
            ${n.bobcoins !== null ? html`<span class="t-dim">${n.bobcoins.toFixed(2)} Bobcoins</span>` : nothing}
            ${n.ms !== null ? html`<span class="t-dim" title="How long the agent has worked, over all its turns">${took(n.ms)}</span>` : nothing}
            ${n.context !== null ? html`<span class=${n.context >= 80 ? 't-warn' : 't-dim'}
                title="How full the model's context window is after the last turn; a long session gets compacted as it fills">${n.context}% context</span>` : nothing}`;
    }

    /** One of its lines, as Claude Code shows them: ⏺ Tool(what), or ⏺ what it said. */
    _line(text) {
        const tool = /^▸ ([^:]+)(?::\s?(.*))?$/s.exec(text);
        if (tool) {
            return html`<div class="t-line"><span class="t-dot t-green">⏺</span><span><b>${tool[1]}</b>${tool[2] ? html`(<span class="t-dim">${tool[2]}</span>)` : nothing}</span></div>`;
        }
        return html`<div class="t-line"><span class="t-dot">⏺</span><span class="t-said">${text}</span></div>`;
    }

    _turn(t, i) {
        const live = this._live[t.agent];
        const shown = this._lines[t.agent];
        const files = t.files ?? [];
        return html`<div class="t-you"><span class="t-prompt">&gt;</span><div>
                ${t.you ? html`<div class="t-you-text">${t.you}</div>` : nothing}
                ${files.length ? html`<div class="t-files">${files.map((f, k) => f.kind === 'image'
                    ? html`<a class="t-file" href=${elf.imageUrl('attachments', f.file)} target="_blank" rel="noopener">[Image #${k + 1}]<img alt=${f.name} src=${elf.imageUrl('attachments', f.file)}></a>`
                    : html`<span class="t-file">[${f.name}]</span>`)}</div>` : nothing}
            </div></div>
            ${(t.said ?? []).map(m => html`<div class="t-you t-midturn"><span class="t-prompt">&gt;</span><div class="t-you-text">${m.text}</div>
                <span class="t-said-note">sent while it worked</span></div>`)}
            ${t.status === 'running' ? html`
                ${(live?.lines ?? []).slice(-60).map(l => this._line(l))}
                <div class="t-working"><span class="t-spin">✻</span> ${live?.status === 'queued' ? 'Waiting for the runner…'
                    : `Working… (${live?.started ? took(Date.now() - Date.parse(live.started)) : '0s'} · esc to interrupt)`}</div>`
            : html`
                ${shown ? shown.map(l => this._line(l)) : nothing}
                ${t.status === 'done' ? html`<div class="t-line t-reply"><span class="t-dot">⏺</span><div class="md">${markdown(t.reply ?? '')}</div></div>`
                    : t.status === 'stopped' ? html`<div class="t-line t-red"><span class="t-dot">⎿</span><span>Interrupted before it answered. What it changed is still in
                        its clone, but it won't remember this turn.</span></div>`
                    : html`<div class="t-line t-red"><span class="t-dot">⎿</span><span>It didn't answer: ${t.error ?? 'it failed'}</span></div>`}
                <div class="t-turn-foot"><span class="t-dot">⎿</span>
                    <span>${ago(t.finished ?? t.at)}${typeof t.durationMs === 'number' ? ` · took ${took(t.durationMs)}` : ''}${
                        typeof t.cost === 'number' ? ` · $${t.cost.toFixed(2)}` : ''}${
                        typeof t.bobcoins === 'number' ? ` · ${t.bobcoins.toFixed(2)} Bobcoins` : ''}${t.model ? ` · ${modelName(t.model)}` : ''}</span>
                    <button class="t-btn" @click=${() => this._toggleLines(t)}>${shown ? 'hide steps' : 'show steps'}</button></div>`}`;
    }

    /**
     * What the agent asked you to do on GitHub (it can't): a button each. Clicking reads it from GitHub, so you see what
     * it is; then "close it" (or comment, or merge) asks in the desk's bar, as your gh account.
     */
    _asks(s, t) {
        if (!this._github || t.status !== 'done' || !t.asks?.length) return nothing;
        const verb = { close: 'close', comment: 'comment on', merge: 'merge' };
        return html`${t.asks.map((a, k) => {
            const id = `${t.agent}:${k}`;
            const look = this._look?.id === id ? this._look : null;
            if (a.done) {
                return html`<div class="t-line t-green"><span class="t-dot">✓</span><span>${a.done[0].toUpperCase() + a.done.slice(1)} #${a.number}
                    <span class="t-dim">· ${ago(a.at)}</span></span></div>`;
            }
            return html`<div class="t-line t-ask"><span class="t-dot">?</span><div>
                <span>It asks you to <b>${verb[a.kind]} #${a.number}</b>${a.text ? html`, saying: <span class="t-ink">“${a.text}”</span>` : ''}</span>
                ${look ? html`<div class="t-dim">#${a.number} <span class="t-ink">${look.title}</span> · ${look.pr ? 'PR' : 'issue'} by ${look.author} · ${
                        look.merged ? 'merged' : look.state}${look.draft ? ' · draft' : ''}${look.pr && look.state === 'open' && look.mergeable_state ? ` · ${look.mergeable_state}` : ''}
                    · <a href=${look.url} target="_blank" rel="noopener">on GitHub</a></div>
                    <div class="t-row">${look.state === 'open' || a.kind === 'comment'
                        ? html`<button class="t-btn t-acc" ?disabled=${!!this._busy} @click=${() => this._ghDo(s, t, a, look)}>${verb[a.kind]} it as ${look.as}</button>`
                        : html`<span class="t-dim">It's ${look.merged ? 'merged' : 'closed'} already.</span>`}
                        <button class="t-btn" @click=${() => { this._look = null; }}>not now</button></div>`
                    : html` <button class="t-btn" ?disabled=${!!this._busy} @click=${() => this._ghLook(s, id, a)}>${this._busy === 'gh-look' && this._lookingAt === id ? 'reading…' : 'look'}</button>`}
            </div></div>`;
        })}`;
    }

    async _ghLook(s, id, a) {
        this._lookingAt = id;
        const r = await this._act('gh-look', { session: s.id, number: a.number }, `Couldn't read #${a.number}`);
        this._look = r ? { ...r, id } : null;
    }

    async _ghDo(s, t, a, look) {
        const base = { session: s.id, repo: look.repo, number: a.number, as: look.as };
        const values = a.kind === 'close' ? { ...base, ...(a.text ? { comment: a.text } : {}), saying: a.text ? `With the comment: \u201c${a.text.trim()}\u201d` : 'No comment.' }
            : a.kind === 'comment' ? { ...base, comment: a.text }
            : { ...base, sha: look.sha, short: look.sha.slice(0, 7) };
        const r = await this._act(`gh-${a.kind}`, values, `Couldn't ${a.kind} #${a.number}`);
        if (r?.done) this._look = null;
    }

    /** The pushes made after this turn (and before the next): where they went, or why they didn't. */
    _pushes(s, t, next) {
        const from = Date.parse(t.at), to = next ? Date.parse(next.at) : Infinity;
        const list = (s.pushes ?? []).filter(p => Date.parse(p.at) >= from && Date.parse(p.at) < to);
        return list.map(p => html`<div class="t-line ${p.ok ? 't-green' : 't-red'}"><span class="t-dot">${p.ok ? '✓' : '✗'}</span><span>${p.ok
            ? html`Pushed ${p.to.slice(0, 7)} to ${p.target}${p.pr ? html` · <a href=${p.pr} target="_blank" rel="noopener">${prLabel(p.pr)}</a>` : ''}${p.note ? html` <span class="t-warn">${p.note}</span>` : ''}`
            : html`Push of ${p.to.slice(0, 7)} to ${p.target} failed: ${p.error}`} <span class="t-dim">· ${ago(p.at)}</span></span></div>`);
    }

    async _toggleLines(t) {
        if (this._lines[t.agent]) {
            const { [t.agent]: _, ...rest } = this._lines;
            this._lines = rest;
            return;
        }
        const a = await elf.agent(t.agent).catch(() => null);
        this._lines = { ...this._lines, [t.agent]: a?.lines ?? [] };
    }

    /**
     * The prompt, as Claude Code's: type straight in, Enter sends, Ctrl+Enter (or Shift+Enter) starts a new line, Esc
     * stops a working turn. Paste or drop images and text files, or attach them; they go with the message.
     */
    _compose(s, busy) {
        const files = this._files ?? [];
        const hint = suggestion(s, busy);
        const n = totals(s);
        const queue = Array.isArray(s.queued) ? s.queued : [];
        return html`<div class="t-input">
            ${queue.length ? html`<div class="t-queue">${queue.map((m, k) => html`<div><span>&gt;</span>
                <span class="t-qtext">${m.text || ''}${m.files ? ` [${m.files.split(',').length} file${m.files.includes(',') ? 's' : ''}]` : ''}</span>
                ${busy && this._canSay(s) && !m.files ? html`<button class="t-btn" title="It reads it at its next step, without waiting for the turn to end"
                    @click=${() => this._say(s, null, k)}>send now</button>` : nothing}
                <button class="t-btn" title="Take it off" @click=${() => this._act('unqueue', { session: s.id, n: String(k) }, 'Couldn\'t take it off')}>×</button></div>`)}
                <div><span>${busy ? 'queued: sent when it finishes' : 'not sent yet: it goes with your next message'}${busy ? '' : html` · <button class="t-btn" @click=${() => this._send(s, this.renderRoot.querySelector('.t-area'))}>send now</button>`}</span></div>
            </div>` : nothing}
            ${files.length ? html`<div class="t-files">${files.map((f, k) => html`<span class="t-file ${f.status}">
                ${f.kind === 'image' ? `[Image #${k + 1}]` : `[${f.name}]`}${f.status === 'sending' ? ` ${f.sent ?? 0}%` : f.status === 'failed' ? ` ✗ ${f.error}` : ''}
                <button class="t-btn" title="Take it off" @click=${() => { this._files = files.filter(x => x !== f); }}>×</button></span>`)}</div>` : nothing}
            <div class="t-box ${busy ? 'busy' : ''}"><span class="t-prompt">&gt;</span>
                <textarea class="t-area" name="text" rows="1" aria-label="Your message" maxlength="20000" spellcheck="false"
                    placeholder=${busy ? (this._sayNow(s) ? 'Working… type a message: enter sends it now (it reads it at its next step), esc interrupts'
                        : 'Working… type your next message: enter queues it, esc interrupts') : hint ? `${hint}   (tab to use it)` : 'Type a message: enter to send'}
                    @input=${e => { this._grow(e.target); elf.store.set(`draft:${s.id}`, e.target.value).catch(() => {}); }}
                    @keydown=${e => this._key(e, s, busy)} @paste=${e => this._paste(e, s)}></textarea>
                ${typeof elf.listen === 'function' ? html`<button class="t-btn t-mic ${this._listening ? 'on' : ''}" aria-pressed=${!!this._listening}
                    title=${this._listening ? 'Stop listening' : 'Speak your message (the desk listens; it goes in the box, for you to send)'}
                    aria-label=${this._listening ? 'Stop listening' : 'Speak your message'} @click=${() => this._voice(s)}>${this._listening ? '■' : '🎤'}</button>` : nothing}
            </div>
            <div class="t-foot">
                <span>enter to send · ctrl+enter new line ·${suggestion(s, busy) ? ' tab takes the suggestion ·' : ''} paste or drag in any file ·
                    <button class="t-btn" @click=${() => this.renderRoot.querySelector('.t-pick')?.click()}>attach</button>
                    ${busy && this._canSay(s) ? html` · while it works, enter <button class="t-btn" title="Switch: send at once, or queue for when it finishes"
                        @click=${() => this._switchSay()}>${this._sayMode === 'queue' ? 'queues it' : 'sends it now'}</button>` : nothing}
                    ${busy ? html` · <button class="t-btn" @click=${() => this._stop(s)}>esc to interrupt</button>` : nothing}</span>
                <span class="t-grow"></span>
                <span>${n.model ? modelName(n.model) : agentName(s.agent)}${n.context !== null ? html` · <span class=${n.context >= 80 ? 't-warn' : ''}>${100 - n.context}% context left</span>` : ''}</span>
                <input class="t-pick" type="file" multiple hidden @change=${e => { this._addFiles([...e.target.files], s); e.target.value = ''; }}>
            </div>
        </div>`;
    }

    /**
     * Voice: the desk listens (with the browser's speech recognition, or Whisper on its machine, as you chose there)
     * and the words go into the message box as they come, for you to read and send. Clicked again, it stops.
     */
    async _voice(s) {
        if (this._listening) {
            this._listening.stop?.();
            return;
        }
        const box = this.renderRoot.querySelector('.t-area');
        this._listening = { stop: null };
        try {
            const l = await elf.listen(t => {
                if (t.final && box.isConnected) {
                    box.value = box.value && !/\s$/.test(box.value) ? `${box.value} ${t.final}` : box.value + t.final;
                    this._grow(box);
                    elf.store.set(`draft:${s.id}`, box.value).catch(() => {});
                }
                if (t.error) this._error = `Voice: ${t.error}`;
                if (t.done) this._listening = null;
            });
            if (this._listening) this._listening = l;
            box.focus();
        } catch (e) {
            this._listening = null;
            this._error = `Voice: ${e.message}`;
        }
    }

    /** Enter sends; Ctrl+Enter, Shift+Enter or Alt+Enter is a new line; Esc stops a working turn. */
    _key(e, s, busy) {
        if (e.key === 'Escape' && busy) {
            e.preventDefault();
            this._stop(s);
            return;
        }
        // Tab in the empty prompt takes the suggested next message, as in Claude Code; Enter then sends it.
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.target.value) {
            const hint = suggestion(s, busy);
            if (hint) {
                e.preventDefault();
                e.target.value = hint;
                this._grow(e.target);
                elf.store.set(`draft:${s.id}`, hint).catch(() => {});
            }
            return;
        }
        if (e.key !== 'Enter' || e.isComposing) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const a = e.target, at = a.selectionStart;
                a.setRangeText('\n', at, a.selectionEnd, 'end');
                this._grow(a);
            }
            return;
        }
        e.preventDefault();
        // While it works, the message goes at once (it reads it at its next step, as in Claude Code), or is queued
        // for when the turn ends: as you switched it. Files and IBM Bob always wait for the turn to end.
        if (busy && this._sayNow(s) && !(this._files ?? []).length && e.target.value.trim()) this._say(s, e.target);
        else this._send(s, e.target);
    }

    /** Whether it can read a message mid-turn: Claude Code (not IBM Bob). */
    _canSay(s) {
        return (s.agent ?? 'claude') !== 'bob';
    }

    _sayNow(s) {
        return this._sayMode !== 'queue' && this._canSay(s);
    }

    _switchSay() {
        this._sayMode = this._sayMode === 'queue' ? 'now' : 'queue';
        elf.store.set('say-mode', this._sayMode).catch(() => {});
        this.renderRoot.querySelector('.t-area')?.focus();
    }

    /**
     * Sends a message to the working agent at once (box), or one you queued (n): the runner hands it to Claude Code,
     * which reads it at its next step. If the turn ended first, a typed one goes the usual way (as the next turn).
     */
    async _say(s, box, n = null) {
        const t = (s.turns ?? []).find(x => x.status === 'running');
        if (!t) return box ? this._send(s, box) : undefined;
        const text = box ? box.value.trim() : (s.queued?.[n]?.text ?? '').trim();
        let r;
        try {
            r = await elf.act('say', { session: s.id, text, n: n == null ? '' : String(n) });
        } catch (e) {
            // It can't take it now (an older runner, say): a typed one is queued instead, as before.
            if (box) return this._send(s, box);
            this._error = `Couldn't send it now: ${e.message}`;
            return;
        }
        if (r.say?.said) {
            await this._act('said', { session: s.id, agent: t.agent, text, n: n == null ? '' : String(n) }, 'It got it, but it didn\'t show');
            if (box) {
                box.value = '';
                this._grow(box);
                elf.store.set(`draft:${s.id}`, '').catch(() => {});
            }
            this._stick = true;
        } else if (box) {
            // It had just answered: then it's simply your next message.
            await this._send(s, box);
        }
    }

    /** The prompt grows with what you type, up to a third of the window; the log keeps the rest. */
    _grow(a) {
        a.style.height = 'auto';
        a.style.height = `${Math.min(a.scrollHeight, Math.round(window.innerHeight / 3))}px`;
    }

    _stop(s) {
        const t = (s.turns ?? []).find(x => x.status === 'running');
        if (t) elf.cancelAgent(t.agent).catch(e => { this._error = e.message; });
    }

    /** Pasted images (a screenshot) and files become attachments; pasted text goes in as text. */
    _paste(e, s) {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        this._addFiles(files, s);
    }

    /** Files dragged over the console or the New session form: show where they go while they're over it. */
    _dragOver(e) {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this._dragging = true;
        clearTimeout(this._dragTimer);
        this._dragTimer = setTimeout(() => { this._dragging = false; }, 250);
    }

    _drop(e, s) {
        this._dragging = false;
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        this._addFiles(files, typeof s === 'function' ? s() : s);
    }

    /** A new session's first message has no session yet: its files wait under "new", for the agent picked on the form. */
    _newSession(form) {
        return { id: 'new', agent: form?.querySelector('select[name=agent]')?.value || 'claude' };
    }

    _newFiles() {
        const files = this._files ?? [];
        return html`<div class="dropbox">
            <span>Files for the first message: drop any file on the form (others than images, PDFs, Word and text files go in its clone, in .attached/), or
                <button type="button" class="linkish" @click=${() => this.renderRoot.querySelector('.new-pick')?.click()}>choose files</button>.</span>
            ${files.length ? html`<div class="files">${files.map(f => html`<span class="file ${f.status}">${f.name}${
                f.status === 'sending' ? ` ${f.sent ?? 0}%` : f.status === 'failed' ? ` ✗ ${f.error}` : ''}
                <button type="button" title="Take it off" @click=${() => { this._files = files.filter(x => x !== f); }}>×</button></span>`)}</div>` : nothing}
            <input class="new-pick" type="file" multiple hidden
                @change=${e => { this._addFiles([...e.target.files], this._newSession(e.target.form)); e.target.value = ''; }}>
        </div>`;
    }

    /** Each file starts going to the elf at once (in parts), so it's ready by the time you send. */
    _addFiles(list, s) {
        for (const file of list) {
            const kind = kindOf(file);
            if (kind === 'doc') {
                this._error = `${file.name} is an old Word file (.doc): save it as .docx, or as a PDF, and attach that.`;
                continue;
            }
            const f = { name: file.name || (kind === 'image' ? 'image' : 'file'), kind, status: 'sending', sent: 0 };
            if (s.agent === 'bob' && (kind === 'image' || kind === 'pdf')) {
                this._error = 'IBM Bob isn\'t shown images or PDFs: attach text or Word files.';
                continue;
            }
            if ((this._files ?? []).length >= MAX_FILES) {
                this._error = `A message takes at most ${MAX_FILES} files.`;
                break;
            }
            this._files = [...(this._files ?? []), f];
            this._upload(file, f, s.id).catch(err => {
                f.status = 'failed';
                f.error = err.message;
                this._files = [...this._files];
            });
        }
    }

    async _upload(file, f, session) {
        let data;
        if (f.kind === 'image') data = await fit(file);
        else if (f.kind === 'pdf' || f.kind === 'docx') {
            if (file.size > MAX_DOCUMENT_BYTES) throw new Error('bigger than 3 MB');
            data = await dataUrl(file, f.kind === 'pdf' ? 'application/pdf' : DOCX);
        } else if (f.kind === 'text') {
            // Text too long for a message, or not text after all, goes into its clone as a file instead.
            const text = file.size <= MAX_DOC_BYTES ? await file.text() : null;
            if (text == null || text.includes('\u0000')) f.kind = 'file';
            else data = text;
        }
        if (f.kind === 'file') {
            if (file.size > MAX_ATTACH_BYTES) throw new Error('bigger than 50 MB');
            data = await dataUrl(file, 'application/octet-stream');
        }
        let id = '';
        for (let at = 0; at < Math.max(1, data.length); at += PART) {
            const done = at + PART >= data.length;
            const r = await elf.act('attach', { session, ...(id ? { file: id } : {}), kind: f.kind, name: f.name.slice(0, 120), data: data.slice(at, at + PART), done });
            id = r.id;
            // A big file takes a while (the desk takes 60 KB at a time): its chip says how far it is.
            f.sent = Math.min(100, Math.round((at + PART) / data.length * 100));
            this._files = [...this._files];
        }
        f.id = id;
        f.status = 'ready';
        this._files = [...this._files];
    }

    firstUpdated() {
        // A file the agent named in its reply downloads on a click (elf.download): the desk fetches it from the
        // session's clone and your browser saves it.
        this.renderRoot.addEventListener('click', e => {
            const a = e.target.closest?.('a.t-dl');
            if (!a) return;
            e.preventDefault();
            this._download(a);
        });
    }

    async _download(a) {
        const s = this._current;
        if (!s || a.classList.contains('busy')) return;
        if (typeof elf.download !== 'function') {
            a.classList.add('failed');
            a.title = 'Downloading needs a newer Elf Desk: update it in Settings';
            return;
        }
        a.classList.remove('failed');
        a.classList.add('busy');
        a.title = 'Getting it from the session\'s clone…';
        try {
            const r = await elf.download(s.repo, s.id, a.dataset.path);
            a.title = `Downloaded ${r?.name ?? ''}${r?.size != null ? ` (${size(r.size)})` : ''}`;
        } catch (err) {
            if (!err.cancelled) {
                a.classList.add('failed');
                a.title = err.message;
                this._error = err.message;
            }
        } finally {
            a.classList.remove('busy');
        }
    }

    /** The paths in the agent's replies that are files in this session's clone, as links that download them. */
    _fileLinks() {
        const s = this._current;
        if (!s?.id) return;
        for (const md of this.renderRoot.querySelectorAll('.t-reply .md')) {
            if (md._linked === md.innerHTML) continue;
            linkFiles(md, s.id);
            md._linked = md.innerHTML;
        }
    }

    async updated(changed) {
        this._fileLinks();
        // The open session fills the desk's window; the list and the New session form grow with their content.
        const filling = !!this._current && !(this._route ?? '').startsWith('new');
        if (filling !== this._filling) {
            this._filling = filling;
            this._fillOk = typeof elf.fill === 'function';
            if (this._fillOk) elf.fill(filling).catch(() => { this._fillOk = false; });
            this.requestUpdate();
        }
        // An unsent message is kept per browser (not shared between devices), and put back when the session opens.
        if (changed.has('_route') || (changed.has('_sessions') && changed.get('_sessions') === null)) {
            const s = this._current;
            const box = this.renderRoot.querySelector('.t-input textarea');
            if (s && box) {
                box.value = (await elf.store.get(`draft:${s.id}`).catch(() => '')) ?? '';
                this._grow(box);
                box.focus();
            }
            this._files = [];
            this._stick = true;
        }
        // The log follows what's new, unless you scrolled up to read.
        const log = this.renderRoot.querySelector('.t-log');
        if (log && this._stick !== false) log.scrollTop = log.scrollHeight;
    }

    async _send(s, box) {
        const files = this._files ?? [];
        if (files.some(f => f.status === 'sending')) {
            this._error = 'A file is still on its way: send again in a moment.';
            return;
        }
        const ready = files.filter(f => f.status === 'ready');
        const text = box.value.trim();
        // "push" (please push, push it…) is for the desk, not the agent, which can't: it opens the push box instead.
        if (this._github && !ready.length && PUSH_ASK.test(text) && !working(s)) {
            box.value = '';
            this._grow(box);
            elf.store.set(`draft:${s.id}`, '').catch(() => {});
            await this._pushPreview(s);
            return;
        }
        if (!text && !ready.length && !s.queued?.length) return;
        const r = await this._act('send', { session: s.id, text: text || (ready.length ? 'See the attached files.' : ''), ...(ready.length ? { files: ready.map(f => f.id).join(',') } : {}) }, 'Couldn\'t send it');
        if (r) {
            box.value = '';
            this._grow(box);
            this._files = [];
            this._stick = true;
            elf.store.set(`draft:${s.id}`, '').catch(() => {});
        }
    }

    async _rename(e, s) {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        this._editing = null;
        if (name && name !== s.name) await this._act('rename', { session: s.id, name }, 'Couldn\'t rename it');
    }

    async _saveGoal(e, s) {
        e.preventDefault();
        const goal = new FormData(e.target).get('goal').trim();
        this._editing = null;
        if (goal) await this._act('edit-goal', { session: s.id, goal }, 'Couldn\'t save the goal');
    }

    /**
     * The desk's bar asks you first; then the session goes (refused while it works), then its clone. Cancel in the bar
     * leaves both as they were.
     */
    async _delete(s) {
        this._busy = 'delete';
        try {
            const r = await this._act('delete', { session: s.id, name: s.name }, 'Couldn\'t delete it');
            if (!r) return;
            try {
                await elf.removeSlot(s.repo, s.id);
            } catch (e) {
                this._error = `Deleted, but its clone stays on this machine: ${e.message}`;
            }
            this._go('', true);
        } finally {
            this._busy = null;
        }
    }

    /** The Todo list picks a todo and comes back here with link/<id>/todo-list/<todo>/<title>. */
    async _linkTodo(s) {
        try {
            await elf.openElf('todo-list', `pick-session/${s.id}`);
        } catch {
            this._error = 'Add the Todo list elf (the + after the tabs) to link a session to a todo.';
        }
    }

    async _openLink(link) {
        try {
            await elf.openElf(link.elf, `todo/${link.ref}`);
        } catch {
            this._error = `${link.elf} isn't on your desk any more.`;
        }
    }
}

/** The dashboard card: how many sessions, and which are working. */
class SessionsCard extends LitElement {
    static properties = { _sessions: { state: true } };
    static styles = [shared, cardStyles];

    connectedCallback() {
        super.connectedCallback();
        this._load();
        this._off = elf.onChange(() => this._load());
    }

    disconnectedCallback() {
        this._off?.();
        super.disconnectedCallback();
    }

    async _load() {
        this._sessions = (await loadSessions().catch(() => [])).filter(s => !s.archived);
        elf.card({ attention: false });
    }

    render() {
        if (!this._sessions) return html`<div class="skeleton say-sk"></div>`;
        const busy = this._sessions.filter(working).length;
        return html`<p class="say">${this._sessions.length
            ? `${count(this._sessions.length, 'session')}${busy ? `, ${busy} working` : ''}.`
            : 'No sessions yet: start one on its tab.'}</p>`;
    }
}

customElements.define('sessions-tab', SessionsTab);
customElements.define('sessions-card', SessionsCard);

/**
 * The top of its Settings pop-up: variables every session's agent has for the commands it runs (an API key for what
 * it builds, say). Values go in once and are never shown again: the elf only ever answers with their names.
 */
class SessionsVars extends LitElement {
    static properties = { _names: { state: true }, _busy: { state: true }, _error: { state: true }, _said: { state: true } };

    static styles = [shared, css`
        :host { display: block; margin-bottom: 28px; }
        section { display: grid; gap: 10px; }
        h2 { font-size: 18px; font-weight: 600; margin: 0; }
        .hint { font-size: 13px; color: var(--muted); margin: 0; max-width: 44rem; }
        ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        li { display: flex; gap: 12px; align-items: center; }
        li code { font-family: var(--font-code); font-weight: 500; overflow-wrap: anywhere; }
        li .set { font-size: 13px; color: var(--muted); }
        li .spacer { flex: 1; }
        form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto; gap: 8px; align-items: end; }
        label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
        input { width: 100%; box-sizing: border-box; }
        input[name="name"] { font-family: var(--font-code); text-transform: uppercase; }
        .note { font-size: 13px; color: var(--muted); margin: 0; }
        .error { margin: 0; }
        @media (max-width: 560px) { form { grid-template-columns: 1fr; } }
    `];

    async connectedCallback() {
        super.connectedCallback();
        await this._act('vars');
    }

    async _act(action, params = {}) {
        this._error = null;
        this._busy = action;
        try {
            const r = await elf.act(action, params);
            if (Array.isArray(r?.vars)) this._names = r.vars;
            return r;
        } catch (e) {
            if (e.message !== 'cancelled') this._error = e.message;
            this._names ??= [];
            return null;
        } finally {
            this._busy = null;
        }
    }

    async _add(e) {
        e.preventDefault();
        const form = e.target;
        const name = form.elements.namedItem('name').value.trim().toUpperCase(), value = form.elements.namedItem('value').value;
        if (!name || !value) return;
        const had = this._names?.includes(name);
        this._said = null;
        if (await this._act('var-set', { name, value })) {
            form.reset();
            this._said = had ? `Changed ${name}.` : `Added ${name}. Sessions get it from their next message.`;
        }
    }

    render() {
        const names = this._names;
        return html`<section aria-labelledby="vars-h">
            <h2 id="vars-h">Session variables</h2>
            <p class="hint">Every session's agent is told their names, and the commands it runs have them, like
                <code>ANTHROPIC_API_KEY</code> for an app it builds and tests. Claude Code itself doesn't run with them. They stay on this
                machine, and once added, only their names show here.</p>
            ${names === undefined ? html`<p class="note">${spinner} Reading them…</p>`
                : names.length ? html`<ul>${names.map(n => html`<li><code>${n}</code><span class="set">set</span><span class="spacer"></span>
                    <button ?disabled=${!!this._busy} @click=${async () => { this._said = null; if (await this._act('var-remove', { name: n })) this._said = `Removed ${n}.`; }}
                        aria-label="Remove ${n}">Remove</button></li>`)}</ul>`
                : html`<p class="note">None yet.</p>`}
            <form @submit=${this._add} autocomplete="off">
                <label>Name<input name="name" type="text" required pattern="[A-Za-z_][A-Za-z0-9_]{0,63}" maxlength="64" placeholder="ANTHROPIC_API_KEY"
                    spellcheck="false"></label>
                <label>Value<input name="value" type="password" required maxlength="8192" autocomplete="new-password"></label>
                <button class="primary" ?disabled=${!!this._busy}>${this._busy === 'var-set' ? 'Saving…' : 'Add'}</button>
            </form>
            <p class="note">Adding a name that's there already changes its value.</p>
            ${this._said ? html`<p class="note" role="status">${this._said}</p>` : ''}
            ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : ''}
        </section>`;
    }
}

customElements.define('sessions-vars', SessionsVars);
document.body.append(document.createElement(elf.view === 'settings' ? 'sessions-vars'
    : elf.view === 'card' ? 'sessions-card' : 'sessions-tab'));
