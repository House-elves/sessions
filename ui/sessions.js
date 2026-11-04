// Sessions' tab on Elf Desk: one sub-tab per session, its goal pinned above the chat, and the agent's live lines while
// it works. It runs in the desk's sandboxed frame: everything goes through `elf`, and only what elf.yaml declares.
// Sessions live on the host (~/.config/sessions), so every device signed in to the desk sees the same ones.
import {
    LitElement, html, css, nothing, shared, cardStyles, markdown, markdownStyles, spinner, ago, count, settingsButton,
    Ticking, elf,
} from '/elf-kit/1/kit.js';

const SESSION = /^s[0-9]{10,16}$/;
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
const settingsTags = values => [...new Set((values?.TAGS ?? '').split(',').map(t => t.trim()).filter(Boolean))];
const tagged = (s, tag) => !tag || (s.tags ?? []).includes(tag);

class SessionsTab extends LitElement {
    static properties = {
        _sessions: { state: true }, _route: { state: true }, _error: { state: true }, _live: { state: true },
        _busy: { state: true }, _goalOpen: { state: true }, _editing: { state: true }, _archived: { state: true },
        _lines: { state: true }, _confirmDelete: { state: true }, _tags: { state: true }, _filter: { state: true },
        _tagging: { state: true }, _options: { state: true }, _installed: { state: true }, _context: { state: true },
        _files: { state: true }, _fillOk: { state: true },
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
        .t-file { color: var(--t-acc); position: relative; text-decoration: none; }
        .t-file.failed { color: var(--t-red); }
        .t-file.sending { color: var(--t-dim); }
        .t-file img { display: none; position: absolute; left: 0; bottom: 1.6em; max-width: 280px; max-height: 200px;
            border: 1px solid var(--t-line); border-radius: 6px; background: #fff; z-index: 2; }
        .t-file:hover img { display: block; }
        .t-input { padding: 6px 12px 8px; display: grid; gap: 4px; }
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
            this._error = null;
        } catch (e) {
            this._error = e.message;
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
        return html`<form class="new panel" @submit=${e => this._create(e, link)}>
            <h2>New session</h2>
            ${link ? html`<p class="hint">Linked to ${link.title || link.ref} (${link.elf}).</p>` : nothing}
            <label>Name <input type="text" name="name" required maxlength="80" .value=${link?.title?.slice(0, 80) ?? ''}
                placeholder="mvnpm search fix"></label>
            <label>Repo <input type="text" name="repo" required maxlength="140" placeholder="owner/name" list="repo-list"
                autocomplete="off" spellcheck="false" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}/[A-Za-z0-9._\\-]{1,100}">
                <span class="field-hint">${repos.length ? 'Type any repo, or pick one from your GitHub board and your sessions.'
                    : 'Type a repo you can read, like owner/name.'}</span></label>
            <datalist id="repo-list">${repos.map(r => html`<option value=${r}></option>`)}</datalist>
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
            <p class="hint">The agent works in its own clone of the repo, in the runner's sandbox, with no GitHub credentials:
                it commits there, and nothing is pushed.</p>
            <div class="row">
                <button class="primary" type="submit" ?disabled=${!!this._busy}>${this._busy === 'create' ? spinner : ''}Start</button>
                <button class="quiet" type="button" @click=${() => this._go('')}>Cancel</button>
            </div>
        </form>`;
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
        const r = await this._act('create', params, 'Couldn\'t start it');
        if (r?.session) this._go(`s/${r.session}`, true);
    }

    // ---- an open session: a console, as close to Claude Code's as a browser page gets ----

    /** The open session, filling the desk's window: its tabs, its numbers and goal, the log (which scrolls), the prompt. */
    _session(s) {
        const busy = working(s);
        return html`<div class="term" style=${this._fillOk ? '' : 'height:720px'}
                @dragover=${e => { e.preventDefault(); }} @drop=${e => this._drop(e, s)}>
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
                    ${this._editing ? nothing : html`<button class="t-btn" @click=${() => { this._editing = 'name'; }}>rename</button>`}
                    <button class="t-btn" @click=${() => this._act('archive', { session: s.id, archived: !s.archived }, 'Couldn\'t archive it')}>
                        ${s.archived ? 'unarchive' : 'archive'}</button>
                    ${this._confirmDelete ? html`<span class="t-warn">delete it, with its clone?
                        <button class="t-btn t-red" ?disabled=${busy || !!this._busy} @click=${() => this._delete(s)}>yes, delete</button>
                        <button class="t-btn" @click=${() => { this._confirmDelete = false; }}>keep it</button></span>`
                        : html`<button class="t-btn" ?disabled=${busy} title=${busy ? 'Stop it first' : ''} @click=${() => { this._confirmDelete = true; }}>delete</button>`}
                </div>
                ${this._error ? html`<div class="t-err" role="alert">⚠ ${this._error} <button class="t-btn" @click=${() => { this._error = null; }}>dismiss</button></div>` : nothing}
            </header>
            ${this._goal(s)}
            <div class="t-log" aria-live="polite" @scroll=${e => { this._stick = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 40; }}>
                ${(s.turns ?? []).map((t, i) => this._turn(t, i))}
            </div>
            ${this._compose(s, busy)}
        </div>`;
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
        const n = totals(s);
        return html`<div class="t-input">
            ${files.length ? html`<div class="t-files">${files.map((f, k) => html`<span class="t-file ${f.status}">
                ${f.kind === 'image' ? `[Image #${k + 1}]` : `[${f.name}]`}${f.status === 'sending' ? ' …' : f.status === 'failed' ? ` ✗ ${f.error}` : ''}
                <button class="t-btn" title="Take it off" @click=${() => { this._files = files.filter(x => x !== f); }}>×</button></span>`)}</div>` : nothing}
            <div class="t-box ${busy ? 'busy' : ''}"><span class="t-prompt">&gt;</span>
                <textarea class="t-area" name="text" rows="1" aria-label="Your message" maxlength="20000" spellcheck="false"
                    placeholder=${busy ? 'Working… type your next message; esc to interrupt' : 'Type a message: enter to send'}
                    @input=${e => { this._grow(e.target); elf.store.set(`draft:${s.id}`, e.target.value).catch(() => {}); }}
                    @keydown=${e => this._key(e, s, busy)} @paste=${e => this._paste(e, s)}></textarea>
            </div>
            <div class="t-foot">
                <span>enter to send · ctrl+enter new line · paste or drop images and text files ·
                    <button class="t-btn" @click=${() => this.renderRoot.querySelector('.t-pick')?.click()}>attach</button>
                    ${busy ? html` · <button class="t-btn" @click=${() => this._stop(s)}>esc to interrupt</button>` : nothing}</span>
                <span class="t-grow"></span>
                <span>${n.model ? modelName(n.model) : agentName(s.agent)}${n.context !== null ? html` · <span class=${n.context >= 80 ? 't-warn' : ''}>${100 - n.context}% context left</span>` : ''}</span>
                <input class="t-pick" type="file" multiple hidden @change=${e => { this._addFiles([...e.target.files], s); e.target.value = ''; }}>
            </div>
        </div>`;
    }

    /** Enter sends; Ctrl+Enter, Shift+Enter or Alt+Enter is a new line; Esc stops a working turn. */
    _key(e, s, busy) {
        if (e.key === 'Escape' && busy) {
            e.preventDefault();
            this._stop(s);
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
        if (busy) {
            this._error = 'It\'s still working on your last message: wait for it, or press esc to interrupt it.';
            return;
        }
        this._send(s, e.target);
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

    _drop(e, s) {
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        this._addFiles(files, s);
    }

    /** Each file starts going to the elf at once (in parts), so it's ready by the time you send. */
    _addFiles(list, s) {
        for (const file of list) {
            const f = { name: file.name || (file.type.startsWith('image/') ? 'image' : 'file'),
                kind: file.type.startsWith('image/') ? 'image' : 'text', status: 'sending' };
            if (s.agent === 'bob' && f.kind === 'image') {
                this._error = 'IBM Bob isn\'t shown images: attach text files only.';
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
        else {
            if (file.size > MAX_DOC_BYTES) throw new Error('too long to put in a message');
            data = await file.text();
            if (data.includes('\u0000')) throw new Error('not a text file (PDF and Word aren\'t supported yet)');
        }
        let id = '';
        for (let at = 0; at < Math.max(1, data.length); at += PART) {
            const done = at + PART >= data.length;
            const r = await elf.act('attach', { session, ...(id ? { file: id } : {}), kind: f.kind, name: f.name.slice(0, 120), data: data.slice(at, at + PART), done });
            id = r.id;
        }
        f.id = id;
        f.status = 'ready';
        this._files = [...this._files];
    }

    async updated(changed) {
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
        if (!text && !ready.length) return;
        const r = await this._act('send', { session: s.id, text: text || 'See the attached files.', ...(ready.length ? { files: ready.map(f => f.id).join(',') } : {}) }, 'Couldn\'t send it');
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

    /** Its clone goes first (the runner refuses while it works there), then the session. */
    async _delete(s) {
        this._busy = 'delete';
        try {
            await elf.removeSlot(s.repo, s.id);
        } catch (e) {
            this._error = `Couldn't remove its clone: ${e.message}`;
            this._busy = null;
            return;
        }
        this._busy = null;
        const r = await this._act('delete', { session: s.id, name: s.name }, 'Couldn\'t delete it');
        if (r) this._go('', true);
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
document.body.append(document.createElement(elf.view === 'card' ? 'sessions-card' : 'sessions-tab'));
