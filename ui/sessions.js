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
        return html`<div class="page">
            <div class="page-top"><div>
                <h1>Sessions</h1>
                <p class="hint">Chat with a coding agent in its own clone of a repo. Continue on any device signed in to your desk.</p>
            </div>${settingsButton()}</div>
            ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
            ${sessions === null ? html`<div class="skeleton" style="height:12rem"></div>` : html`
                ${this._bar(sessions, current, route)}
                ${route.startsWith('new') ? this._newForm(route)
                    : current ? this._session(current)
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

    _session(s) {
        const turns = s.turns ?? [];
        const busy = working(s);
        const chatHeight = Math.max(360, (window.screen?.availHeight || 900) - 360);
        return html`<section aria-label=${s.name}>
            <div class="head">
                ${this._editing === 'name' ? html`<form class="row" @submit=${e => this._rename(e, s)}>
                    <input type="text" name="name" required maxlength="80" .value=${s.name} aria-label="Name">
                    <button class="sm primary" type="submit">Rename</button>
                    <button class="sm quiet" type="button" @click=${() => { this._editing = null; }}>Cancel</button></form>`
                    : html`<h2>${s.name}</h2>`}
                <div class="row">
                    ${this._editing ? nothing : html`<button class="sm quiet" @click=${() => { this._editing = 'name'; }}>Rename</button>`}
                    <button class="sm quiet" @click=${() => this._act('archive', { session: s.id, archived: !s.archived }, 'Couldn\'t archive it')}>
                        ${s.archived ? 'Unarchive' : 'Archive'}</button>
                    ${this._confirmDelete ? html`<span class="confirm">Delete it, with its clone?
                        <button class="sm danger" ?disabled=${busy || !!this._busy} @click=${() => this._delete(s)}>${this._busy === 'delete' ? spinner : ''}Delete</button>
                        <button class="sm quiet" @click=${() => { this._confirmDelete = false; }}>Keep it</button></span>`
                        : html`<button class="sm quiet danger" ?disabled=${busy} title=${busy ? 'Stop it first' : ''}
                            @click=${() => { this._confirmDelete = true; }}>Delete</button>`}
                </div>
            </div>
            <div class="meta">
                <span>${s.repo}</span>${this._numbers(s)}<span>Started ${ago(s.created)}</span>
                ${this._tagsOf(s)}
                ${s.link ? html`<span>Linked to <a href="#" @click=${e => { e.preventDefault(); this._openLink(s.link); }}>${s.link.title || s.link.ref}</a>
                    <button class="sm quiet" @click=${() => this._act('unlink', { session: s.id }, 'Couldn\'t unlink it')}>Unlink</button></span>`
                    : html`<button class="sm quiet" @click=${() => this._linkTodo(s)}>Link a todo</button>`}
            </div>
            ${this._goal(s)}
            <div class="chat" style="height:${chatHeight}px" aria-live="polite">
                ${turns.map(t => this._turn(t))}
            </div>
            ${this._compose(s, busy)}
        </section>`;
    }

    /** Its tags as chips, and Tags to change them: the ones in the settings, plus any it has that they no longer list. */
    _tagsOf(s) {
        const mine = s.tags ?? [];
        if (!this._tagging) {
            return html`<span class="chips">${mine.map(t => html`<span class="chip">${t}</span>`)}
                ${this._tags.length || mine.length ? html`<button class="sm quiet" @click=${() => { this._tagging = true; }}>${mine.length ? 'Tags' : 'Add tags'}</button>` : nothing}</span>`;
        }
        const choices = [...new Set([...this._tags, ...mine])];
        return html`<form class="tagbox" @submit=${e => this._saveTags(e, s)}>
            ${choices.map(t => html`<label><input type="checkbox" name="tag" value=${t} ?checked=${mine.includes(t)}
                ?disabled=${!this._tags.includes(t) && !mine.includes(t)}>${t}</label>`)}
            <button class="sm primary" type="submit">Save tags</button>
            <button class="sm quiet" type="button" @click=${() => { this._tagging = false; }}>Cancel</button>
            ${!this._tags.length ? html`<span class="hint">Set the tags you use in Settings.</span>` : nothing}
        </form>`;
    }

    async _saveTags(e, s) {
        e.preventDefault();
        // The elf accepts only the settings' tags, so one they no longer list comes off when the tags are saved.
        const tags = new FormData(e.target).getAll('tag').map(String).filter(t => this._tags.includes(t));
        this._tagging = false;
        await this._act('tag', { session: s.id, tags: tags.join(',') }, 'Couldn\'t tag it');
    }

    /** The goal: pinned above the chat, folded to three lines, the first message as it was sent. */
    _goal(s) {
        const edited = !!s.goal;
        if (this._editing === 'goal') {
            return html`<form class="goal compose" @submit=${e => this._saveGoal(e, s)}>
                <div class="label">The session's goal: the agent gets it with every turn</div>
                <textarea name="goal" required maxlength="20000" .value=${s.goal || s.prompt}></textarea>
                <div class="row"><button class="sm primary" type="submit">Save goal</button>
                    <button class="sm quiet" type="button" @click=${() => { this._editing = null; }}>Cancel</button></div>
            </form>`;
        }
        return html`<div class="goal">
            <div class="label"><span>${edited ? html`Goal, edited ${ago(s.goalEdited)}` : 'Goal: the first message'}</span>
                <span class="row">
                    <button class="sm quiet" @click=${() => { this._goalOpen = !this._goalOpen; }} aria-expanded=${this._goalOpen}>
                        ${this._goalOpen ? 'Fold' : 'Show all'}</button>
                    <button class="sm quiet" @click=${() => { this._editing = 'goal'; }}>Edit goal</button>
                </span></div>
            <div class="text ${this._goalOpen ? '' : 'folded'}">${s.goal || s.prompt}</div>
            ${edited && this._goalOpen ? html`<details><summary class="when">The first message</summary>
                <div class="text">${s.prompt}</div></details>` : nothing}
        </div>`;
    }

    /** The model, then what it has cost, how long it has worked and how full its context is. */
    _numbers(s) {
        const n = totals(s);
        return html`<span title=${n.model ?? ''}>${n.model ? modelName(n.model) : agentName(s.agent)}</span>
            ${n.cost !== null ? html`<span title="What its turns have cost, at list price">$${n.cost.toFixed(2)}</span>` : nothing}
            ${n.bobcoins !== null ? html`<span>${n.bobcoins.toFixed(2)} Bobcoins</span>` : nothing}
            ${n.ms !== null ? html`<span title="How long the agent has worked, over all its turns">${took(n.ms)} working</span>` : nothing}
            ${n.context !== null ? html`<span class=${n.context >= 80 ? 'chip warn' : ''}
                title="How full the model's context window is after the last turn; a long session gets compacted as it fills">${n.context}% context</span>` : nothing}`;
    }

    _turn(t) {
        const live = this._live[t.agent];
        const shown = this._lines[t.agent];
        return html`<div class="you">${t.you}</div>
            <div class="agent">
                ${t.status === 'running' ? html`<div class="row">${spinner}<span>${live?.status === 'queued' ? 'Waiting for the runner…'
                        : `Working${live?.started ? `, ${took(Date.now() - Date.parse(live.started))}` : ''}…`}</span>
                        <button class="sm quiet" @click=${() => elf.cancelAgent(t.agent).catch(e => { this._error = e.message; })}>Stop</button></div>
                    ${live?.lines?.length ? html`<div class="lines">${live.lines.slice(-40).join('\n')}</div>` : nothing}`
                : t.status === 'done' ? html`<div class="md">${markdown(t.reply ?? '')}</div>`
                : t.status === 'stopped' ? html`<p class="hint">Stopped before it answered. What it changed is still in its clone, but
                    it won't remember this turn.</p>`
                : html`<p class="error">It didn't answer: ${t.error ?? 'it failed'}</p>`}
                ${t.status !== 'running' ? html`<div class="row when">
                    <span>${ago(t.finished ?? t.at)}${typeof t.durationMs === 'number' ? ` · took ${took(t.durationMs)}` : ''}${
                        typeof t.cost === 'number' ? ` · $${t.cost.toFixed(2)}` : ''}${
                        typeof t.bobcoins === 'number' ? ` · ${t.bobcoins.toFixed(2)} Bobcoins` : ''}${
                        t.model ? ` · ${modelName(t.model)}` : ''}</span>
                    <button class="sm quiet" @click=${() => this._toggleLines(t)}>${shown ? 'Hide what it did' : 'What it did'}</button></div>
                    ${shown ? html`<div class="lines">${shown.length ? shown.join('\n') : 'Nothing kept.'}</div>` : nothing}` : nothing}
            </div>`;
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

    _compose(s, busy) {
        return html`<form class="compose" @submit=${e => this._send(e, s)}>
            <textarea name="text" aria-label="Your message" maxlength="20000" ?disabled=${busy}
                placeholder=${busy ? 'It\'s working on your last message…' : 'Your next message (Ctrl+Enter sends)'}
                @input=${e => elf.store.set(`draft:${s.id}`, e.target.value).catch(() => {})}
                @keydown=${e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.target.form.requestSubmit(); } }}></textarea>
            <div class="row"><button class="primary" type="submit" ?disabled=${busy || !!this._busy}>${this._busy === 'send' ? spinner : ''}Send</button></div>
        </form>`;
    }

    async updated(changed) {
        // An unsent message is kept per browser (not shared between devices), and put back when the session opens.
        if (changed.has('_route') || (changed.has('_sessions') && changed.get('_sessions') === null)) {
            const s = this._current;
            const box = this.renderRoot.querySelector('.compose textarea[name="text"]');
            if (s && box) box.value = (await elf.store.get(`draft:${s.id}`).catch(() => '')) ?? '';
            const chat = this.renderRoot.querySelector('.chat');
            if (chat) chat.scrollTop = chat.scrollHeight;
        }
    }

    async _send(e, s) {
        e.preventDefault();
        const box = e.target.elements.text;
        const text = box.value.trim();
        if (!text) return;
        const r = await this._act('send', { session: s.id, text }, 'Couldn\'t send it');
        if (r) {
            box.value = '';
            elf.store.set(`draft:${s.id}`, '').catch(() => {});
            await this.updateComplete;
            const chat = this.renderRoot.querySelector('.chat');
            if (chat) chat.scrollTop = chat.scrollHeight;
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
