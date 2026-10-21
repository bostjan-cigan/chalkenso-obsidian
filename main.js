/*
 * Chalkenso — Obsidian plugin (no build step; edit this file directly).
 *
 * Syncs course curricula between a vault and Chalkenso (/api/sync/*, two-way: download, upload,
 * sync): one folder per course version or group curriculum, feedback notes with revision plans,
 * conflicts and lesson images. A sync token (usr_…) works in one organisation, so you add each
 * organisation you belong to with its own token; each gets its folder in the root folder
 * (`<root>/<Organisation>/Curriculums/…`, `…/Groups/…`). You tick what to keep from the list each
 * organisation offers (`/me`); each choice gets its folder there and is downloaded, and its requests
 * use that organisation's token. A folder's workspace (version) is sent as the
 * X-Curriculum-Version-Id header.
 *
 * Layout: Curriculum module · Host (shared settings, settings tab, explorer).
 */
'use strict';

const { AbstractInputSuggest, FuzzySuggestModal, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, Vault, normalizePath, requestUrl, setIcon, setTooltip, stringifyYaml } = require('obsidian');
// ==============================================================================================
// Host: the Obsidian plugin; runs the curriculum module and owns the shared settings
// ==============================================================================================

/** Settings shared with the curriculum module (edited under "Connection"). */
const SHARED_KEYS = ['baseUrl', 'devMode', 'devBaseUrl'];
const DEFAULT_BASE_URL = 'https://chalkenso.com';
const DEFAULT_DEV_BASE_URL = 'http://localhost:3100';
const DEFAULT_ROOT_FOLDER = 'Chalkenso';
/** Where a sync token is created in Chalkenso (the "Tokens" link at the bottom of the admin sidebar). */
const TOKEN_PAGE_PATH = '/admin/api-tokens';
/**
 * `rootFolder`: the folder everything is kept in (null = none chosen, nothing syncs). `connections`:
 * one per organisation and server, `{ id, env: 'prod' | 'dev', token, folder, curriculumsFolder,
 * groupsFolder, organizationId, organizationName, userId }`. A sync token (usr_…) works in the one
 * organisation it was made in; that organisation's folders live in its `folder` (`<root>/<name>`).
 */
const GENERAL_DEFAULTS = { baseUrl: DEFAULT_BASE_URL, devMode: false, devBaseUrl: DEFAULT_DEV_BASE_URL, rootFolder: DEFAULT_ROOT_FOLDER, connections: [] };
const EXPLORER_SELECTOR = '.chalkenso-dot, .chalkenso-folder-tag, .chalkenso-readonly-lock';

// ----------------------------------------------------------------------------------------------
// Readable errors + problem log
// ----------------------------------------------------------------------------------------------

/** The running plugin, so module-level helpers can record problems. */
let activeHost = null;
const obsidianRequestUrl = requestUrl;
const ObsidianNotice = Notice;
const MAX_PROBLEMS = 30;

/**
 * True when `path` is the root folder or inside it. Nothing outside the root folder syncs, and
 * nothing syncs while none is chosen.
 */
function isInsideRootFolder(path) {
    const root = activeHost?.rootFolder() ?? null;
    const normalized = String(path ?? '').replace(/^\/+|\/+$/g, '');
    return Boolean(root) && (normalized === root || normalized.startsWith(`${root}/`));
}

function describeTarget(url) {
    try {
        const parsed = new URL(url);
        return { origin: parsed.origin, host: parsed.host, path: parsed.pathname };
    }
    catch {
        return null;
    }
}

/** Plain-language reason for a request that never got a response (server down, DNS, offline, …). */
function describeNetworkError(error, url) {
    const target = describeTarget(url);
    if (!target) {
        return 'The server URL is not set or not valid. Set it under Settings → Chalkenso → Connection.';
    }
    const raw = String(error?.message ?? error ?? '');
    const is = (pattern) => pattern.test(raw);
    if (is(/CONNECTION_REFUSED|ECONNREFUSED/i)) {
        return `Can't reach ${target.origin} (connection refused). Is the server running?`;
    }
    if (is(/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i)) {
        return `Can't find ${target.host} (DNS lookup failed). Check the server URL.`;
    }
    if (is(/TIMED_OUT|ETIMEDOUT|timeout/i)) {
        return `${target.origin} didn't respond in time (timeout). The server may be down or overloaded.`;
    }
    if (is(/INTERNET_DISCONNECTED|NETWORK_CHANGED|ENETUNREACH/i)) {
        return `No internet connection, so ${target.origin} can't be reached.`;
    }
    if (is(/CERT|SSL|TLS/i)) {
        return `Secure connection to ${target.origin} failed (${raw}). Check the certificate or use the right http/https URL.`;
    }
    if (is(/CONNECTION_RESET|ECONNRESET|EMPTY_RESPONSE/i)) {
        return `${target.origin} dropped the connection. The server may have crashed or restarted.`;
    }
    return `Can't reach ${target.origin}: ${raw || 'unknown network error'}.`;
}

/** The <title> of an HTML error page, if the server returned one. */
function htmlTitle(text) {
    const match = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(String(text ?? ''));
    return match ? match[1].trim() : null;
}

/** Plain-language reason for an HTTP error, keeping the server's own message when it has one. */
function describeHttpError(status, serverMessage, method, url, text) {
    const where = `${method} ${describeTarget(url)?.path ?? url}`;
    const detail = serverMessage ?? htmlTitle(text);
    switch (true) {
        case status === 401:
            return `Not authorized (401): ${serverMessage ?? 'missing or invalid token'}. Paste a new sync token (usr_…) in Settings → Chalkenso; create one in Chalkenso under Tokens (${TOKEN_PAGE_PATH}).`;
        case status === 403:
            return `Forbidden (403): ${serverMessage ?? 'your account may not do that'}. Your account may lack access to this, or the token was revoked; if so, paste a new sync token (Tokens in Chalkenso) in Settings → Chalkenso.`;
        case status === 404:
            return serverMessage
                ? `${serverMessage} (404)`
                : `Not found (404) at ${where}. Check the server URL; the server may not have this feature yet.`;
        case status === 413:
            return `Too large (413): ${serverMessage ?? 'the note or an image exceeds the upload limit'}.`;
        case status >= 400 && status < 500:
            return `${serverMessage ?? `Request rejected (${status}) at ${where}`}${serverMessage ? ` (${status})` : ''}`;
        case status === 502 || status === 503 || status === 504:
            return `Server unavailable (${status}) at ${where}. The server is down, restarting, or overloaded${detail ? `: ${detail}` : ''}.`;
        default:
            return `Server error (${status}) at ${where}. The server hit an error${detail ? `: ${detail}` : ''}; check its logs.`;
    }
}

/**
 * `requestUrl` for the plugin: never throws for HTTP errors (they are returned with a readable
 * `json.error`, keeping the status so the 404/409 handling still works), and turns network failures
 * into an error that says what happened.
 */
async function serverRequestUrl(params) {
    const method = params.method ?? 'GET';
    let response;
    try {
        response = await obsidianRequestUrl({ ...params, throw: false });
    }
    catch (error) {
        const message = describeNetworkError(error, params.url);
        console.error(`Chalkenso: ${method} ${params.url} failed`, error);
        throw new Error(message);
    }
    if (response.status < 400) {
        return response;
    }
    let json = null;
    try {
        json = response.json;
    }
    catch {
        // Not JSON (e.g. an HTML error page).
    }
    // Server messages usually end with a full stop; drop it so it reads well inside our sentence.
    const serverMessage = typeof json?.error === 'string' && json.error.trim() ? json.error.trim().replace(/\.+$/, '') : null;
    const message = describeHttpError(response.status, serverMessage, method, params.url, response.text);
    console.error(`Chalkenso: ${method} ${params.url} → ${response.status}`, json ?? response.text);
    // Extra fields (e.g. a 409's `conflict` / `server`) are kept; only `error` is made readable.
    const extra = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
    return { status: response.status, headers: response.headers, text: response.text, json: { ...extra, error: message } };
}

/** Notices from failures stay longer, are recorded in the problem log, and open it when clicked. */
const PROBLEM_PATTERN = /fail|error|could ?n[o']t|can't|unable|conflict|invalid|missing|not found|forbidden|not authori[sz]ed|rejected|unavailable|timeout|too large/i;

class LoggedNotice extends ObsidianNotice {
    constructor(message, duration) {
        const text = String(message ?? '');
        const isProblem = PROBLEM_PATTERN.test(text);
        super(isProblem ? `${text}\n(Click for details.)` : text, isProblem ? Math.max(duration ?? 0, 12000) : duration);
        if (isProblem && activeHost) {
            activeHost.recordProblem(text);
            this.noticeEl?.addEventListener?.('click', () => activeHost?.openProblems());
        }
    }
}

/** List of recent problems (newest first) with Copy and Clear. */
class ProblemsModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    onOpen() {
        this.titleEl.setText('Chalkenso: recent problems');
        this.plugin.renderProblems(this.contentEl, () => this.onOpen());
    }
    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Confirmation dialog with an optional list (e.g. the notes an action affects). Resolves to true only
 * when the confirm button is pressed; closing the dialog any other way resolves to false.
 */
class ConfirmListModal extends Modal {
    constructor(app, { title, message, items = [], confirmLabel = 'Confirm', warning = true }, resolve) {
        super(app);
        this.options = { title, message, items, confirmLabel, warning };
        this.resolve = resolve;
        this.confirmed = false;
    }
    onOpen() {
        const { title, message, items, confirmLabel, warning } = this.options;
        if (title) {
            this.titleEl.setText(title);
        }
        this.contentEl.createEl('p', { text: message });
        if (items.length > 0) {
            const list = this.contentEl.createEl('ul', { cls: 'chalkenso-confirm-list' });
            for (const item of items.slice(0, 50)) {
                list.createEl('li', { text: item });
            }
            if (items.length > 50) {
                list.createEl('li', { text: `…and ${items.length - 50} more` });
            }
        }
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton((button) => {
            button.setButtonText(confirmLabel).onClick(() => {
                this.confirmed = true;
                this.close();
            });
            if (warning) {
                button.setWarning();
            }
            else {
                button.setCta();
            }
        });
    }
    onClose() {
        this.contentEl.empty();
        this.resolve(this.confirmed);
    }
}
function confirmList(app, options) {
    return new Promise((resolve) => new ConfirmListModal(app, options, resolve).open());
}

// ----------------------------------------------------------------------------------------------
// Changes preview: a line diff of a note against the server's copy, shown before uploading
// ----------------------------------------------------------------------------------------------

function splitDiffLines(text) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    return normalized ? normalized.split('\n') : [];
}

/**
 * Line diff from `before` (the server's copy) to `after` (the note), as `{ type, text }` rows where
 * `type` is 'context', 'removed' or 'added'. Common leading and trailing lines are trimmed first,
 * so the LCS table only covers the changed middle — lessons are short enough for that to be fast.
 */
function diffLines(before, after) {
    const a = splitDiffLines(before);
    const b = splitDiffLines(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start++;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const rows = midA.length;
    const cols = midB.length;
    // lcs[i * width + j] = length of the LCS of midA[i..] and midB[j..].
    const width = cols + 1;
    const lcs = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            lcs[i * width + j] = midA[i] === midB[j]
                ? lcs[(i + 1) * width + j + 1] + 1
                : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        }
    }
    const result = a.slice(0, start).map((text) => ({ type: 'context', text }));
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
        if (midA[i] === midB[j]) {
            result.push({ type: 'context', text: midA[i] });
            i++;
            j++;
        }
        else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
            result.push({ type: 'removed', text: midA[i++] });
        }
        else {
            result.push({ type: 'added', text: midB[j++] });
        }
    }
    while (i < rows) {
        result.push({ type: 'removed', text: midA[i++] });
    }
    while (j < cols) {
        result.push({ type: 'added', text: midB[j++] });
    }
    for (const text of a.slice(endA)) {
        result.push({ type: 'context', text });
    }
    return result;
}

function diffHasChanges(lines) {
    return lines.some((line) => line.type !== 'context');
}

/**
 * Keeps `context` unchanged lines around each change and folds the rest into `{ type: 'fold',
 * lines }` rows, so a one-line edit in a long lesson shows as a few rows. A single line isn't folded.
 */
function foldDiffContext(lines, context = 3) {
    const keep = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.type === 'context') {
            return;
        }
        for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
            keep[k] = true;
        }
    });
    const rows = [];
    let hidden = [];
    const flush = () => {
        if (hidden.length >= 2) {
            rows.push({ type: 'fold', lines: hidden });
        }
        else {
            rows.push(...hidden);
        }
        hidden = [];
    };
    lines.forEach((line, index) => {
        if (keep[index]) {
            flush();
            rows.push(line);
        }
        else {
            hidden.push(line);
        }
    });
    flush();
    return rows;
}

const CHANGES_KIND_LABEL = {
    create: 'New lesson',
    update: 'Changed',
    unchanged: 'Unchanged',
    skipped: 'Not uploaded',
    error: 'Can\'t upload',
};

/**
 * What uploading a note would change in Chalkenso: field changes (old → new) and a line diff of the
 * body, with an Upload button. `preview` comes from the curriculum module's `previewLessonUpload`;
 * `uploadBlocked` (a reason) hides the button. `onUpload` runs the normal upload.
 */
class LessonChangesModal extends Modal {
    constructor(app, { title, preview, uploadBlocked = null }, onUpload) {
        super(app);
        this.title = title;
        this.preview = preview;
        this.uploadBlocked = uploadBlocked;
        this.onUpload = onUpload;
    }
    onOpen() {
        const { preview } = this;
        this.modalEl.addClass('chalkenso-changes-modal');
        this.titleEl.setText(this.title);
        const { contentEl } = this;
        contentEl.empty();

        const meta = contentEl.createDiv({ cls: 'chalkenso-changes-meta' });
        meta.createSpan({
            cls: `chalkenso-changes-kind chalkenso-changes-kind-${preview.kind}`,
            text: CHANGES_KIND_LABEL[preview.kind] ?? preview.kind,
        });
        const details = [];
        if (preview.serverRevision !== undefined) {
            details.push(`server revision ${preview.serverRevision}`);
        }
        if (preview.imageCount > 0) {
            details.push(`${preview.imageCount} image${preview.imageCount === 1 ? '' : 's'} (uploaded only if new)`);
        }
        if (details.length > 0) {
            meta.createSpan({ text: details.join(' · ') });
        }
        for (const text of [preview.message, preview.warning, this.uploadBlocked].filter(Boolean)) {
            contentEl.createDiv({ cls: 'chalkenso-changes-note', text });
        }

        if (preview.fields.length > 0) {
            contentEl.createDiv({ cls: 'chalkenso-changes-section', text: 'Fields' });
            const table = contentEl.createDiv({ cls: 'chalkenso-changes-fields' });
            for (const change of preview.fields) {
                table.createDiv({ cls: 'chalkenso-changes-field-name', text: change.field });
                const value = table.createDiv();
                if (preview.kind !== 'create') {
                    value.createSpan({ cls: 'chalkenso-diff-removed-text', text: change.from || '(empty)' });
                    value.createSpan({ text: ' → ' });
                }
                value.createSpan({ cls: 'chalkenso-diff-added-text', text: change.to || '(empty)' });
            }
        }
        if (preview.diff.length > 0) {
            contentEl.createDiv({ cls: 'chalkenso-changes-section', text: 'Body' });
            if (diffHasChanges(preview.diff)) {
                this.renderDiff(contentEl.createDiv({ cls: 'chalkenso-diff' }), preview.diff);
            }
            else {
                contentEl.createDiv({ cls: 'chalkenso-changes-note', text: 'The body is the same as in Chalkenso.' });
            }
        }
        if (preview.kind === 'unchanged') {
            contentEl.createDiv({ cls: 'chalkenso-changes-note', text: 'Chalkenso already has this version of the note.' });
        }

        const canUpload = !this.uploadBlocked && (preview.kind === 'create' || preview.kind === 'update');
        const buttons = new Setting(contentEl).addButton((button) => button.setButtonText(canUpload ? 'Cancel' : 'Close').onClick(() => this.close()));
        if (canUpload) {
            buttons.addButton((button) => button
                .setButtonText('Upload')
                .setCta()
                .onClick(() => {
                this.close();
                this.onUpload();
            }));
        }
    }
    renderDiff(containerEl, lines) {
        for (const row of foldDiffContext(lines)) {
            if (row.type !== 'fold') {
                this.renderDiffLine(containerEl, row);
                continue;
            }
            const fold = containerEl.createDiv({ cls: 'chalkenso-diff-fold', text: `… ${row.lines.length} unchanged lines` });
            fold.addEventListener('click', () => {
                const expanded = createDiv();
                for (const line of row.lines) {
                    this.renderDiffLine(expanded, line);
                }
                fold.replaceWith(...Array.from(expanded.childNodes));
            });
        }
    }
    renderDiffLine(containerEl, line) {
        const row = containerEl.createDiv({ cls: `chalkenso-diff-line chalkenso-diff-${line.type}` });
        row.createSpan({ cls: 'chalkenso-diff-prefix', text: line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' });
        // An empty line still needs its height.
        row.createSpan({ text: line.text || ' ' });
    }
    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Starts a titled section in a status-bar action menu: a divider (except at the top), then a
 * non-clickable heading, so every group of actions says what it acts on.
 */
function addMenuSection(menu, title) {
    if (menu.items?.length) {
        menu.addSeparator();
    }
    menu.addItem((item) => {
        item.setTitle(title);
        if (typeof item.setIsLabel === 'function') {
            item.setIsLabel(true);
        }
        else {
            item.setDisabled(true);
        }
    });
}

/** A greyed-out, informational menu row (status, reasons an action is unavailable). */
function addMenuInfo(menu, title, icon = 'info') {
    menu.addItem((item) => item.setTitle(title).setIcon(icon).setDisabled(true));
}

/**
 * Stand-in for Obsidian's `Plugin` base class, used by the curriculum module. Everything it registers
 * (commands, events, status bar items) goes through the host, so it is cleaned up with the host; its
 * settings are a slice of the host's data.
 */
class HostedModule {
    constructor(host, scope) {
        this.host = host;
        this.scope = scope;
        this.app = host.app;
    }
    addCommand(command) {
        return this.host.addCommand(command);
    }
    registerEvent(eventRef) {
        return this.host.registerEvent(eventRef);
    }
    addStatusBarItem() {
        return this.host.addStatusBarItem();
    }
    async loadData() {
        return this.host.loadModuleData(this.scope);
    }
    async saveData(data) {
        await this.host.saveModuleData(this.scope, data);
    }
}

// ==============================================================================================
// Curriculum module (lessons, feedback, group curricula)
// ==============================================================================================

const Curriculum = (() => {
    // Registers commands/events/status bar through the host (see HostedModule above); requests and
    // notices go through the host's readable-error and problem-log wrappers.
    const Plugin = HostedModule;
    const requestUrl = serverRequestUrl;
    const Notice = LoggedNotice;

    // ---- curriculum/api
    /** Error carrying the HTTP status (and the JSON body) so callers can tell 404/409 apart. */
    class CurriculumApiError extends Error {
        constructor(status, message, body, versionId) {
            super(message);
            this.status = status;
            this.body = body ?? null;
            /** The workspace (version) the request was for, so a 410 can be matched to its folder. */
            this.versionId = versionId ?? null;
            this.name = 'CurriculumApiError';
        }
        /** 410 `{ reason: "group_curriculum_closed" }`: the group's curriculum was closed in Chalkenso. */
        get isGroupClosed() {
            return this.status === 410 && this.body?.reason === 'group_curriculum_closed';
        }
    }
    /**
     * Called with the version id whenever a curriculum route answers 410 group_curriculum_closed, so
     * the plugin can clean up that group's folder. Set by the plugin on load.
     */
    let groupClosedListener = null;
    function setGroupClosedListener(listener) {
        groupClosedListener = listener;
    }
    function joinUrl(baseUrl, path) {
        return `${baseUrl.replace(/\/+$/, '')}${path}`;
    }
    function extractError(body, status) {
        if (body && typeof body === 'object' && 'error' in body) {
            const value = body.error;
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return `Request failed (HTTP ${status}).`;
    }
    /**
     * One request to a curriculum route. `target` is `{ baseUrl, token, versionId }` (see
     * `syncTarget`): the sync token authenticates, the version header picks the workspace.
     */
    async function curriculumRequest(target, method, path, body) {
        const response = await requestUrl({
            url: joinUrl(target.baseUrl, path),
            method,
            headers: {
                Authorization: `Bearer ${target.token}`,
                'X-Curriculum-Version-Id': target.versionId,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            throw: false,
        });
        if (response.status >= 400) {
            let json = null;
            try {
                json = response.json;
            }
            catch {
                // Not JSON.
            }
            const error = new CurriculumApiError(response.status, extractError(json, response.status), json, target.versionId);
            if (error.isGroupClosed) {
                try {
                    groupClosedListener?.(target.versionId);
                }
                catch (listenerError) {
                    console.error('Chalkenso: group-closed handler failed', listenerError);
                }
            }
            throw error;
        }
        return response;
    }
    /**
     * Fetches the version manifest (arcs + lessons, each with its `revision`). With `includeContent`,
     * every lesson also carries `markdownContent`, `arcTitle` and its image `assets`.
     *
     * `since` is the stamp from the previous download. The lesson *list* always comes back whole —
     * so notes for deleted lessons are still noticed — but bodies are sent only for lessons that
     * changed after it, which is the bulk of the payload. Callers must cope with a lesson that has
     * no body (see `downloadFolder`).
     */
    async function fetchManifest(target, includeContent = false, since = null) {
        const query = [
            includeContent ? 'include=content' : null,
            includeContent && since ? `since=${encodeURIComponent(since)}` : null,
        ].filter(Boolean).join('&');
        const response = await curriculumRequest(target, 'GET', `/api/sync/curriculum${query ? `?${query}` : ''}`);
        return response.json;
    }
    /** Creates one lesson in the version (it goes after the version's last lesson). */
    async function createLesson(target, payload) {
        const response = await curriculumRequest(target, 'POST', '/api/sync/lessons', payload);
        return response.json.lesson;
    }
    /**
     * Creates an arc in the version, after its last arc, and returns it. A title the version already
     * has (in any case) answers 409 with the existing arc, which counts as created; the arc may then
     * be missing from the body, so callers re-read the manifest. Servers without the route answer 404.
     */
    async function createArc(target, title) {
        try {
            const response = await curriculumRequest(target, 'POST', '/api/sync/arcs', { title });
            return response.json?.arc ?? null;
        }
        catch (error) {
            if (error instanceof CurriculumApiError && error.status === 409) {
                return error.body?.arc ?? null;
            }
            throw error;
        }
    }
    /**
     * Updates an existing lesson (and re-binds images). `payload.baseRevision` is the revision the
     * note was last synced at; the server answers 409 `{ conflict: true, server }` when it moved on.
     */
    async function updateLesson(target, lessonId, payload) {
        const response = await curriculumRequest(target, 'PATCH', `/api/sync/lessons/${encodeURIComponent(lessonId)}`, payload);
        return response.json.lesson;
    }
    /**
     * Creates/updates many lessons in one request, returning the per-item results.
     *
     * Each result carries back the `ref` its request was sent with. Callers must match on that and
     * never on array position — see `syncFilesBatched`.
     */
    async function sendLessonBatch(target, lessons) {
        const response = await curriculumRequest(target, 'POST', '/api/sync/lessons/batch', { lessons });
        return Array.isArray(response.json?.results) ? response.json.results : [];
    }
    /**
     * The server caps a request body at 4.5 MB, and lesson bodies are the bulk of a push, so batches
     * are split by serialised size as well as by count. The byte budget is deliberately well under
     * the cap: the count is the cheap guard, the size is the one that actually bites.
     */
    const MAX_BATCH_ITEMS = 50;
    const MAX_BATCH_BYTES = 3 * 1024 * 1024;

    function chunkLessonRequests(requests) {
        const chunks = [];
        let current = [];
        let bytes = 0;
        for (const request of requests) {
            const size = new TextEncoder().encode(JSON.stringify(request)).length + 1;
            if (current.length > 0 && (current.length >= MAX_BATCH_ITEMS || bytes + size > MAX_BATCH_BYTES)) {
                chunks.push(current);
                current = [];
                bytes = 0;
            }
            // One oversized lesson still goes on its own: the server rejects it and we report that,
            // rather than silently dropping the note.
            current.push(request);
            bytes += size;
        }
        if (current.length > 0) {
            chunks.push(current);
        }
        return chunks;
    }
    /** Deletes a lesson on the server. Only called from the confirmed "Delete lesson on server" command. */
    async function deleteLesson(target, lessonId) {
        await curriculumRequest(target, 'DELETE', `/api/sync/lessons/${encodeURIComponent(lessonId)}`);
    }
    /** sha256 of the raw bytes, hex — the same digest the server de-duplicates images by. */
    async function sha256Hex(buffer) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }
    /**
     * Uploads one image and returns its asset id, to be bound to a lesson via `assetBindings`.
     *
     * Asks before sending: the server is told the image's hash first, and an image it already has is
     * answered straight away, so re-syncing a note with unchanged pictures moves no bytes at all.
     * Anything genuinely new goes to storage directly rather than through the server.
     */
    async function uploadAsset(target, { filename, contentType, buffer, sourcePath }) {
        const checksum = await sha256Hex(buffer);
        const response = await curriculumRequest(target, 'POST', '/api/sync/assets/presign', {
            filename,
            contentType,
            bytes: buffer.byteLength,
            checksum,
            sourcePath,
        });
        const presigned = response.json;
        if (presigned.reused) {
            return presigned;
        }
        const stored = await requestUrl({
            url: presigned.uploadUrl,
            method: 'PUT',
            headers: { 'Content-Type': contentType },
            body: buffer,
            throw: false,
        });
        if (stored.status >= 400) {
            throw new CurriculumApiError(stored.status, `Could not store ${filename} (HTTP ${stored.status}).`);
        }
        const completed = await curriculumRequest(target, 'POST', `/api/sync/assets/${encodeURIComponent(presigned.assetId)}/complete`, { checksum, sourcePath });
        return completed.json.asset;
    }
    /**
     * Downloads one lesson image's bytes (for images missing from the vault after a download).
     * The server hands back a short-lived link and the bytes come straight from storage.
     */
    async function downloadAsset(target, assetId) {
        const link = await curriculumRequest(target, 'GET', `/api/sync/assets/${encodeURIComponent(assetId)}/url`);
        const stored = await requestUrl({ url: link.json.url, method: 'GET', throw: false });
        if (stored.status >= 400) {
            throw new CurriculumApiError(stored.status, `Could not fetch image (HTTP ${stored.status}).`);
        }
        return stored.arrayBuffer;
    }
    /** In-progress feedback (items and lesson briefs) for the version. */
    async function fetchTasks(target) {
        const response = await curriculumRequest(target, 'GET', '/api/sync/tasks');
        return response.json.tasks;
    }
    /**
     * Updates a task from the vault: `{ status?, plan?, aiReady? }` — its revision plan, its lane
     * (e.g. DONE or IGNORED) and/or its agent handoff flag. The server saves the plan before the
     * status, so all of it can go in one request.
     */
    async function updateTask(target, taskId, update) {
        await curriculumRequest(target, 'PATCH', `/api/sync/tasks/${encodeURIComponent(taskId)}`, update);
    }

    // ---- curriculum/settings
    /** Short "Course · version" label for a mapping, or null when it hasn't been resolved yet. */
    function curriculumLabel(mapping) {
        if (!mapping.versionLabel) {
            return null;
        }
        return mapping.courseTitle
            ? `${mapping.courseTitle} · ${mapping.versionLabel}`
            : mapping.versionLabel;
    }
    /**
     * Folder mappings are `{ path, env, connection, versionId | devVersionId, courseTitle,
     * versionLabel }`: `connection` is the organisation the folder belongs to (see `connectionOf`),
     * and the version is one of the workspaces its `/api/sync/me` lists.
     */
    const DEFAULT_SETTINGS = {
        baseUrl: '',
        folders: [],
        defaultStatus: 'DRAFT',
        devMode: false,
        devBaseUrl: '',
    };
    /**
     * Folders chosen in settings get a mapping `{ path, env, connection, versionId | devVersionId,
     * courseTitle, versionLabel, … }`; a group curriculum's also has `{ managed: 'group', groupId,
     * groupName, userId, … }`. `env` ('prod' | 'dev') keeps the two servers' folders apart: a mapping
     * of the other environment, of an organisation no longer connected, or outside the root folder is
     * ignored entirely (not synced, not painted, not cleaned up).
     */
    const MANAGED_GROUP = 'group';
    function isManagedGroup(mapping) {
        return mapping?.managed === MANAGED_GROUP;
    }
    function activeEnv(settings) {
        return settings.devMode ? 'dev' : 'prod';
    }
    // ---- curriculum/organisations
    /**
     * A sync token works in one organisation, so each organisation has its own connection in the
     * host's settings: `{ id, env, token, folder, curriculumsFolder, groupsFolder, organizationId,
     * organizationName, userId }`. Its folder (`<root>/<Organisation>`) holds its Curriculums and
     * Groups folders; every folder mapping names its connection, and its requests use that token.
     */
    function connectionOf(mapping) {
        const connection = activeHost?.connectionById(mapping?.connection) ?? null;
        return connection && connection.env === mapping.env ? connection : null;
    }
    /** The organisations connected for the active server (dev or production). */
    function activeConnections() {
        return activeHost?.activeConnections() ?? [];
    }
    /** True when the active server has a URL and at least one organisation with a token. */
    function hasActiveConnection(settings) {
        return Boolean(activeBaseUrl(settings)) && activeConnections().some((connection) => connection.token);
    }
    /** An organisation's Curriculums / Groups folder ('' until its folder is known). */
    function curriculumsRootOf(connection) {
        return normalizeFolderPath(String(connection?.curriculumsFolder ?? '').trim());
    }
    function groupsRootOf(connection) {
        return normalizeFolderPath(String(connection?.groupsFolder ?? '').trim());
    }
    /** "Northwind Academy", or a stand-in until `/me` has named it. */
    function organizationLabel(connection) {
        return connection?.organizationName || 'your organisation';
    }
    /** False for a mapping of the other environment, of an organisation not connected, or outside the root folder. */
    function isInActiveEnv(settings, mapping) {
        return mapping?.env === activeEnv(settings) && isInsideRootFolder(mapping.path) && Boolean(connectionOf(mapping));
    }
    /** Whether a mapping takes part in syncing: every folder of the active server's organisations does. */
    function isMappingOn(settings, mapping) {
        return isInActiveEnv(settings, mapping);
    }
    /** File-name-safe folder name, keeping the en dash and spaces. */
    function sanitizeFolderName(value, fallback = 'Group') {
        const cleaned = String(value ?? '')
            .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\.+/, '')
            .slice(0, 120)
            .trim();
        return cleaned || fallback;
    }
    /**
     * Default folder of a workspace in its organisation: `<Groups>/<Course title> – <Group name>` for
     * a group curriculum, `<Curriculums>/<Course title> – <version label>` otherwise (plus ` (dev)` for
     * the dev server).
     */
    function workspaceFolderPath(settings, workspace, connection) {
        const group = workspace.kind === 'group';
        const name = sanitizeFolderName(`${workspace.course?.title ?? 'Course'} – ${group ? workspace.group?.name ?? workspace.label ?? 'Group' : workspace.label ?? 'Version'}`);
        const parent = group ? groupsRootOf(connection) : curriculumsRootOf(connection);
        return `${parent ? `${parent}/` : ''}${name}${settings.devMode ? ' (dev)' : ''}`;
    }
    /** The plugin-written README of a group folder. */
    function groupReadmeContent(workspace) {
        const group = workspace.group?.name ?? workspace.label ?? 'this group';
        const course = workspace.course?.title ?? 'the course';
        const base = workspace.baseVersion?.label ? `core ${workspace.baseVersion.label}` : 'the core curriculum';
        return `Group curriculum for ${group} (${course}), copied from ${base}. Changes here only affect this group. Managed by the Chalkenso plugin — the folder is removed when the group is closed.\n`;
    }
    /** Small stable hash (djb2) to recognise files the plugin wrote without storing their content. */
    function hashText(text) {
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        }
        return (hash >>> 0).toString(36);
    }
    function hasPermission(permissions, ...needed) {
        return needed.every((permission) => permissions.includes(permission));
    }
    /** Base URL for the active environment (dev server in dev mode). */
    function activeBaseUrl(settings) {
        return settings.devMode ? settings.devBaseUrl : settings.baseUrl;
    }
    /** A folder's workspace (curriculum version id) for the active environment. */
    function activeVersionId(settings, mapping) {
        return (settings.devMode ? mapping.devVersionId : mapping.versionId) ?? '';
    }
    function setActiveVersionId(settings, mapping, versionId) {
        if (settings.devMode) {
            mapping.devVersionId = versionId;
        }
        else {
            mapping.versionId = versionId;
        }
    }
    /** Where a mapping's requests go: server, its organisation's sync token, and the version header. */
    function syncTarget(settings, mapping) {
        return { baseUrl: activeBaseUrl(settings), token: connectionOf(mapping)?.token ?? '', versionId: activeVersionId(settings, mapping) };
    }
    /** Dropdown label for a `/me` workspace, e.g. "Web Development — v3 (Draft)". */
    function workspaceLabel(workspace) {
        const status = workspace.status === 'PUBLISHED' ? 'Published' : 'Draft';
        const readOnly = Array.isArray(workspace.permissions) && !workspace.permissions.includes('WRITE') ? ', read-only' : '';
        const label = workspace.kind === 'group' ? `group ${workspace.group?.name ?? workspace.label}` : workspace.label;
        return `${workspace.course?.title ?? 'Course'} — ${label} (${status}${readOnly})`;
    }
    // ---- curriculum/images
    // Mirror the server's image parsing so binding source paths match exactly.
    const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\n]+)\)/g;
    const OBSIDIAN_EMBED_PATTERN = /!\[\[([^[\]\n]+)\]\]/g;
    const IMAGE_FILE_PATTERN = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
    const CONTENT_TYPES = {
        avif: 'image/avif',
        bmp: 'image/bmp',
        gif: 'image/gif',
        heic: 'image/heic',
        heif: 'image/heif',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        png: 'image/png',
        svg: 'image/svg+xml',
        webp: 'image/webp',
    };
    function isRemote(path) {
        return /^(https?:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:');
    }
    /** Matches the server's `cleanMarkdownPath`: strip <>, drop a trailing "title". */
    function cleanMarkdownPath(raw) {
        let path = raw.trim();
        if (path.startsWith('<') && path.endsWith('>')) {
            path = path.slice(1, -1).trim();
        }
        const titleMatch = path.match(/^(.*?)(?:\s+['"].+['"])\s*$/);
        return (titleMatch?.[1] ?? path).trim();
    }
    /** Matches the server's `cleanObsidianPath`: drop `|alias` and `#subpath`. */
    function cleanObsidianPath(raw) {
        return raw.split('|')[0].split('#')[0].trim();
    }
    /** Extracts unique, non-remote image references from a note body (both syntaxes). */
    function extractImageRefs(markdown) {
        const seen = new Set();
        const refs = [];
        let match;
        const markdownPattern = new RegExp(MARKDOWN_IMAGE_PATTERN);
        while ((match = markdownPattern.exec(markdown)) !== null) {
            const sourcePath = cleanMarkdownPath(match[1] ?? '');
            if (sourcePath && !isRemote(sourcePath) && !seen.has(sourcePath)) {
                seen.add(sourcePath);
                refs.push({ sourcePath });
            }
        }
        const embedPattern = new RegExp(OBSIDIAN_EMBED_PATTERN);
        while ((match = embedPattern.exec(markdown)) !== null) {
            const sourcePath = cleanObsidianPath(match[1] ?? '');
            if (sourcePath && IMAGE_FILE_PATTERN.test(sourcePath) && !seen.has(sourcePath)) {
                seen.add(sourcePath);
                refs.push({ sourcePath });
            }
        }
        return refs;
    }
    function contentTypeFor(filename) {
        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        return CONTENT_TYPES[ext] ?? 'application/octet-stream';
    }
    /**
     * Resolves each referenced image to a vault file, uploads it, and returns the source-path → assetId
     * bindings. Unresolved references are collected in `missing` (the note still syncs, text-only).
     */
    async function uploadNoteImages(app, settings, mapping, notePath, markdown) {
        const bindings = [];
        const missing = [];
        for (const ref of extractImageRefs(markdown)) {
            const dest = app.metadataCache.getFirstLinkpathDest(ref.sourcePath, notePath) ??
                app.vault.getAbstractFileByPath(ref.sourcePath);
            if (!(dest instanceof TFile)) {
                missing.push(ref.sourcePath);
                continue;
            }
            const buffer = await app.vault.readBinary(dest);
            const asset = await uploadAsset(syncTarget(settings, mapping), {
                filename: dest.name,
                contentType: contentTypeFor(dest.name),
                buffer,
                sourcePath: ref.sourcePath,
            });
            bindings.push({ sourcePath: ref.sourcePath, assetId: asset.assetId });
        }
        return { bindings, missing };
    }
    /** Source paths used as `![[embed]]` in a lesson body (everything else is a `![](link)`). */
    function embedSourcePaths(markdown) {
        const embeds = new Set();
        let match;
        const embedPattern = new RegExp(OBSIDIAN_EMBED_PATTERN);
        while ((match = embedPattern.exec(markdown)) !== null) {
            embeds.add(cleanObsidianPath(match[1] ?? ''));
        }
        return embeds;
    }
    function safeDecode(value) {
        try {
            return decodeURIComponent(value);
        }
        catch {
            return value;
        }
    }
    /**
     * Resolves `relative` against `folder` (vault paths, no leading slash). A leading `/` means the
     * vault root. Returns null when the path climbs out of the vault or is empty.
     */
    function resolveRelativePath(folder, relative) {
        const segments = relative.startsWith('/') || !folder ? [] : folder.split('/');
        for (const part of relative.split('/')) {
            if (!part || part === '.') {
                continue;
            }
            if (part === '..') {
                if (segments.length === 0) {
                    return null;
                }
                segments.pop();
                continue;
            }
            segments.push(part);
        }
        return segments.length > 0 ? segments.join('/') : null;
    }
    /** Creates a folder and any missing parents. */
    async function ensureFolderPath(app, folderPath) {
        let current = '';
        for (const part of folderPath.split('/').filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            const existing = app.vault.getAbstractFileByPath(current);
            if (existing instanceof TFolder) {
                continue;
            }
            if (existing) {
                throw new Error(`"${current}" is a file, not a folder.`);
            }
            await app.vault.createFolder(current);
        }
    }
    /**
     * After a download: fetches the lesson's images that don't resolve in the vault and writes them.
     * `![[embed]]` images go to `<mapping>/_attachments/<sourcePath>` (Obsidian resolves embeds by
     * name, so they are found there); `![](relative/path)` images go to that path, resolved from the
     * note's folder. An existing file is never overwritten; hidden or non-image paths are refused.
     */
    async function downloadMissingImages(app, settings, mapping, noteFile, lesson) {
        return restoreImages(app, folderInMapping(mapping, ATTACHMENTS_FOLDER), noteFile, lesson.markdownContent ?? '', lesson.assets, (assetId) => downloadAsset(syncTarget(settings, mapping), assetId));
    }
    /**
     * Writes the images of `assets` (`[{ assetId, sourcePath }]` bound to `markdown`) that don't
     * resolve in the vault: embeds into `attachmentsFolder`, relative links next to the note.
     * `fetchBytes(assetId)` downloads one image.
     */
    async function restoreImages(app, attachmentsFolder, noteFile, markdown, assetList, fetchBytes) {
        const result = { written: [], failed: [] };
        const assets = Array.isArray(assetList) ? assetList : [];
        if (assets.length === 0) {
            return result;
        }
        const embeds = embedSourcePaths(markdown);
        const noteFolder = noteFile.parent && !noteFile.parent.isRoot() ? noteFile.parent.path : '';
        const resolves = (candidate) => candidate &&
            (app.metadataCache.getFirstLinkpathDest(candidate, noteFile.path) instanceof TFile ||
                app.vault.getAbstractFileByPath(normalizePath(candidate)) instanceof TFile);
        for (const asset of assets) {
            const sourcePath = typeof asset?.sourcePath === 'string' ? asset.sourcePath.trim() : '';
            if (!sourcePath || !asset.assetId || isRemote(sourcePath)) {
                continue;
            }
            const decoded = safeDecode(sourcePath);
            const isEmbed = embeds.has(sourcePath);
            const relative = isEmbed ? null : resolveRelativePath(noteFolder, decoded);
            if (resolves(sourcePath) || resolves(decoded) || resolves(relative)) {
                continue;
            }
            const target = isEmbed
                ? resolveRelativePath(attachmentsFolder, decoded.replace(/^\/+/, ''))
                : relative;
            const unsafe = !target ||
                !IMAGE_FILE_PATTERN.test(target) ||
                target.split('/').some((segment) => segment.startsWith('.')) ||
                (isEmbed && !target.startsWith(`${attachmentsFolder}/`));
            if (unsafe) {
                result.failed.push(`${sourcePath} (unsupported path)`);
                continue;
            }
            const path = normalizePath(target);
            if (app.vault.getAbstractFileByPath(path) || (await app.vault.adapter.exists(path))) {
                continue; // never overwrite an existing file
            }
            try {
                const bytes = await fetchBytes(asset.assetId);
                const folder = path.split('/').slice(0, -1).join('/');
                if (folder) {
                    await ensureFolderPath(app, folder);
                }
                await app.vault.createBinary(path, bytes);
                result.written.push(path);
            }
            catch (error) {
                result.failed.push(`${sourcePath} (${error.message})`);
            }
        }
        return result;
    }

    // ---- curriculum/sync
    /**
     * Dev mode points at a separate server/database, so the plugin-managed ids and sync stamps live
     * under `dev*` keys there — a dev sync never overwrites the production `lessonId` in a note.
     * Set by the plugin whenever settings load or change.
     */
    let devMode = false;
    function setDevMode(enabled) {
        devMode = enabled;
    }
    /**
     * Frontmatter property names the plugin reads and writes. `arc` is authored by the user; the rest
     * are managed by the plugin and lay the groundwork for future features (e.g. "last synced").
     */
    const FRONTMATTER = {
        /** User-authored: the arc title this lesson belongs to (resolved to an arc id at sync time). */
        arc: 'arc',
        /** User toggle: set `false` to exclude just this note from syncing. */
        sync: 'sync',
        /** Optional user override; defaults to the note's file name. */
        title: 'title',
        /** Optional user overrides. */
        slug: 'slug',
        shortDescription: 'shortDescription',
        status: 'status',
        /** Plugin-managed, written after a successful create (`dev*` variants in dev mode). */
        get lessonId() {
            return devMode ? 'devLessonId' : 'lessonId';
        },
        /**
         * Plugin-managed: the lesson's status on the server (`DRAFT` / `PUBLISHED`) as returned by the
         * last sync, so the explorer can mark published lessons.
         */
        get lessonStatus() {
            return devMode ? 'devLessonStatus' : 'lessonStatus';
        },
        /**
         * Plugin-managed: the server revision the note was last synced at. Sent as `baseRevision` on
         * upload (the server refuses with a conflict when it moved on) and compared on download.
         */
        get revision() {
            return devMode ? 'devRevision' : 'revision';
        },
        get lastSynced() {
            return devMode ? 'devLastSynced' : 'lastSynced';
        },
        /** Plugin-managed mirror of the note's sync state, so it is visible in each note. */
        get syncStatus() {
            return devMode ? 'devSyncStatus' : 'syncStatus';
        },
        /** Plugin-managed link from a lesson note to its feedback checklist (absent when none is open). */
        get feedback() {
            return devMode ? 'devFeedback' : 'feedback';
        },
        /**
         * Plugin-managed, group curricula only: link to the core lesson note this copy was made from,
         * when the core version's folder is mapped too (absent otherwise).
         */
        get coreLesson() {
            return devMode ? 'devCoreLesson' : 'coreLesson';
        },
    };
    /** Production lesson id key, used in dev mode to recognise notes of a dev database copied from production. */
    const PRODUCTION_LESSON_ID = 'lessonId';
    /**
     * Grace window (ms) between the `lastSynced` timestamp we stamp and the file `mtime` that stamping
     * itself produces — without it, every freshly synced note would immediately read back as `pending`.
     */
    const SYNC_MTIME_TOLERANCE_MS = 2000;
    function normalizeFolderPath(path) {
        return path.replace(/\/+$/, '');
    }
    function isInsideFolder(filePath, folderPath) {
        const base = normalizeFolderPath(folderPath);
        if (!base) {
            return true; // empty mapping path = vault root, matches everything
        }
        return filePath === base || filePath.startsWith(`${base}/`);
    }
    /** The README.md directly inside a mapped folder documents the folder — it is never a lesson. */
    function isFolderReadme(filePath, folderPath) {
        const base = normalizeFolderPath(folderPath);
        const readmePath = base ? `${base}/readme.md` : 'readme.md';
        return filePath.toLowerCase() === readmePath.toLowerCase();
    }
    /** Folders (inside each mapped folder) holding feedback tasks pulled from the task lane. */
    const FEEDBACK_FOLDER = '_feedback';
    const DEV_FEEDBACK_FOLDER = '_feedback-dev';
    /** Server copies of lessons that changed on both sides (one note per conflicting lesson note). */
    const CONFLICTS_FOLDER = '_conflicts';
    /** Images fetched by a download for `![[embeds]]` that were missing from the vault. */
    const ATTACHMENTS_FOLDER = '_attachments';
    function folderInMapping(mapping, folder) {
        const base = normalizeFolderPath(mapping.path);
        return base ? `${base}/${folder}` : folder;
    }
    /** The active environment's feedback folder for a mapping. */
    function feedbackFolderPath(mapping) {
        return folderInMapping(mapping, devMode ? DEV_FEEDBACK_FOLDER : FEEDBACK_FOLDER);
    }
    /** True for files in any plugin-managed feedback folder, so none ever syncs as a lesson. */
    function isFeedbackPath(filePath, mapping) {
        return [FEEDBACK_FOLDER, DEV_FEEDBACK_FOLDER].some((folder) => filePath.startsWith(`${folderInMapping(mapping, folder)}/`));
    }
    /** True for files in any plugin-managed folder (feedback, conflicts, attachments): never lessons. */
    function isPluginFolderPath(filePath, mapping) {
        return isFeedbackPath(filePath, mapping) ||
            [CONFLICTS_FOLDER, ATTACHMENTS_FOLDER].some((folder) => filePath.startsWith(`${folderInMapping(mapping, folder)}/`));
    }
    /** The `_conflicts/` copy of a lesson note (it may not exist). */
    function conflictPathFor(mapping, file) {
        return normalizePath(`${folderInMapping(mapping, CONFLICTS_FOLDER)}/${file.basename}.md`);
    }
    /**
     * Most specific mapping whose folder contains the path, with no lesson/feedback exclusions. A row
     * with a blank path (vault root) only counts once it has a version, so a just-added empty row
     * doesn't claim the whole vault.
     */
    function findCoveringMapping(settings, filePath) {
        let best = null;
        for (const mapping of settings.folders) {
            if (!isInActiveEnv(settings, mapping)) {
                continue; // a folder of the other server (dev / production)
            }
            if (!isInsideFolder(filePath, mapping.path ?? '')) {
                continue;
            }
            if (!best || normalizeFolderPath(mapping.path).length > normalizeFolderPath(best.path).length) {
                best = mapping;
            }
        }
        return best;
    }
    /**
     * Returns the most specific folder mapping that contains the file, or null if none applies.
     * A mapped folder's top-level README.md and its plugin folders (feedback, conflicts, attachments)
     * are excluded, so they never sync as lessons or show a lesson status.
     */
    function findFolderMapping(settings, filePath) {
        const best = findCoveringMapping(settings, filePath);
        if (best && (isFolderReadme(filePath, best.path) || isPluginFolderPath(filePath, best))) {
            return null;
        }
        return best;
    }
    /** The mapping whose feedback folder holds this file, or null when it is not a feedback checklist. */
    function findFeedbackFolderMapping(settings, filePath) {
        const mapping = findCoveringMapping(settings, filePath);
        return mapping && isFeedbackPath(filePath, mapping) ? mapping : null;
    }
    const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    /** Removes a leading YAML frontmatter block so only the lesson body is sent as markdown. */
    function stripFrontmatter(content) {
        const match = FRONTMATTER_BLOCK.exec(content);
        return match ? content.slice(match[0].length) : content;
    }
    function findArcByTitle(manifest, title) {
        const normalized = title.trim().toLowerCase();
        return manifest.arcs.find((arc) => arc.title.trim().toLowerCase() === normalized) ?? null;
    }
    function readFrontmatterString(frontmatter, key) {
        const value = frontmatter?.[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        return undefined;
    }
    /** The note's stored revision (a non-negative integer), or null when it has none. */
    function readRevision(frontmatter) {
        const value = frontmatter?.[FRONTMATTER.revision];
        const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
        return Number.isInteger(number) && number >= 0 ? number : null;
    }
    function normalizeStatus(value, fallback) {
        if (!value) {
            return fallback;
        }
        return value.toUpperCase() === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
    }
    /** True unless the note's `sync` property is explicitly falsey (`false`, `"no"`, `"off"`). */
    function isNoteSyncEnabled(frontmatter) {
        const value = frontmatter?.[FRONTMATTER.sync];
        if (value === false) {
            return false;
        }
        if (typeof value === 'string') {
            return !['false', 'no', 'off', '0'].includes(value.trim().toLowerCase());
        }
        return true;
    }
    /**
     * Derives the per-note status from its frontmatter (independent of the folder toggle). When the
     * note's local modification time (`mtime`, ms) is given, a previously-synced note that was edited
     * after its last sync is reported as `pending` ("dirty").
     */
    function computeNoteStatus(frontmatter, mtime) {
        if (!isNoteSyncEnabled(frontmatter)) {
            return 'disabled';
        }
        if (!readFrontmatterString(frontmatter, FRONTMATTER.lessonId)) {
            return 'not-synced';
        }
        if (typeof mtime === 'number') {
            const lastSynced = readFrontmatterString(frontmatter, FRONTMATTER.lastSynced);
            const lastSyncedMs = lastSynced ? Date.parse(lastSynced) : NaN;
            if (!Number.isNaN(lastSyncedMs) && mtime - lastSyncedMs > SYNC_MTIME_TOLERANCE_MS) {
                return 'pending';
            }
        }
        return 'synced';
    }
    /** Writes the plugin-managed `syncStatus` mirror only when it would change, to avoid churn. */
    async function writeNoteStatus(app, file, status) {
        const current = app.metadataCache.getFileCache(file)?.frontmatter;
        if (readFrontmatterString(current, FRONTMATTER.syncStatus) === status) {
            return;
        }
        await app.fileManager.processFrontMatter(file, (fm) => {
            fm[FRONTMATTER.syncStatus] = status;
        });
    }
    /**
     * Writes the server's version of a lesson to `<mapping>/_conflicts/<note name>.md`, replacing an
     * older conflict copy of the same note. The lesson note itself is never touched. The copy carries
     * no lesson id, so it can never sync by accident.
     */
    async function writeConflictCopy(app, mapping, noteFile, server) {
        const path = conflictPathFor(mapping, noteFile);
        const frontmatter = {
            conflictOf: `[[${app.metadataCache.fileToLinktext(noteFile, path, true)}]]`,
            serverRevision: typeof server.revision === 'number' ? server.revision : null,
            serverUpdatedAt: server.updatedAt ?? null,
            serverTitle: server.title ?? null,
            serverArc: server.arcTitle ?? null,
            serverStatus: server.status ?? null,
        };
        const content = `---\n${stringifyYaml(frontmatter)}---\n\n${String(server.markdownContent ?? '').trim()}\n`;
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await app.vault.modify(existing, content);
        }
        else {
            await ensureFolderPath(app, folderInMapping(mapping, CONFLICTS_FOLDER));
            await app.vault.create(path, content);
        }
        return path;
    }
    /**
     * Rewrites a lesson note from the server: the body becomes `markdownContent` (only when it
     * differs) and the frontmatter gets the server's title, arc, status, slug and revision, stamped as
     * synced. Other frontmatter keys are kept. Only called for notes that already carry this lesson's
     * id and are clean, or from the explicit "use server version" command.
     */
    async function applyServerLesson(app, file, lesson) {
        const markdown = String(lesson.markdownContent ?? '').trim();
        let bodyChanged = false;
        if (stripFrontmatter(await app.vault.read(file)).trim() !== markdown) {
            await app.vault.process(file, (content) => {
                const block = FRONTMATTER_BLOCK.exec(content)?.[0] ?? '';
                return block ? `${block.replace(/\s*$/, '')}\n\n${markdown}\n` : `${markdown}\n`;
            });
            bodyChanged = true;
        }
        await app.fileManager.processFrontMatter(file, (fm) => {
            // Titles default to the file name, so the key is only needed when they differ.
            if (lesson.title && (fm[FRONTMATTER.title] !== undefined || lesson.title !== file.basename)) {
                fm[FRONTMATTER.title] = lesson.title;
            }
            if (typeof lesson.arcTitle === 'string' && lesson.arcTitle) {
                fm[FRONTMATTER.arc] = lesson.arcTitle;
            }
            else if (lesson.arcTitle === null) {
                delete fm[FRONTMATTER.arc];
            }
            if (typeof lesson.shortDescription === 'string' && lesson.shortDescription.trim()) {
                fm[FRONTMATTER.shortDescription] = lesson.shortDescription;
            }
            else if ('shortDescription' in lesson) {
                delete fm[FRONTMATTER.shortDescription];
            }
            if (lesson.status) {
                fm[FRONTMATTER.lessonStatus] = lesson.status;
                // Keep the authored status in line, so the next upload doesn't flip it back.
                fm[FRONTMATTER.status] = String(lesson.status).toLowerCase();
            }
            if (lesson.id) {
                fm[FRONTMATTER.lessonId] = lesson.id;
            }
            if (lesson.slug) {
                fm[FRONTMATTER.slug] = lesson.slug;
            }
            if (typeof lesson.revision === 'number') {
                fm[FRONTMATTER.revision] = lesson.revision;
            }
            fm[FRONTMATTER.lastSynced] = new Date().toISOString();
            fm[FRONTMATTER.syncStatus] = 'synced';
        });
        return bodyChanged;
    }
    /** A free `<folder>/<name>.md` path (then `<name> (2).md`, …), checked case-insensitively. */
    function uniqueNotePath(app, folder, name) {
        const taken = new Set(app.vault.getFiles().map((file) => file.path.toLowerCase()));
        const pathFor = (suffix) => normalizePath(folder ? `${folder}/${name}${suffix}.md` : `${name}${suffix}.md`);
        let path = pathFor('');
        for (let n = 2; taken.has(path.toLowerCase()) || app.vault.getAbstractFileByPath(path); n += 1) {
            path = pathFor(` (${n})`);
        }
        return path;
    }
    /** Creates a new lesson note (at the mapping root) for a server lesson that has no local note. */
    async function createLessonNote(app, mapping, lesson) {
        const name = sanitizeFileName(String(lesson.title ?? 'Lesson')).replace(/^\.+/, '').trim() || 'Lesson';
        const folder = normalizeFolderPath(mapping.path);
        if (folder) {
            await ensureFolderPath(app, folder);
        }
        const path = uniqueNotePath(app, folder, name);
        const frontmatter = {};
        if (lesson.title && lesson.title !== path.split('/').pop().replace(/\.md$/, '')) {
            frontmatter[FRONTMATTER.title] = lesson.title;
        }
        if (lesson.arcTitle) {
            frontmatter[FRONTMATTER.arc] = lesson.arcTitle;
        }
        if (typeof lesson.shortDescription === 'string' && lesson.shortDescription.trim()) {
            frontmatter[FRONTMATTER.shortDescription] = lesson.shortDescription;
        }
        frontmatter[FRONTMATTER.status] = String(lesson.status ?? 'DRAFT').toLowerCase();
        frontmatter[FRONTMATTER.lessonId] = lesson.id;
        frontmatter[FRONTMATTER.slug] = lesson.slug;
        frontmatter[FRONTMATTER.lessonStatus] = lesson.status;
        if (typeof lesson.revision === 'number') {
            frontmatter[FRONTMATTER.revision] = lesson.revision;
        }
        frontmatter[FRONTMATTER.lastSynced] = new Date().toISOString();
        frontmatter[FRONTMATTER.syncStatus] = 'synced';
        for (const key of Object.keys(frontmatter)) {
            if (frontmatter[key] === undefined || frontmatter[key] === null) {
                delete frontmatter[key];
            }
        }
        const body = String(lesson.markdownContent ?? '').trim();
        return app.vault.create(path, `---\n${stringifyYaml(frontmatter)}---\n\n${body}\n`);
    }
    /**
     * Works out everything a lesson upload needs without committing to it: the request the server will
     * receive, plus the context needed to report and stamp whatever comes back.
     *
     * Returns `{ ready: false, result }` when the note resolves without the server being involved at
     * all (sync disabled, unknown arc, empty body, no revision to compare against). Image uploads
     * happen here, so this does talk to the network and may throw; callers wrap it.
     */
    async function prepareLessonUpload(app, settings, file, manifest, mapping, options = {}) {
        const cache = app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;
        if (!isNoteSyncEnabled(frontmatter)) {
            await writeNoteStatus(app, file, 'disabled');
            return { ready: false, result: { file, outcome: 'skipped', message: 'Sync disabled for this note.' } };
        }
        const existingLessonId = readFrontmatterString(frontmatter, FRONTMATTER.lessonId);
        // No arc is valid — the lesson just isn't grouped. A named arc must exist, though (likely a typo).
        const arcTitle = readFrontmatterString(frontmatter, FRONTMATTER.arc);
        const arc = arcTitle ? findArcByTitle(manifest, arcTitle) : null;
        if (arcTitle && !arc) {
            const available = manifest.arcs.map((a) => a.title).join(', ') || 'none';
            return {
                ready: false,
                result: {
                    file,
                    outcome: 'error',
                    message: `Arc "${arcTitle}" not found in ${manifest.version.label}. Available: ${available}.`,
                },
            };
        }
        const rawContent = await app.vault.read(file);
        const markdownContent = stripFrontmatter(rawContent).trim();
        if (!markdownContent) {
            return { ready: false, result: { file, outcome: 'error', message: 'Note body is empty.' } };
        }
        // Recreated only after the user confirmed that a lesson gone from the server (404) should
        // come back. This is a brand-new lesson with a new id, not an update.
        const recreated = Boolean(existingLessonId) && Boolean(options.recreate);
        const isUpdate = Boolean(existingLessonId) && !recreated;
        let baseRevision = null;
        if (isUpdate) {
            // Without a revision there is nothing to compare with, and the server copy would be overwritten.
            baseRevision = readRevision(frontmatter);
            if (baseRevision === null) {
                return {
                    ready: false,
                    result: { file, outcome: 'skipped', message: 'The note has no revision, so it can\'t be compared with Chalkenso. Download the folder first.' },
                };
            }
        }
        // Upload embedded images first so the lesson can bind them.
        const images = await uploadNoteImages(app, settings, mapping, file.path, markdownContent);
        return {
            ready: true,
            request: {
                // The server echoes this back on the matching result. A note's path is unique within
                // the vault, which is all this needs to be.
                ref: file.path,
                ...(isUpdate ? { lessonId: existingLessonId, baseRevision } : {}),
                title: readFrontmatterString(frontmatter, FRONTMATTER.title) ?? file.basename,
                markdownContent,
                arcId: arc?.id,
                slug: readFrontmatterString(frontmatter, FRONTMATTER.slug),
                shortDescription: readFrontmatterString(frontmatter, FRONTMATTER.shortDescription),
                status: normalizeStatus(readFrontmatterString(frontmatter, FRONTMATTER.status), settings.defaultStatus),
                assetBindings: images.bindings,
            },
            context: { file, arc, images, isUpdate, recreated },
        };
    }
    const NO_ARC = '(no arc)';
    /**
     * What uploading a note would change in Chalkenso, without uploading anything (not even images).
     * Reads the note the same way `prepareLessonUpload` does, and compares it with its lesson in a
     * manifest fetched with content (and no `since`, so every lesson carries its body). Mirrors how the
     * server applies an update: a missing arc or short description clears it, a missing slug keeps it.
     */
    async function previewLessonUpload(app, settings, file, manifest) {
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
        const base = { file, fields: [], diff: [], imageCount: 0, message: null, warning: null, uploadBlocked: null };
        if (!isNoteSyncEnabled(frontmatter)) {
            return { ...base, kind: 'skipped', message: 'Sync is turned off for this note, so it isn\'t uploaded.' };
        }
        const arcTitle = readFrontmatterString(frontmatter, FRONTMATTER.arc);
        const arc = arcTitle ? findArcByTitle(manifest, arcTitle) : null;
        const markdownContent = stripFrontmatter(await app.vault.read(file)).trim();
        if (!markdownContent) {
            return { ...base, kind: 'error', message: 'The note body is empty.' };
        }
        // A missing arc is offered for creation when the note is uploaded (see `ensureArcs`).
        const newArc = arcTitle && !arc
            ? `Arc "${arcTitle}" is not in ${manifest.version.label} yet; uploading offers to create it.`
            : null;
        const title = readFrontmatterString(frontmatter, FRONTMATTER.title) ?? file.basename;
        const slug = readFrontmatterString(frontmatter, FRONTMATTER.slug);
        const shortDescription = readFrontmatterString(frontmatter, FRONTMATTER.shortDescription);
        const status = normalizeStatus(readFrontmatterString(frontmatter, FRONTMATTER.status), settings.defaultStatus);
        const localArc = arc?.title ?? (arcTitle ? `${arcTitle} (new arc)` : NO_ARC);
        const imageCount = extractImageRefs(markdownContent).length;

        const lessonId = readFrontmatterString(frontmatter, FRONTMATTER.lessonId);
        const lesson = lessonId ? manifest.lessons.find((candidate) => candidate.id === lessonId) : null;
        if (!lesson) {
            const fields = [
                { field: 'title', from: '', to: title },
                { field: 'arc', from: '', to: localArc },
                { field: 'status', from: '', to: status },
            ];
            if (slug) {
                fields.push({ field: 'slug', from: '', to: slug });
            }
            if (shortDescription) {
                fields.push({ field: 'shortDescription', from: '', to: shortDescription });
            }
            return {
                ...base,
                kind: 'create',
                fields,
                diff: diffLines('', markdownContent),
                imageCount,
                message: lessonId ? 'This note\'s lesson is gone from Chalkenso. Uploading asks before creating it again.' : null,
                warning: newArc,
            };
        }

        const fields = [];
        const compare = (field, from, to) => {
            if (from !== to) {
                fields.push({ field, from, to });
            }
        };
        const serverArc = lesson.arcTitle ?? manifest.arcs.find((candidate) => candidate.id === lesson.arcId)?.title ?? NO_ARC;
        compare('title', lesson.title, title);
        compare('arc', serverArc, localArc);
        compare('status', lesson.status, status);
        if (slug) {
            compare('slug', lesson.slug, slug);
        }
        compare('shortDescription', lesson.shortDescription ?? '', shortDescription ?? '');
        const diff = diffLines(lesson.markdownContent ?? '', markdownContent);

        const noteRevision = readRevision(frontmatter);
        let warning = newArc;
        let uploadBlocked = null;
        if (noteRevision === null) {
            uploadBlocked = 'The note has no revision, so an upload can\'t be checked against Chalkenso. Download the folder first.';
        }
        else if (lesson.revision > noteRevision) {
            warning = [newArc, `Chalkenso has a newer version (revision ${lesson.revision}; your note is based on ${noteRevision}). ` +
                    'Uploading keeps the server\'s copy and saves it to _conflicts/ for you to compare, instead of overwriting it.']
                .filter(Boolean)
                .join(' ');
        }
        return {
            ...base,
            kind: fields.length > 0 || diffHasChanges(diff) ? 'update' : 'unchanged',
            fields,
            diff,
            imageCount,
            serverRevision: lesson.revision,
            warning,
            uploadBlocked,
        };
    }
    /**
     * Turns one server outcome into the note's frontmatter stamp and the result the caller reports.
     * `outcome` is `{ ok: true, lesson }` or `{ ok: false, status, error, conflict?, server? }` —
     * the same shape whether it came from a single request or from one entry of a batch.
     */
    async function applyLessonOutcome(app, mapping, context, outcome) {
        const { file, arc, images, isUpdate, recreated } = context;
        if (!outcome.ok) {
            // Only an update can find its lesson gone; a 404 from a create means something else.
            if (outcome.status === 404 && isUpdate) {
                return { file, outcome: 'missing', message: 'The lesson is no longer on the server.' };
            }
            if (outcome.status === 409 && outcome.conflict && outcome.server) {
                const conflictPath = await writeConflictCopy(app, mapping, file, outcome.server);
                return {
                    file,
                    outcome: 'conflict',
                    conflictPath,
                    message: `Changed on the server since your last sync; not uploaded. Server copy: ${conflictPath}.`,
                };
            }
            if (outcome.status === 409) {
                return { file, outcome: 'skipped', message: `Conflict: ${outcome.error}` };
            }
            return { file, outcome: 'error', message: outcome.error, status: outcome.status };
        }
        const lesson = outcome.lesson;
        await app.fileManager.processFrontMatter(file, (fm) => {
            fm[FRONTMATTER.lessonId] = lesson.id;
            fm[FRONTMATTER.slug] = lesson.slug;
            fm[FRONTMATTER.lessonStatus] = lesson.status;
            if (typeof lesson.revision === 'number') {
                fm[FRONTMATTER.revision] = lesson.revision;
            }
            fm[FRONTMATTER.lastSynced] = new Date().toISOString();
            fm[FRONTMATTER.syncStatus] = 'synced';
        });
        const imageNote = images.bindings.length > 0 ? ` ${images.bindings.length} image(s) synced.` : '';
        const missingNote = images.missing.length > 0
            ? ` Missing images (not found in vault): ${images.missing.join(', ')}.`
            : '';
        const verb = isUpdate ? 'Updated' : recreated ? 'Recreated (server lesson was gone)' : 'Created';
        return {
            file,
            outcome: isUpdate ? 'updated' : 'created',
            message: `${verb} lesson "${lesson.title}" ${arc ? `in ${arc.title}` : 'with no arc'}.${imageNote}${missingNote}`,
        };
    }
    /** Shapes a thrown error into the same outcome the batch route would have returned. */
    function outcomeFromError(error) {
        return error instanceof CurriculumApiError
            ? { ok: false, status: error.status, error: error.message, conflict: error.body?.conflict, server: error.body?.server }
            : { ok: false, status: undefined, error: error.message };
    }
    /**
     * Uploads one note. Outcomes besides created/updated/skipped/error:
     * - `conflict`: the server changed since the note's revision; its copy went to `_conflicts/`.
     * - `missing`: the lesson is gone from the version (404). Nothing is created here; the caller
     *   asks the user first and then calls again with `{ recreate: true }`.
     * A server-side duplicate slug (409 without a conflict body) is reported as a skip.
     */
    async function syncFile(app, settings, file, manifest, mapping, options = {}) {
        const target = syncTarget(settings, mapping);
        let prepared;
        try {
            prepared = await prepareLessonUpload(app, settings, file, manifest, mapping, options);
        }
        catch (error) {
            return { file, outcome: 'error', message: error.message, status: error instanceof CurriculumApiError ? error.status : undefined };
        }
        if (!prepared.ready) {
            return prepared.result;
        }
        const { ref, lessonId, ...payload } = prepared.request;
        try {
            const lesson = lessonId
                ? await updateLesson(target, lessonId, payload)
                : await createLesson(target, payload);
            return await applyLessonOutcome(app, mapping, prepared.context, { ok: true, lesson });
        }
        catch (error) {
            return applyLessonOutcome(app, mapping, prepared.context, outcomeFromError(error));
        }
    }
    /**
     * Uploads many notes in as few requests as the payload cap allows.
     *
     * Results are matched back to notes by the `ref` each request carried, never by position:
     * notes that resolve locally (sync disabled, empty body, no revision) never reach the server, so
     * the sent list and the file list do not line up. Pairing them by index would stamp one
     * lesson's id, slug and revision onto a different note — silently, and it would take a later
     * download overwriting the wrong file to notice.
     */
    async function syncFilesBatched(app, settings, files, manifest, mapping) {
        const target = syncTarget(settings, mapping);
        const results = [];
        const contexts = new Map();
        const requests = [];
        for (const file of files) {
            try {
                const prepared = await prepareLessonUpload(app, settings, file, manifest, mapping);
                if (!prepared.ready) {
                    results.push(prepared.result);
                    continue;
                }
                contexts.set(prepared.request.ref, prepared.context);
                requests.push(prepared.request);
            }
            catch (error) {
                results.push({ file, outcome: 'error', message: error.message, status: error instanceof CurriculumApiError ? error.status : undefined });
            }
        }
        const answered = new Set();
        for (const chunk of chunkLessonRequests(requests)) {
            let batch;
            try {
                batch = await sendLessonBatch(target, chunk);
            }
            catch (error) {
                // The whole chunk failed before anything was written; report every note in it.
                const outcome = outcomeFromError(error);
                for (const request of chunk) {
                    answered.add(request.ref);
                    const context = contexts.get(request.ref);
                    results.push(context
                        ? { file: context.file, outcome: 'error', message: outcome.error, status: outcome.status }
                        : { file: null, outcome: 'error', message: outcome.error, status: outcome.status });
                }
                continue;
            }
            for (const item of batch) {
                const context = contexts.get(item.ref);
                if (!context) {
                    // Unrecognised ref: skip it rather than guess which note it belonged to.
                    console.warn('Chalkenso: batch result with no matching note', item.ref, item);
                    continue;
                }
                answered.add(item.ref);
                results.push(await applyLessonOutcome(app, mapping, context, item));
            }
        }
        // A request the server never answered may still have been applied there, and its note is not
        // stamped — surface it rather than letting the next sync create a second lesson.
        for (const request of requests) {
            if (answered.has(request.ref)) {
                continue;
            }
            const context = contexts.get(request.ref);
            results.push({
                file: context?.file ?? null,
                outcome: 'error',
                message: 'The server did not report a result for this note; check it before syncing again.',
            });
        }
        return results;
    }
    /**
     * Collects every markdown file directly or indirectly under a mapping's folder, in the order they
     * should be synced. The server appends each new lesson after the version's last one, so the first
     * upload sets the lesson order: files are sorted by their path within the folder, naturally
     * (numeric-aware) — "Lesson 2/…" before "Lesson 10/…", "02 Setup.md" before "10 Deploy.md".
     * Ties (paths that differ only in case or accents) fall back to a plain comparison, so the order
     * never depends on the vault's file index. The folder's README.md and the plugin folders
     * (feedback, conflicts, attachments) are excluded.
     */
    function collectMarkdownFiles(app, mapping) {
        const base = normalizeFolderPath(mapping.path);
        return app.vault
            .getMarkdownFiles()
            .filter((file) => isInsideFolder(file.path, base) &&
            !isFolderReadme(file.path, base) &&
            !isPluginFolderPath(file.path, mapping))
            .sort(compareNotePaths);
    }
    function compareNotePaths(a, b) {
        return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) ||
            (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
    /** Loads the manifest for a mapping once, for reuse across a folder sync or an arc picker. */
    async function loadManifest(settings, mapping, includeContent = false, since = null) {
        return fetchManifest(syncTarget(settings, mapping), includeContent, since);
    }
    /**
     * Arc titles that notes about to be uploaded name but the version doesn't have, once each (the
     * server compares titles case-insensitively) and in upload order — so arcs created from them
     * line up the way the lessons do. Notes with sync turned off don't count.
     */
    function missingArcTitles(app, files, manifest) {
        const titles = [];
        const seen = new Set();
        for (const file of files) {
            const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
            if (!isNoteSyncEnabled(frontmatter)) {
                continue;
            }
            const title = readFrontmatterString(frontmatter, FRONTMATTER.arc);
            const key = title?.toLowerCase();
            if (title && !findArcByTitle(manifest, title) && !seen.has(key)) {
                seen.add(key);
                titles.push(title);
            }
        }
        return titles;
    }

    // ---- curriculum/disconnect
    /**
     * The plugin-owned properties that tie a note to a lesson on the active server (`dev*` names in
     * dev mode). "Disconnect" removes exactly these; `slug`, `title`, `arc`, `shortDescription`,
     * `status`, `sync`, the user's own properties and the body stay.
     */
    function connectionKeys() {
        return [
            FRONTMATTER.lessonId,
            FRONTMATTER.lessonStatus,
            FRONTMATTER.revision,
            FRONTMATTER.lastSynced,
            FRONTMATTER.syncStatus,
            FRONTMATTER.feedback,
            FRONTMATTER.coreLesson,
        ];
    }
    /** The notes among `files` that carry any connection property, i.e. that "Disconnect" changes. */
    function connectedNotes(app, files) {
        const keys = connectionKeys();
        return files.filter((file) => {
            const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
            return Boolean(frontmatter) && keys.some((key) => frontmatter[key] !== undefined);
        });
    }
    /**
     * Removes the connection properties from each note. Obsidian re-reads frontmatter in the
     * background, and everything that runs next (statuses, uploads) reads that cache, so this waits
     * until the cache has caught up. Returns the notes that could not be changed (`path (reason)`).
     */
    async function disconnectNotes(app, files) {
        const keys = connectionKeys();
        const failed = [];
        const changed = [];
        for (const file of files) {
            try {
                await app.fileManager.processFrontMatter(file, (fm) => {
                    for (const key of keys) {
                        delete fm[key];
                    }
                });
                changed.push(file);
            }
            catch (error) {
                failed.push(`${file.path} (${error.message})`);
            }
        }
        await waitForFrontmatter(app, changed, (frontmatter) => !keys.some((key) => frontmatter?.[key] !== undefined));
        return failed;
    }
    /** Resolves once `test(frontmatter)` holds for every file's cached frontmatter, or after `timeoutMs`. */
    async function waitForFrontmatter(app, files, test, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        const pending = () => files.filter((file) => !test(app.metadataCache.getFileCache(file)?.frontmatter));
        while (pending().length > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    /**
     * Where a folder's last download stamp lives. Dev mode talks to a different database, so it
     * keeps its own stamp — the same split the `dev*` frontmatter keys make.
     */
    function syncStampKey() {
        return devMode ? 'devSyncedAt' : 'syncedAt';
    }
    /** Picks one of a list of folder paths (disconnect / map a folder). */
    class PathSuggestModal extends FuzzySuggestModal {
        constructor(app, paths, placeholder, onChoose) {
            super(app);
            this.paths = paths;
            this.onChoose = onChoose;
            this.setPlaceholder(placeholder);
        }
        getItems() {
            return this.paths;
        }
        getItemText(path) {
            return path;
        }
        onChooseItem(path) {
            this.onChoose(path);
        }
    }
    /** Picks one of the account's workspaces from `/me` (map a folder). */
    class WorkspaceSuggestModal extends FuzzySuggestModal {
        constructor(app, workspaces, placeholder, onChoose) {
            super(app);
            this.workspaces = workspaces;
            this.onChoose = onChoose;
            this.setPlaceholder(placeholder);
        }
        getItems() {
            return this.workspaces;
        }
        getItemText(workspace) {
            return workspaceLabel(workspace);
        }
        onChooseItem(workspace) {
            this.onChoose(workspace);
        }
    }
    /** Modal that lets the user pick one of the version's arcs; used by "Set arc for current note". */
    class ArcSuggestModal extends FuzzySuggestModal {
        constructor(app, arcs, onChoose) {
            super(app);
            this.arcs = arcs;
            this.onChoose = onChoose;
            this.setPlaceholder('Select the arc this lesson belongs to');
        }
        getItems() {
            return this.arcs;
        }
        getItemText(arc) {
            return arc.title;
        }
        onChooseItem(arc) {
            this.onChoose(arc);
        }
    }

    // ---- curriculum/feedback
    /*
     * One checklist note per lesson with in-progress feedback from the dashboard. Each item is a
     * checkbox, the reviewer's comment (context only) and a **Plan** section. The instructor writes the
     * plan — what to change and how — and that plan is what a revision, by a person or an assistant,
     * executes. The note is the plan's source of truth: plans are sent to the task in the dashboard on
     * every feedback pull and lesson upload. Tick `[x]` when an item is done, `[-]` to skip it; ticks
     * are sent when the lesson is uploaded. Everything outside the checkboxes and plans is regenerated.
     *
     * Plan headings carry a hidden `%%plan:<taskId>:<hash>%%` marker; the hash is of the plan as last
     * agreed with the dashboard, so a pull can tell a local edit (send it) from a plan updated
     * elsewhere, e.g. from another vault (take it).
     *
     * An item the dashboard marked `aiReady` is tagged `#ai/ready` on its checkbox line and counted
     * in the note's frontmatter. That tag is the handoff: whoever cleared it there says an assistant
     * may execute the plan end to end and tick the item. Untagged items are assist-only — an
     * assistant drafts under **Plan** and leaves the edit to a person. Ticking sends the tick and
     * clears the flag in Chalkenso, so a reopened task never arrives pre-cleared.
     */
    /** Tag on a checkbox line the dashboard cleared for an assistant to execute on its own. */
    const AI_READY_TAG = '#ai/ready';
    /** Marks a checklist line with its task id; an Obsidian comment, so hidden in reading view. */
    const TASK_MARKER = /%%task:([A-Za-z0-9_-]+)%%/;
    const CHECKLIST_LINE = /^\s*[-*]\s+\[(.)\]\s.*%%task:([A-Za-z0-9_-]+)%%/;
    /** A plan heading: `#### Plan %%plan:<taskId>:<hash>%%`. */
    const PLAN_HEADING = /^#{1,6}\s+Plan\b.*%%plan:([A-Za-z0-9_-]+)(?::([0-9a-f]*))?%%\s*$/;
    /** A plan runs until the next item, plan or top-level (`#`/`##`) heading. */
    const PLAN_END = /^#{1,2}\s/;
    /** Plan text as compared and sent: line endings and trailing whitespace don't count as edits. */
    function normalizePlan(text) {
        return (text ?? '')
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .join('\n')
            .trim();
    }
    /** Short FNV-1a hash of a normalized plan (change detection only). */
    function hashPlan(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }
    /** True when a plan read from the note (`{ text, base }`) was edited since it last matched the dashboard. */
    function isPlanEdited(plan) {
        return plan.base === null ? plan.text !== '' : hashPlan(plan.text) !== plan.base;
    }
    /** Plan counts for a feedback note: items with a plan section, plans written, plans not yet sent. */
    function planSummary(content) {
        const plans = [...parsePlans(content).values()];
        return {
            items: plans.length,
            written: plans.filter((plan) => plan.text).length,
            pending: plans.filter(isPlanEdited).length,
        };
    }
    /** Re-stamps the markers of plans the dashboard now has (`taskId → sent text`), leaving the rest of the note alone. */
    function markPlansSynced(content, sent) {
        return content.replace(/%%plan:([A-Za-z0-9_-]+)(?::[0-9a-f]*)?%%/g, (marker, taskId) => sent.has(taskId) ? `%%plan:${taskId}:${hashPlan(sent.get(taskId))}%%` : marker);
    }
    /** Plans in a feedback note, keyed by task id: `{ text, base }` (base = hash last agreed). */
    function parsePlans(content) {
        const plans = new Map();
        let current = null;
        const close = () => {
            if (current) {
                plans.set(current.id, { text: normalizePlan(current.lines.join('\n')), base: current.base });
            }
            current = null;
        };
        for (const line of content.split(/\r?\n/)) {
            const heading = PLAN_HEADING.exec(line);
            if (heading) {
                close();
                current = { id: heading[1], base: heading[2] || null, lines: [] };
                continue;
            }
            if (CHECKLIST_LINE.test(line) || PLAN_END.test(line)) {
                close();
                continue;
            }
            current?.lines.push(line);
        }
        close();
        return plans;
    }
    /** Ticked items in a feedback note: `[x]` → DONE, `[-]` → IGNORED; `[ ]` is still open. */
    function parseTicks(content) {
        const ticks = new Map();
        for (const line of content.split(/\r?\n/)) {
            const match = CHECKLIST_LINE.exec(line);
            if (!match) {
                continue;
            }
            const mark = match[1].toLowerCase();
            if (mark === 'x') {
                ticks.set(match[2], 'DONE');
            }
            else if (mark === '-') {
                ticks.set(match[2], 'IGNORED');
            }
        }
        return ticks;
    }
    /** Ticks every still-open checklist item (the "Mark lesson feedback done" command). */
    function tickAll(content) {
        return content
            .split('\n')
            .map((line) => TASK_MARKER.test(line) ? line.replace(/^(\s*[-*]\s+)\[ \]/, '$1[x]') : line)
            .join('\n');
    }
    function readFrontmatter(app, file) {
        return app.metadataCache.getFileCache(file)?.frontmatter;
    }
    function readString(frontmatter, key) {
        const value = frontmatter?.[key];
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
    function sanitizeFileName(value) {
        const cleaned = value
            .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100)
            .trim();
        return cleaned || 'Lesson';
    }
    function quote(text) {
        return text
            .trim()
            .split(/\r?\n/)
            .map((line) => `> ${line}`)
            .join('\n');
    }
    /** Context around the highlighted passage, trimmed to a readable excerpt. */
    const CONTEXT_RADIUS = 240;
    function contextExcerpt(context, selected) {
        const text = context.trim();
        const at = text.indexOf(selected.trim());
        if (!text || text === selected.trim()) {
            return null;
        }
        if (text.length <= selected.length + CONTEXT_RADIUS * 2 || at < 0) {
            return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
        }
        const start = Math.max(0, at - CONTEXT_RADIUS);
        const end = Math.min(text.length, at + selected.trim().length + CONTEXT_RADIUS);
        return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
    }
    function checkbox(tick) {
        return tick === 'DONE' ? '[x]' : tick === 'IGNORED' ? '[-]' : '[ ]';
    }
    /** A callout of context blocks (each block's lines prefixed; blank lines keep the callout open). */
    function callout(header, blocks) {
        const body = blocks
            .filter((block) => block.trim())
            .map((block) => block
            .trim()
            .split(/\r?\n/)
            .map((line) => (line ? `> ${line}` : '>'))
            .join('\n'))
            .join('\n>\n');
        return body ? `> ${header}\n${body}` : `> ${header}`;
    }
    /** `plan` is `{ text, base }`: the plan and the hash of the version the dashboard has. */
    function renderPlan(task, plan) {
        const heading = `#### Plan %%plan:${task.id}:${plan.base}%%`;
        return plan.text ? `${heading}\n\n${plan.text}` : heading;
    }
    function notesBlocks(task) {
        return task.notes.map((note) => `**Note from ${note.authorName}:** ${note.body.trim()}`);
    }
    /** The handoff tag, as it sits on a checkbox line (empty when the item is assist-only). */
    function aiTag(task) {
        return task.aiReady ? ` ${AI_READY_TAG}` : '';
    }
    /** One piece of feedback as callout blocks: the passage, what was said, where, and the reply. */
    function commentBlocks(comment, heading) {
        const blocks = [];
        if (heading) {
            blocks.push(`**${heading}:**`);
        }
        blocks.push(quote(comment.selectedText));
        blocks.push(comment.body.trim());
        const excerpt = comment.context ? contextExcerpt(comment.context, comment.selectedText) : null;
        if (excerpt) {
            blocks.push(`**In context:**\n${quote(excerpt)}`);
        }
        if (comment.adminResponse?.trim()) {
            blocks.push(`**Reply to reviewer:** ${comment.adminResponse.trim()}`);
        }
        return blocks;
    }
    function renderItem(task, tick, plan) {
        const parts = [`- ${checkbox(tick)} **${task.title}**${aiTag(task)} %%task:${task.id}%%`];
        // One improvement per lesson uses several pieces of feedback (older servers send only one).
        const comments = task.sourceComments ?? (task.sourceComment ? [task.sourceComment] : []);
        const comment = comments[0];
        const instructions = task.description?.trim();
        const blocks = [];
        comments.forEach((each) => {
            blocks.push(...commentBlocks(each, comments.length > 1 ? each.proposerName : null));
        });
        // Promoted tasks default their instructions to the comment body; only show them when edited.
        if (instructions && instructions !== comment?.body.trim()) {
            blocks.push(`**Dashboard instructions:** ${instructions}`);
        }
        // The instructor's own words about the change, for whoever plans or drafts it.
        if (task.aiNotes?.trim()) {
            blocks.push(`**Notes for AI:** ${task.aiNotes.trim()}`);
        }
        blocks.push(...notesBlocks(task));
        if (blocks.length > 0) {
            const who = comments.length > 1 ? `${comments.length} pieces of feedback` : comment?.proposerName ?? task.proposerName;
            parts.push(callout(`[!quote] ${who ? (comments.length > 1 ? who : `${who} commented`) : 'Context'}`, blocks));
        }
        parts.push(renderPlan(task, plan));
        return parts.join('\n\n');
    }
    function renderBrief(task, tick, plan) {
        const parts = [`- ${checkbox(tick)} **Revision brief**${aiTag(task)} %%task:${task.id}%%`];
        const blocks = [task.description?.trim() ?? '', task.aiNotes?.trim() ? `**Notes for AI:** ${task.aiNotes.trim()}` : '', ...notesBlocks(task)];
        if (blocks.some((block) => block)) {
            parts.push(callout('[!quote] Brief from the dashboard', blocks));
        }
        parts.push(renderPlan(task, plan));
        return parts.join('\n\n');
    }
    function renderFeedback(lesson, lessonLink, tasks, ticks, plans) {
        const brief = tasks.find((task) => task.isBrief);
        const items = tasks.filter((task) => !task.isBrief);
        const open = tasks.filter((task) => !ticks.has(task.id)).length;
        // Only still-open items count: a ticked one is finished work, whoever did it.
        const aiReady = tasks.filter((task) => task.aiReady && !ticks.has(task.id)).length;
        const planFor = (task) => plans.get(task.id) ?? { text: '', base: hashPlan('') };
        const frontmatter = {
            [FRONTMATTER.lessonId]: lesson.id,
            lesson: lessonLink ?? lesson.title,
            open,
            // Lets one Dataview query across the vault list what an assistant may pick up.
            aiReady,
        };
        const sections = [
            `# Feedback: ${lessonLink ?? `Lesson ${lesson.position}: ${lesson.title}`}`,
            '> [!info] How to use this note\n' +
                "> Write what should change under each item's **Plan**: that plan is what the revision " +
                'executes, and it is sent to the task in the dashboard on every feedback pull and lesson ' +
                'upload. Comments are context only.\n' +
                '> Tick `[x]` when an item is done or `[-]` to skip it; ticked items close when the lesson ' +
                'is uploaded. Everything except the checkboxes and plans is replaced on the next pull.\n' +
                `> An item tagged \`${AI_READY_TAG}\` is cleared for an assistant: it may edit the lesson ` +
                'to the plan and tick the item itself. Untagged items are assist-only — an assistant ' +
                'writes its proposal under **Plan** and leaves the lesson to you.',
        ];
        if (brief) {
            sections.push(`## Brief\n\n${renderBrief(brief, ticks.get(brief.id), planFor(brief))}`);
        }
        if (items.length > 0) {
            sections.push(`## Items\n\n${items
                .map((item) => renderItem(item, ticks.get(item.id), planFor(item)))
                .join('\n\n')}`);
        }
        return `---\n${stringifyYaml(frontmatter)}---\n\n${sections.join('\n\n')}\n`;
    }
    /** Feedback notes in the mapping's active feedback folder, keyed by lesson id. */
    function collectFeedbackFiles(app, mapping) {
        const prefix = `${feedbackFolderPath(mapping)}/`;
        const byLesson = new Map();
        for (const file of app.vault.getMarkdownFiles()) {
            if (!file.path.startsWith(prefix)) {
                continue;
            }
            const lessonId = readString(readFrontmatter(app, file), FRONTMATTER.lessonId);
            if (lessonId) {
                byLesson.set(lessonId, file);
            }
        }
        return byLesson;
    }
    /** Local lesson notes keyed by lesson id, so feedback notes can link back to the note to edit. */
    function lessonNotesById(app, mapping) {
        const byId = new Map();
        for (const file of collectMarkdownFiles(app, mapping)) {
            const lessonId = readString(readFrontmatter(app, file), FRONTMATTER.lessonId);
            if (lessonId) {
                byId.set(lessonId, file);
            }
        }
        return byId;
    }
    /**
     * Sets (or clears, with null) the lesson note's `feedback` link. Frontmatter is stripped before
     * upload, so when the note was in sync before, its sync stamp is moved along with the write and
     * the note does not show as "edited since last sync".
     */
    async function setLessonFeedbackLink(app, lessonFile, link) {
        const frontmatter = readFrontmatter(app, lessonFile);
        const current = readString(frontmatter, FRONTMATTER.feedback);
        if (current === link || (!current && !link)) {
            return;
        }
        const wasSynced = computeNoteStatus(frontmatter, lessonFile.stat.mtime) === 'synced';
        await app.fileManager.processFrontMatter(lessonFile, (fm) => {
            if (link) {
                fm[FRONTMATTER.feedback] = link;
            }
            else {
                delete fm[FRONTMATTER.feedback];
            }
            if (wasSynced && fm[FRONTMATTER.lastSynced]) {
                fm[FRONTMATTER.lastSynced] = new Date().toISOString();
            }
        });
    }
    /**
     * Sets (or clears, with null) a group lesson note's `coreLesson` link. Like the feedback link, a
     * note that was in sync stays in sync (frontmatter is never uploaded).
     */
    async function setLessonCoreLink(app, lessonFile, link) {
        const frontmatter = readFrontmatter(app, lessonFile);
        const current = readString(frontmatter, FRONTMATTER.coreLesson);
        if (current === link || (!current && !link)) {
            return false;
        }
        const wasSynced = computeNoteStatus(frontmatter, lessonFile.stat.mtime) === 'synced';
        await app.fileManager.processFrontMatter(lessonFile, (fm) => {
            if (link) {
                fm[FRONTMATTER.coreLesson] = link;
            }
            else {
                delete fm[FRONTMATTER.coreLesson];
            }
            if (wasSynced && fm[FRONTMATTER.lastSynced]) {
                fm[FRONTMATTER.lastSynced] = new Date().toISOString();
            }
        });
        return true;
    }
    async function ensureFolder(app, path) {
        if (!(app.vault.getAbstractFileByPath(path) instanceof TFolder)) {
            await app.vault.createFolder(path);
        }
    }
    /**
     * Reconciles a task's plan (`{ text, base }`): a plan edited in the note is sent to the dashboard
     * (and kept, sent or not); an unedited one takes the dashboard's version, which may have come from
     * another vault. Without write access, edited plans stay local until they can be sent.
     */
    async function reconcilePlan(settings, mapping, task, local, canWrite, result) {
        const remote = normalizePlan(task.plan);
        if (!local || !isPlanEdited(local) || local.text === remote) {
            return { text: remote, base: hashPlan(remote) };
        }
        // Keep the old base on failure so the plan still counts as edited and is retried.
        const unsent = { text: local.text, base: local.base ?? hashPlan('') };
        if (!canWrite) {
            return unsent;
        }
        try {
            await updateTask(syncTarget(settings, mapping), task.id, { plan: local.text });
            result.plansSent++;
            return { text: local.text, base: hashPlan(local.text) };
        }
        catch (error) {
            result.plansFailed++;
            console.warn(`Chalkenso: could not send the plan for ${task.id}`, error);
            return unsent;
        }
    }
    /**
     * Mirrors the dashboard's in-progress feedback into one note per lesson. Plans edited in the note
     * are sent first (with `canWrite`); local ticks that have not been sent yet are kept; items closed
     * or moved back in the dashboard drop out; lessons with nothing left lose their note and their
     * `feedback` link.
     */
    async function pullFeedback(app, settings, mapping, canWrite = true) {
        const result = { lessons: 0, items: 0, removed: 0, plansSent: 0, plansFailed: 0 };
        const tasks = await fetchTasks(syncTarget(settings, mapping));
        const byLesson = new Map();
        for (const task of tasks) {
            if (task.lesson) {
                byLesson.set(task.lesson.id, [...(byLesson.get(task.lesson.id) ?? []), task]);
            }
        }
        const folder = feedbackFolderPath(mapping);
        const existing = collectFeedbackFiles(app, mapping);
        const lessonNotes = lessonNotesById(app, mapping);
        for (const [lessonId, file] of existing) {
            if (!byLesson.has(lessonId)) {
                await app.vault.trash(file, false);
                result.removed++;
            }
        }
        for (const [lessonId, lessonFile] of lessonNotes) {
            if (!byLesson.has(lessonId)) {
                await setLessonFeedbackLink(app, lessonFile, null);
            }
        }
        if (byLesson.size > 0) {
            await ensureFolder(app, folder);
        }
        for (const [lessonId, lessonTasks] of byLesson) {
            const lesson = lessonTasks[0].lesson;
            const lessonFile = lessonNotes.get(lessonId) ?? null;
            // Prefixed so the note never shares a basename with the lesson (keeps [[links]] unambiguous).
            const lessonName = lessonFile?.basename ?? `Lesson ${lesson.position} - ${lesson.title}`;
            const path = normalizePath(`${folder}/${sanitizeFileName(`Feedback - ${lessonName}`)}.md`);
            const lessonLink = lessonFile
                ? `[[${app.metadataCache.fileToLinktext(lessonFile, path, true)}]]`
                : null;
            let file = existing.get(lessonId) ?? null;
            const current = file ? await app.vault.read(file) : '';
            const ticks = parseTicks(current);
            const localPlans = parsePlans(current);
            const plans = new Map();
            for (const task of lessonTasks) {
                plans.set(task.id, await reconcilePlan(settings, mapping, task, localPlans.get(task.id), canWrite, result));
            }
            const content = renderFeedback(lesson, lessonLink, lessonTasks, ticks, plans);
            if (file && file.path !== path && !app.vault.getAbstractFileByPath(path)) {
                await app.fileManager.renameFile(file, path);
            }
            if (file) {
                if ((await app.vault.read(file)) !== content) {
                    await app.vault.modify(file, content);
                }
            }
            else {
                file = await app.vault.create(path, content);
            }
            if (lessonFile) {
                const feedbackLink = `[[${app.metadataCache.fileToLinktext(file, lessonFile.path, true)}]]`;
                await setLessonFeedbackLink(app, lessonFile, feedbackLink);
            }
            result.lessons++;
            result.items += lessonTasks.length;
        }
        return result;
    }
    /** The feedback note for a lesson note (or the feedback note itself), if one exists. */
    function findFeedbackFile(app, mapping, file) {
        if (file.path.startsWith(`${feedbackFolderPath(mapping)}/`)) {
            return file;
        }
        const lessonId = readString(readFrontmatter(app, file), FRONTMATTER.lessonId);
        return lessonId ? collectFeedbackFiles(app, mapping).get(lessonId) ?? null : null;
    }
    /**
     * Sends a lesson's ticked items to the dashboard (DONE / IGNORED), each with its plan when that was
     * edited, so the plan that was executed is recorded on the closed task. Called after the lesson
     * itself synced, so feedback only closes once the fixed content is on the server. Items the
     * dashboard no longer has (404) count as sent; failures stay ticked locally and are retried on the
     * next sync. Open items' plans are sent by the pull that follows, which also refreshes the note.
     */
    async function pushLessonTicks(app, settings, mapping, lessonFile) {
        const result = { pushed: 0, failed: 0 };
        const feedbackFile = findFeedbackFile(app, mapping, lessonFile);
        if (!feedbackFile) {
            return result;
        }
        const content = await app.vault.read(feedbackFile);
        const plans = parsePlans(content);
        for (const [taskId, status] of parseTicks(content)) {
            const plan = plans.get(taskId);
            try {
                await updateTask(syncTarget(settings, mapping), taskId, {
                    status,
                    ...(plan && isPlanEdited(plan) ? { plan: plan.text } : {}),
                    // The clearance was for this revision; reopening the task asks for it again.
                    aiReady: false,
                });
                result.pushed++;
            }
            catch (error) {
                if (error instanceof CurriculumApiError && error.status === 404) {
                    result.pushed++;
                    continue;
                }
                result.failed++;
                console.warn(`Chalkenso: could not close feedback ${taskId}`, error);
            }
        }
        return result;
    }

    // ---- curriculum/main
    const STATUS_LABEL = {
        syncing: 'Syncing…',
        disabled: 'Sync off',
        'not-synced': 'Not in Chalkenso',
        pending: 'Edited since sync',
        'readonly-edit': 'Local edit (read-only)',
        conflict: 'Conflict (server copy in _conflicts)',
        orphaned: 'Deleted on server (kept: local edits)',
        synced: 'Synced',
    };
    /** Folder roll-up precedence: the first status present among a folder's notes wins. */
    const FOLDER_STATUS_ORDER = [
        'syncing',
        'conflict',
        'orphaned',
        'readonly-edit',
        'pending',
        'not-synced',
        'synced',
        'disabled',
    ];
    /** Up to `max` names from a list, for notices ("a, b, c and 4 more"). */
    function listNames(names, max = 6) {
        if (names.length <= max) {
            return names.join(', ');
        }
        return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
    }
    class CurriculumController extends Plugin {
        constructor() {
            super(...arguments);
            this.settings = DEFAULT_SETTINGS;
            this.statusBarEl = null;
            this.arcStatusBarEl = null;
            /** "Show changes" button, shown while the active lesson has edits Chalkenso doesn't have. */
            this.changesStatusBarEl = null;
            /** "Curriculum Updates · Plan" indicator, shown on feedback notes. */
            this.planStatusBarEl = null;
            /** Feedback note whose plans are uploading right now. */
            this.planUploadingPath = null;
            /** Paths of notes currently uploading, so the explorer/status bar can show a spinner. */
            this.syncingPaths = new Set();
            /** Mapping paths with a download/upload/sync running, so one can't start twice. */
            this.busyMappings = new Set();
            /** Version ids that answered 410 group_curriculum_closed: their group folder is cleaned up. */
            this.closedVersions = new Set();
            /** Group mappings (by version id) whose clean-up is running or was cancelled; they are not synced. */
            this.removingVersions = new Set();
            this.skippedRemovals = new Set();
        }
        /** Command whose target is the active markdown note. */
        addNoteCommand(id, name, run, applies = () => true) {
            this.addCommand({
                id,
                name,
                checkCallback: (checking) => {
                    const file = this.app.workspace.getActiveFile();
                    if (!file || file.extension !== 'md' || !applies(file)) {
                        return false;
                    }
                    if (!checking) {
                        void run(file);
                    }
                    return true;
                },
            });
        }
        async onload() {
            await this.loadSettings();
            setGroupClosedListener((versionId) => this.onGroupClosed(versionId));
            this.addNoteCommand('set-arc-for-current-note', 'Set arc for current note', (file) => this.setArcForNote(file));
            this.addNoteCommand('sync-current-note', 'Upload current note', (file) => this.syncCurrentNote(file));
            this.addNoteCommand('show-changes', 'Show changes in current note (compared with Chalkenso)', (file) => this.showLessonChanges(file));
            // Folder commands act on the curriculum folder of the active note.
            this.addNoteCommand('sync-current-folder', 'Sync current folder (upload, then download)', (file) => this.runForFileMapping(file, 'sync'));
            this.addNoteCommand('upload-current-folder', 'Upload current folder', (file) => this.runForFileMapping(file, 'upload'));
            this.addNoteCommand('download-current-folder', 'Download current folder', (file) => this.runForFileMapping(file, 'download'));
            this.addCommand({
                id: 'sync-all-folders',
                name: 'Sync all curriculum folders (upload, then download)',
                callback: () => void this.runForAllMappings('sync'),
            });
            this.addCommand({
                id: 'upload-all-folders',
                name: 'Upload all curriculum folders',
                callback: () => void this.runForAllMappings('upload'),
            });
            this.addCommand({
                id: 'download-all-folders',
                name: 'Download all curriculum folders',
                callback: () => void this.runForAllMappings('download'),
            });
            this.addCommand({
                id: 'download-group-curricula',
                name: 'Download all group curricula',
                callback: () => void this.runForGroupMappings('download'),
            });
            this.addCommand({
                id: 'sync-group-curricula',
                name: 'Sync all group curricula (upload, then download)',
                callback: () => void this.runForGroupMappings('sync'),
            });
            this.addNoteCommand('delete-lesson-on-server', 'Delete lesson on server (keeps the note)', (file) => this.confirmDeleteLesson(file), (file) => this.hasLessonId(file) && this.canDeleteIn(findFolderMapping(this.settings, file.path)));
            this.addNoteCommand('resolve-conflict-keep-local', 'Resolve conflict: keep my version', (file) => this.resolveConflict(file, 'local'), (file) => Boolean(this.conflictFileFor(file)));
            this.addNoteCommand('resolve-conflict-use-server', 'Resolve conflict: use server version', (file) => this.resolveConflict(file, 'server'), (file) => Boolean(this.conflictFileFor(file)));
            this.addNoteCommand('toggle-sync-for-current-note', 'Toggle sync for current note', (file) => this.toggleNoteSync(file));
            // Moving a folder over from another server (or giving an existing folder a version).
            this.addCommand({
                id: 'map-folder',
                name: 'Map folder to a curriculum version',
                callback: () => void this.mapFolderToWorkspace(),
            });
            this.addCommand({
                id: 'disconnect-folder',
                name: 'Disconnect folder from its previous server',
                callback: () => void this.disconnectFolder(),
            });
            this.addNoteCommand('show-sync-status-for-current-note', 'Show sync status for current note', (file) => this.showNoteStatus(file));
            this.addCommand({
                id: 'pull-feedback',
                name: 'Pull feedback',
                callback: () => void this.pullAllFeedback(),
            });
            this.addCommand({
                id: 'upload-feedback-plan',
                name: 'Upload feedback plan',
                checkCallback: (checking) => {
                    const active = this.activePlanNote();
                    if (!active) {
                        return false;
                    }
                    if (!checking) {
                        void this.uploadPlans(active.file);
                    }
                    return true;
                },
            });
            this.addCommand({
                id: 'mark-lesson-feedback-done',
                name: 'Mark lesson feedback done',
                checkCallback: (checking) => {
                    const feedbackFile = this.activeFeedbackFile();
                    if (!feedbackFile) {
                        return false;
                    }
                    if (!checking) {
                        void this.markFeedbackDone(feedbackFile);
                    }
                    return true;
                },
            });
            // Status-bar indicator for the active note; click for its actions (all actions live there).
            this.statusBarEl = this.addStatusBarItem();
            this.statusBarEl.addClass('chalkenso-lesson-statusbar');
            this.statusBarEl.onClickEvent((evt) => this.openMenu(evt));
            // Arc indicator for the active note; click to set/change its arc.
            this.arcStatusBarEl = this.addStatusBarItem();
            this.arcStatusBarEl.addClass('chalkenso-arc-statusbar');
            this.arcStatusBarEl.onClickEvent(() => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    void this.setArcForNote(file);
                }
            });
            // "Show changes" for a lesson edited since its last upload: what an upload would change in Chalkenso.
            this.changesStatusBarEl = this.addStatusBarItem();
            this.changesStatusBarEl.addClass('chalkenso-changes-statusbar');
            this.changesStatusBarEl.toggle(false);
            this.changesStatusBarEl.onClickEvent(() => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    void this.showLessonChanges(file);
                }
            });
            // Plan indicator for feedback notes; click for the plan actions (upload, pull, mark done).
            this.planStatusBarEl = this.addStatusBarItem();
            this.planStatusBarEl.addClass('chalkenso-plan-statusbar');
            this.planStatusBarEl.onClickEvent((evt) => this.openMenu(evt));
            // Repaint the plan state while typing, not only once the note is saved.
            this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
                if (info?.file && info.file === this.app.workspace.getActiveFile()) {
                    this.updatePlanStatus(editor.getValue());
                }
            }));
            // Keep the status bar and explorer badges in sync with the vault and active note.
            this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
            this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshExplorerBadges()));
            this.registerEvent(this.app.metadataCache.on('changed', (file) => {
                this.updateStatusBar();
                this.refreshExplorerBadges(file);
            }));
            this.registerEvent(this.app.vault.on('rename', () => this.refreshExplorerBadges()));
            this.registerEvent(this.app.vault.on('create', () => this.refreshExplorerBadges()));
            // Removing a note changes its folders' roll-up dots (and a removed conflict copy clears a conflict).
            this.registerEvent(this.app.vault.on('delete', () => {
                this.refreshExplorerBadges();
                this.updateStatusBar();
            }));
            // A local edit bumps the note's mtime past its last sync — repaint so it flips to "pending".
            this.registerEvent(this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    this.refreshExplorerBadges(file);
                }
                this.updateStatusBar();
            }));
            // Right-click a folder (to map it) or a note (to act on it) in the file explorer.
            this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.buildFileMenu(menu, file)));
            // Right-click inside a note: the actions for that note.
            this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
                if (info?.file instanceof TFile && info.file.extension === 'md') {
                    this.buildNoteMenu(menu, info.file, editor.getValue());
                }
            }));
            this.app.workspace.onLayoutReady(() => {
                this.updateStatusBar();
                this.refreshExplorerBadges();
            });
        }
        async loadSettings() {
            // Only this version's settings, and only folders that belong to an organisation.
            const data = (await this.loadData()) ?? {};
            this.settings = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, key in data ? data[key] : value]));
            this.settings.folders = (Array.isArray(this.settings.folders) ? this.settings.folders : []).filter((mapping) => mapping?.connection);
            setDevMode(this.settings.devMode);
        }
        async saveSettings() {
            await this.saveData(this.settings);
            setDevMode(this.settings.devMode);
            // Folder toggles / version changes can change every note's effective status.
            this.updateStatusBar();
            this.refreshExplorerBadges();
        }
        // ------------------------------------------------------------------------------------------
        // Workspaces (versions)
        // ------------------------------------------------------------------------------------------
        onunload() {
            setGroupClosedListener(null);
        }
        // ------------------------------------------------------------------------------------------
        // Permissions (from /me)
        // ------------------------------------------------------------------------------------------
        /**
         * The `/me` workspace of a mapping (its organisation, active server), or null when that `/me`
         * isn't loaded or doesn't list it.
         */
        workspaceFor(mapping) {
            const versionId = mapping ? activeVersionId(this.settings, mapping) : '';
            if (!versionId) {
                return null;
            }
            return (this.host.currentWorkspaces(mapping.connection) ?? []).find((workspace) => workspace.id === versionId) ?? null;
        }
        /** The mapping's permissions from `/me`, or null when unknown (offline, `/me` failed, not listed). */
        workspacePermissions(mapping) {
            const workspace = this.workspaceFor(mapping);
            return workspace && Array.isArray(workspace.permissions) ? workspace.permissions : null;
        }
        /** True only when `/me` says the workspace lacks WRITE. Unknown permissions: try, and handle a 403. */
        isReadOnly(mapping) {
            const permissions = this.workspacePermissions(mapping);
            return Boolean(permissions) && !permissions.includes('WRITE');
        }
        canDeleteIn(mapping) {
            if (!mapping) {
                return false;
            }
            const permissions = this.workspacePermissions(mapping);
            return !permissions || permissions.includes('DELETE');
        }
        /** Ticked feedback is sent only with WRITE + TASKS (unknown permissions: try). */
        canPushTicks(mapping) {
            const permissions = this.workspacePermissions(mapping);
            return !permissions || hasPermission(permissions, 'WRITE', 'TASKS');
        }
        /** Feedback is pulled only with READ + TASKS (unknown permissions: try). */
        canPullFeedback(mapping) {
            const permissions = this.workspacePermissions(mapping);
            return !permissions || hasPermission(permissions, 'READ', 'TASKS');
        }
        // ------------------------------------------------------------------------------------------
        // Group curricula (managed folders)
        // ------------------------------------------------------------------------------------------
        /** The managed group mapping (active server) for a version id, if any. */
        managedMappingFor(versionId) {
            return this.settings.folders.find((mapping) => isManagedGroup(mapping) &&
                isInActiveEnv(this.settings, mapping) &&
                activeVersionId(this.settings, mapping) === versionId) ?? null;
        }
        /**
         * Why a managed group mapping must not sync right now: `closed` (a 410 said so), `gone` (a
         * successful `/me` of its organisation's token doesn't list it), `other-account` (the token
         * belongs to someone else), or null. A failed / missing `/me` never makes a group gone, and
         * only the group's own organisation decides: another organisation's list never does.
         */
        groupState(mapping) {
            if (!isManagedGroup(mapping)) {
                return null;
            }
            const versionId = activeVersionId(this.settings, mapping);
            if (this.closedVersions.has(versionId)) {
                return 'closed';
            }
            const me = this.host.currentMe(mapping.connection)?.data;
            if (!me || !Array.isArray(me.workspaces)) {
                return null;
            }
            if (mapping.userId && me.user?.id && mapping.userId !== me.user.id) {
                return 'other-account';
            }
            return me.workspaces.some((workspace) => workspace.id === versionId) ? null : 'gone';
        }
        /**
         * Called after every successful `/me` of an organisation (settings open, Refresh, start of Sync /
         * Download all): refreshes the cached names of that organisation's group folders you chose,
         * keeps their README current, and returns its mappings whose workspace is no longer listed (to
         * clean up). New group workspaces are not added here; they are offered as checkboxes in
         * settings. The folder of an existing mapping is never moved or renamed; a renamed folder is
         * followed.
         */
        async reconcileGroups(me, connection) {
            const result = { gone: [] };
            if (!me || !Array.isArray(me.workspaces) || !connection) {
                return result;
            }
            const userId = me.user?.id ?? null;
            let changed = false;
            for (const workspace of me.workspaces.filter((candidate) => candidate.kind === 'group')) {
                const mapping = this.managedMappingFor(workspace.id);
                if (!mapping || mapping.connection !== connection.id) {
                    continue;
                }
                if (this.applyGroupFields(mapping, workspace, userId)) {
                    changed = true;
                }
                try {
                    await ensureFolderPath(this.app, normalizeFolderPath(mapping.path));
                    if (await this.writeGroupReadme(mapping, workspace)) {
                        changed = true;
                    }
                }
                catch (error) {
                    console.warn(`Chalkenso: could not prepare group folder "${mapping.path}"`, error);
                }
            }
            for (const mapping of this.settings.folders) {
                if (isManagedGroup(mapping) && mapping.connection === connection.id && isInActiveEnv(this.settings, mapping) && this.groupState(mapping) === 'gone') {
                    result.gone.push(mapping);
                }
            }
            if (changed) {
                await this.saveSettings();
            }
            return result;
        }
        /** Copies a group workspace's names onto its mapping; true when anything changed. */
        applyGroupFields(mapping, workspace, userId) {
            const fields = {
                groupId: workspace.group?.id ?? null,
                groupName: workspace.group?.name ?? workspace.label ?? null,
                courseTitle: workspace.course?.title,
                versionLabel: workspace.label,
                baseVersionLabel: workspace.baseVersion?.label ?? null,
                userId,
            };
            let changed = false;
            for (const [key, value] of Object.entries(fields)) {
                if (mapping[key] !== value) {
                    mapping[key] = value;
                    changed = true;
                }
            }
            return changed;
        }
        /** The mapping (active server) that syncs a workspace, if any: a chosen folder or an older hand-made one. */
        mappingForWorkspace(versionId) {
            return this.settings.folders.find((mapping) => isMappingOn(this.settings, mapping) &&
                activeVersionId(this.settings, mapping) === versionId) ?? null;
        }
        /**
         * Chosen in settings: gives a workspace its folder in its organisation's folder
         * (`<Organisation>/Curriculums/…` or `<Organisation>/Groups/…`), creating the folder (and a
         * group's README). An existing folder of that name is reused, so its notes are matched to the
         * lessons by the first download. `path` maps a folder of your choice instead ("Map folder to a
         * curriculum version"). Returns the mapping; the caller downloads it.
         */
        async addWorkspaceFolder(workspace, connection, path = null) {
            const existing = this.mappingForWorkspace(workspace.id);
            if (existing) {
                return existing;
            }
            if (!path && !curriculumsRootOf(connection)) {
                throw new Error(`${organizationLabel(connection)} has no folder yet; open Settings → Chalkenso once its account has loaded.`);
            }
            const group = workspace.kind === 'group';
            const userId = this.host.currentMe(connection.id)?.data?.user?.id ?? connection.userId ?? null;
            const mapping = {
                path: path ? normalizeFolderPath(path) : this.freeGroupFolderPath(workspaceFolderPath(this.settings, workspace, connection)),
                env: activeEnv(this.settings),
                connection: connection.id,
                versionId: '',
                devVersionId: '',
                ...(group ? { managed: MANAGED_GROUP } : {}),
            };
            setActiveVersionId(this.settings, mapping, workspace.id);
            if (group) {
                this.applyGroupFields(mapping, workspace, userId);
            }
            else {
                mapping.courseTitle = workspace.course?.title;
                mapping.versionLabel = workspace.label;
            }
            this.settings.folders.push(mapping);
            await ensureFolderPath(this.app, normalizeFolderPath(mapping.path));
            if (group) {
                try {
                    await this.writeGroupReadme(mapping, workspace);
                }
                catch (error) {
                    console.warn(`Chalkenso: could not write the README of "${mapping.path}"`, error);
                }
            }
            await this.saveSettings();
            return mapping;
        }
        /** Unchosen in settings: stops syncing the folder. The folder and its notes stay in the vault. */
        async removeWorkspaceMapping(mapping) {
            this.settings.folders = this.settings.folders.filter((candidate) => candidate !== mapping);
            await this.saveSettings();
        }
        /** `path`, or `path (2)`, … when another mapping already uses it (an unmapped folder there is reused). */
        freeGroupFolderPath(base) {
            const taken = (path) => this.settings.folders.some((mapping) => normalizeFolderPath(mapping.path ?? '') === path) ||
                this.app.vault.getAbstractFileByPath(path) instanceof TFile;
            let path = base;
            for (let n = 2; taken(path) && n < 1000; n++) {
                path = `${base} (${n})`;
            }
            return path;
        }
        /**
         * Writes the group folder's README.md when it is missing, or when it still has the text the
         * plugin wrote last time and the text should change. A README the user edited is left alone.
         * Returns true when the mapping's stored README hash changed.
         */
        async writeGroupReadme(mapping, workspace) {
            const root = normalizeFolderPath(mapping.path);
            const path = normalizePath(`${root}/README.md`);
            const content = groupReadmeContent(workspace);
            const hash = hashText(content);
            const existing = this.app.vault.getFiles().find((file) => file.path.toLowerCase() === path.toLowerCase()) ?? null;
            if (existing) {
                const current = await this.app.vault.read(existing);
                if (current === content) {
                    if (mapping.readmeHash === hash) {
                        return false;
                    }
                    mapping.readmeHash = hash;
                    return true;
                }
                if (mapping.readmeHash && hashText(current) === mapping.readmeHash) {
                    await this.app.vault.modify(existing, content);
                    mapping.readmeHash = hash;
                    return true;
                }
                return false; // edited by the user (or not ours): leave it
            }
            await this.app.vault.create(path, content);
            mapping.readmeHash = hash;
            return true;
        }
        /** Remembers images a download wrote into a group folder, so a clean-up can tell them from the user's files. */
        recordDownloadedFiles(mapping, paths) {
            if (!isManagedGroup(mapping) || paths.length === 0) {
                return false;
            }
            const root = normalizeFolderPath(mapping.path);
            mapping.downloadedFiles = { ...(mapping.downloadedFiles ?? {}) };
            for (const path of paths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile && path.startsWith(`${root}/`)) {
                    mapping.downloadedFiles[path.slice(root.length + 1)] = file.stat?.size ?? null;
                }
            }
            return true;
        }
        /** A 410 group_curriculum_closed came back for this version: clean up its folder once no run is using it. */
        onGroupClosed(versionId) {
            if (!versionId) {
                return;
            }
            this.closedVersions.add(versionId);
            const mapping = this.managedMappingFor(versionId);
            if (mapping && !this.busyMappings.has(normalizeFolderPath(mapping.path))) {
                setTimeout(() => void this.processClosedGroups(), 0);
            }
        }
        /** Cleans up every group folder a 410 marked as closed (skipping ones still busy; they follow when done). */
        async processClosedGroups() {
            for (const mapping of [...this.settings.folders]) {
                if (isManagedGroup(mapping) && isInActiveEnv(this.settings, mapping) && this.groupState(mapping) === 'closed') {
                    await this.removeGroupFolder(mapping, 'closed');
                }
            }
        }
        /** Cleans up the group folders a successful `/me` no longer lists (one after the other). */
        async removeGoneGroups(mappings) {
            for (const mapping of mappings) {
                if (this.settings.folders.includes(mapping) && this.groupState(mapping) === 'gone') {
                    await this.removeGroupFolder(mapping, 'gone');
                }
            }
        }
        /**
         * Removes a closed (or no longer reachable) group's folder and mapping:
         * - to Obsidian's trash (`.trash`, recoverable): clean notes connected to a lesson (they are server
         *   copies), the feedback notes, the README the plugin wrote (unchanged), and images the plugin
         *   downloaded there (same size as when written);
         * - moved to `<Groups>/_detached/<folder name>/`: everything else — notes without a lesson id,
         *   edited notes, conflict copies, unknown files. Never overwritten (` (2)` suffixes).
         * Edited notes are listed in a confirmation first; Cancel leaves folder and mapping untouched (asked
         * again next time). Then empty folders are removed and the mapping is dropped.
         * Returns 'removed', 'cancelled', 'busy' or 'partial' (something failed; the mapping is kept).
         */
        async removeGroupFolder(mapping, reason) {
            const versionId = activeVersionId(this.settings, mapping);
            const key = normalizeFolderPath(mapping.path);
            if (this.removingVersions.has(versionId) || this.busyMappings.has(key)) {
                return 'busy';
            }
            this.removingVersions.add(versionId);
            this.busyMappings.add(key);
            try {
                return await this.cleanUpGroupFolder(mapping, reason);
            }
            finally {
                this.removingVersions.delete(versionId);
                this.busyMappings.delete(key);
                this.updateStatusBar();
                this.refreshExplorerBadges();
            }
        }
        async cleanUpGroupFolder(mapping, reason) {
            const versionId = activeVersionId(this.settings, mapping);
            const root = normalizeFolderPath(mapping.path);
            const label = `"${mapping.groupName ?? mapping.versionLabel ?? 'group'}" (${mapping.courseTitle ?? 'course'})`;
            const why = reason === 'closed'
                ? `the group curriculum ${label} was closed`
                : `the group curriculum ${label} was closed, or you no longer have access to it`;
            const dropMapping = async () => {
                this.settings.folders = this.settings.folders.filter((candidate) => candidate !== mapping);
                this.closedVersions.delete(versionId);
                await this.saveSettings();
            };
            if (!root || !(this.app.vault.getAbstractFileByPath(root) instanceof TFolder)) {
                await dropMapping();
                new Notice(`Chalkenso: ${why}. Its folder "${mapping.path || '/'}" no longer exists; stopped syncing it.`, 12000);
                return 'removed';
            }
            const plan = await this.planGroupCleanup(mapping);
            const detachRoot = plan.detach.length > 0 ? this.freeDetachRoot(root, mapping) : null;
            if (plan.dirty.length > 0) {
                const confirmed = await confirmList(this.app, {
                    title: reason === 'closed' ? 'Group curriculum closed' : 'Group curriculum no longer available',
                    message: `${why[0].toUpperCase()}${why.slice(1)}, so its folder "${root}" is being removed. These notes have local edits that were never uploaded. They'll be moved to ${detachRoot}/ (nothing is deleted). Cancel leaves the folder as it is; Chalkenso asks again next time.`,
                    items: plan.dirty.map((file) => file.path),
                    confirmLabel: 'Move and remove folder',
                    warning: false,
                });
                if (!confirmed) {
                    this.closedVersions.delete(versionId);
                    new Notice(`Chalkenso: left "${root}" as it is (${why}). It will be offered again next time.`, 10000);
                    return 'cancelled';
                }
            }
            const trashed = [];
            const moved = [];
            const failed = [];
            for (const file of plan.trash) {
                try {
                    // Obsidian's own .trash folder, whatever the "deleted files" setting says: always recoverable.
                    await this.app.vault.trash(file, false);
                    trashed.push(file.path.slice(root.length + 1));
                }
                catch (error) {
                    failed.push(`${file.path} (${error.message})`);
                }
            }
            for (const file of plan.detach) {
                const relative = file.path.slice(root.length + 1);
                try {
                    const target = this.freeFilePath(`${detachRoot}/${relative}`);
                    await ensureFolderPath(this.app, target.split('/').slice(0, -1).join('/'));
                    await this.app.fileManager.renameFile(file, target);
                    moved.push(relative);
                }
                catch (error) {
                    failed.push(`${file.path} (${error.message})`);
                }
            }
            const folderRemoved = await this.removeEmptyFolders(root);
            const lines = [`Chalkenso: ${why}.`];
            if (trashed.length > 0) {
                lines.push(`Moved to trash (.trash, recoverable): ${listNames(trashed)}`);
            }
            if (moved.length > 0) {
                lines.push(`Moved to ${detachRoot}/ (not connected, edited or unknown): ${listNames(moved)}`);
            }
            if (plan.kept.length > 0) {
                lines.push(`Left in place (belong to another synced folder): ${listNames(plan.kept.map((file) => file.path))}`);
            }
            if (failed.length > 0) {
                lines.push(`Could not move: ${listNames(failed, 3)}. The folder is kept; Chalkenso tries again next time.`);
                new Notice(lines.join('\n'), 20000);
                return 'partial';
            }
            await dropMapping();
            lines.push(folderRemoved ? `Removed the folder "${root}".` : `The folder "${root}" isn't empty, so it was kept; it is no longer synced.`);
            new Notice(lines.join('\n'), 20000);
            return 'removed';
        }
        /** Sorts every file under a group folder into trash / detach (and lists the edited notes). */
        async planGroupCleanup(mapping) {
            const root = normalizeFolderPath(mapping.path);
            const plan = { trash: [], detach: [], dirty: [], kept: [] };
            const downloaded = mapping.downloadedFiles ?? {};
            for (const file of this.app.vault.getFiles()) {
                if (!file.path.startsWith(`${root}/`)) {
                    continue;
                }
                // A more specific synced folder nested inside: not ours to touch.
                if (findCoveringMapping(this.settings, file.path) !== mapping) {
                    plan.kept.push(file);
                    continue;
                }
                const relative = file.path.slice(root.length + 1);
                if (file.extension !== 'md') {
                    const size = downloaded[relative];
                    const ours = Object.prototype.hasOwnProperty.call(downloaded, relative) &&
                        (typeof size !== 'number' || file.stat?.size === size);
                    (ours ? plan.trash : plan.detach).push(file);
                    continue;
                }
                if (isFolderReadme(file.path, root)) {
                    const ours = Boolean(mapping.readmeHash) && hashText(await this.app.vault.read(file)) === mapping.readmeHash;
                    (ours ? plan.trash : plan.detach).push(file);
                    continue;
                }
                if (isFeedbackPath(file.path, mapping)) {
                    plan.trash.push(file); // regenerated from the dashboard on every pull
                    continue;
                }
                if (isPluginFolderPath(file.path, mapping)) {
                    plan.detach.push(file); // _conflicts/ copies, markdown in _attachments/
                    continue;
                }
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const lessonId = readFrontmatterString(frontmatter, FRONTMATTER.lessonId);
                const status = computeNoteStatus(frontmatter, file.stat.mtime);
                const clean = Boolean(lessonId) &&
                    status === 'synced' &&
                    readFrontmatterString(frontmatter, FRONTMATTER.syncStatus) !== 'orphaned' &&
                    !this.conflictFileFor(file);
                if (clean) {
                    plan.trash.push(file);
                    continue;
                }
                // Hard rule: a note without a lesson id is never deleted.
                plan.detach.push(file);
                if (lessonId && status === 'pending') {
                    plan.dirty.push(file);
                }
            }
            return plan;
        }
        /** `<Groups>/_detached/<folder name>` (the group's organisation), or `… (2)`, … when that already exists. */
        freeDetachRoot(root, mapping) {
            const groups = groupsRootOf(connectionOf(mapping)) || root.split('/').slice(0, -1).join('/');
            const base = `${groups ? `${groups}/` : ''}_detached/${root.split('/').pop()}`;
            const exists = (path) => Boolean(this.app.vault.getAbstractFileByPath(path));
            let path = base;
            for (let n = 2; exists(path); n++) {
                path = `${base} (${n})`;
            }
            return path;
        }
        /** A free file path: `name.ext`, then `name (2).ext`, … (never overwrites). */
        freeFilePath(path) {
            const slash = path.lastIndexOf('/');
            const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
            const name = path.slice(slash + 1);
            const dot = name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            const taken = (candidate) => Boolean(this.app.vault.getAbstractFileByPath(candidate)) ||
                this.app.vault.getFiles().some((file) => file.path.toLowerCase() === candidate.toLowerCase());
            let candidate = normalizePath(path);
            for (let n = 2; taken(candidate); n++) {
                candidate = normalizePath(`${dir}${stem} (${n})${ext}`);
            }
            return candidate;
        }
        /**
         * Removes `root` and its sub-folders when they are empty (deepest first), via Obsidian's trash.
         * A folder that still holds anything (including files Obsidian doesn't index) is kept.
         * Returns true when `root` itself is gone.
         */
        async removeEmptyFolders(root) {
            const folders = this.app.vault.getAllLoadedFiles()
                .filter((file) => file instanceof TFolder && (file.path === root || file.path.startsWith(`${root}/`)))
                .sort((a, b) => b.path.split('/').length - a.path.split('/').length);
            for (const folder of folders) {
                if (this.app.vault.getAllLoadedFiles().some((file) => file.path.startsWith(`${folder.path}/`))) {
                    continue;
                }
                try {
                    const listing = await this.app.vault.adapter.list?.(folder.path);
                    if (listing && ((listing.files?.length ?? 0) > 0 || (listing.folders?.length ?? 0) > 0)) {
                        continue;
                    }
                    await this.app.vault.trash(folder, false);
                }
                catch (error) {
                    console.warn(`Chalkenso: could not remove empty folder "${folder.path}"`, error);
                }
            }
            return !this.app.vault.getAbstractFileByPath(root);
        }
        // ------------------------------------------------------------------------------------------
        // Checks
        // ------------------------------------------------------------------------------------------
        /** Why a mapping can't talk to the server right now, or null when it can. */
        mappingProblem(mapping) {
            if (!activeBaseUrl(this.settings)) {
                return 'set the server URL in Settings → Chalkenso first.';
            }
            if (mapping?.env !== activeEnv(this.settings)) {
                return `"${mapping.path || '/'}" belongs to the ${this.settings.devMode ? 'production' : 'dev'} server.`;
            }
            const connection = connectionOf(mapping);
            if (!connection) {
                return `"${mapping.path || '/'}" belongs to an organisation that is no longer connected (Settings → Chalkenso → Organisations).`;
            }
            if (!connection.token) {
                return `paste the sync token (usr_…) for ${organizationLabel(connection)} in Settings → Chalkenso first.`;
            }
            if (!isMappingOn(this.settings, mapping)) {
                return `"${mapping.path || '/'}" is outside the root folder (Settings → Chalkenso).`;
            }
            return null;
        }
        /** Resolves the folder mapping for a file, surfacing a Notice and returning null when unusable. */
        requireMapping(file) {
            const mapping = findFolderMapping(this.settings, file.path);
            if (!mapping) {
                new Notice(`Chalkenso: no synced folder covers "${file.path}".`);
                return null;
            }
            const problem = this.mappingProblem(mapping);
            if (problem) {
                new Notice(`Chalkenso: ${problem}`);
                return null;
            }
            return mapping;
        }
        hasLessonId(file) {
            return Boolean(findFolderMapping(this.settings, file.path) &&
                readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId));
        }
        /**
         * The `_conflicts/` copy of a lesson note, if there is one. Only for notes with a lesson id, and
         * only when the copy's `conflictOf` link points back at this very note (two notes may share a
         * file name).
         */
        conflictFileFor(file) {
            const mapping = findFolderMapping(this.settings, file.path);
            if (!mapping) {
                return null;
            }
            if (!readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId)) {
                return null;
            }
            const conflict = this.app.vault.getAbstractFileByPath(conflictPathFor(mapping, file));
            if (!(conflict instanceof TFile)) {
                return null;
            }
            const link = /^\[\[([^\]|#]+)/.exec(String(this.app.metadataCache.getFileCache(conflict)?.frontmatter?.conflictOf ?? ''))?.[1];
            return link && this.app.metadataCache.getFirstLinkpathDest(link, conflict.path) === file ? conflict : null;
        }
        /** Lesson notes of a mapping, without notes that belong to a more specific (nested) mapping. */
        mappingFiles(mapping) {
            return collectMarkdownFiles(this.app, mapping).filter((file) => findFolderMapping(this.settings, file.path) === mapping);
        }
        async setArcForNote(file) {
            const mapping = this.requireMapping(file);
            if (!mapping) {
                return;
            }
            try {
                const manifest = await loadManifest(this.settings, mapping);
                await this.rememberManifest(mapping, manifest);
                if (manifest.arcs.length === 0) {
                    new Notice(`Chalkenso: ${manifest.version.label} has no arcs yet. Create them in Chalkenso, or type the arc's title in the note's \`arc\` property: uploading offers to create it.`);
                    return;
                }
                new ArcSuggestModal(this.app, manifest.arcs, (arc) => {
                    void this.app.fileManager
                        .processFrontMatter(file, (fm) => {
                        fm[FRONTMATTER.arc] = arc.title;
                    })
                        .then(() => {
                        new Notice(`Arc set to "${arc.title}".`);
                        this.updateStatusBar();
                    });
                }).open();
            }
            catch (error) {
                this.noticeError('load arcs', error);
            }
        }
        // ------------------------------------------------------------------------------------------
        // Missing arcs
        // ------------------------------------------------------------------------------------------
        /**
         * Before an upload: arcs the notes name but the version doesn't have are offered in one dialog
         * and created in upload order (`POST /api/sync/arcs`), then the manifest is read again so the
         * notes resolve them. Declined, or a server without the route (404): the manifest comes back
         * unchanged and those notes fail with "Arc … not found", as before.
         */
        async ensureArcs(mapping, files, manifest) {
            const missing = missingArcTitles(this.app, files, manifest);
            if (missing.length === 0) {
                return manifest;
            }
            const count = `${missing.length} arc${missing.length === 1 ? '' : 's'}`;
            const confirmed = await confirmList(this.app, {
                title: `Create ${count} in ${manifest.version.label}?`,
                message: `The notes you are uploading name ${missing.length === 1 ? 'an arc' : 'arcs'} that ${curriculumLabel(mapping) ?? manifest.version.label} doesn't have yet. Create ${missing.length === 1 ? 'it' : 'them'} after its existing arcs, in this order? Cancel uploads the other notes; notes in a missing arc are not uploaded.`,
                items: missing,
                confirmLabel: `Create ${count}`,
                warning: false,
            });
            if (!confirmed) {
                return manifest;
            }
            const target = syncTarget(this.settings, mapping);
            const created = [];
            for (const title of missing) {
                try {
                    await createArc(target, title);
                    created.push(title);
                }
                catch (error) {
                    if (error instanceof CurriculumApiError && error.status === 404 && created.length === 0) {
                        new Notice(`Chalkenso: this server can't create arcs from Obsidian yet. Create ${listNames(missing.map((title) => `"${title}"`))} in Chalkenso, then upload again.`);
                    }
                    else {
                        this.noticeError(`create the arc "${title}"`, error);
                    }
                    break;
                }
            }
            if (created.length === 0) {
                return manifest;
            }
            new Notice(`Chalkenso: created ${created.length} arc(s) in ${manifest.version.label}: ${listNames(created)}.`);
            const refreshed = await loadManifest(this.settings, mapping);
            await this.rememberManifest(mapping, refreshed);
            return refreshed;
        }
        // ------------------------------------------------------------------------------------------
        // Moving from another server: first sync, disconnect, mapping an existing folder
        // ------------------------------------------------------------------------------------------
        /** True until a folder's first successful run against the active server (no run or download stamp). */
        neverSynced(mapping) {
            return !mapping.lastSynced && !mapping[syncStampKey()];
        }
        /**
         * Before a folder's first run: notes with a lesson id the version doesn't know were synced with
         * another server (or version). An upload would answer 404 for each and a download would trash
         * them, so disconnecting them is offered instead. Returns false when the run must stop (declined,
         * or the version couldn't be read); `manifest` saves a request when the caller has one.
         */
        async checkFirstSync(mapping, manifest = null) {
            if (!this.neverSynced(mapping)) {
                return true;
            }
            const lessonIdOf = (file) => readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId);
            const connected = this.mappingFiles(mapping).filter((file) => lessonIdOf(file));
            if (connected.length === 0) {
                return true;
            }
            let current = manifest;
            if (!current) {
                try {
                    current = await loadManifest(this.settings, mapping);
                    await this.rememberManifest(mapping, current);
                }
                catch (error) {
                    this.noticeError(`read ${curriculumLabel(mapping) ?? 'the version'} for "${mapping.path || '/'}"`, error);
                    return false;
                }
            }
            const known = new Set(current.lessons.map((lesson) => lesson.id));
            const foreign = connected.filter((file) => !known.has(lessonIdOf(file)));
            if (foreign.length === 0) {
                return true;
            }
            const confirmed = await this.confirmDisconnect(mapping.path, foreign, { mapping, firstSync: true, serverLessons: current.lessons.length });
            if (!confirmed) {
                new Notice(`Chalkenso: "${mapping.path || '/'}" was left as it is and not synced: ${foreign.length} note(s) still point at lessons of another server. Sync again, or run "Disconnect folder from its previous server", when you are ready.`, 15000);
                return false;
            }
            return this.applyDisconnect(mapping.path, foreign, mapping);
        }
        /**
         * The disconnect dialog, saying how many notes change and what stays. `firstSync` words it as
         * the offer made on a folder's first sync; `serverLessons` (lessons the version already has) and
         * `matched` (notes connected to lessons of this very version) add warnings about duplicates.
         */
        confirmDisconnect(folderPath, files, { mapping = null, firstSync = false, serverLessons = 0, matched = 0 } = {}) {
            const where = `"${folderPath || '/'}"`;
            const label = mapping ? curriculumLabel(mapping) : null;
            const n = files.length;
            const notes = `${n} note${n === 1 ? '' : 's'}`;
            const parts = [
                firstSync
                    ? `This is the first sync of ${where}${label ? ` with ${label}` : ''}, and ${notes} in it point at lessons that ${label ?? 'this version'} doesn't have: they were synced with another server (or another version) before. Disconnect them?`
                    : `Disconnect ${notes} in ${where} from the server they were synced with${this.settings.devMode ? ' (dev ids only)' : ''}?`,
                `The sync properties (${connectionKeys().join(', ')}) are removed from ${n === 1 ? 'it' : 'each'}; the text, slug, title, arc, shortDescription and status stay. Disconnected notes count as new: the next upload creates their lessons, in the folder's order.`,
            ];
            if (matched > 0) {
                parts.push(`${matched} of them belong to lessons of ${label ?? 'this version'} on this server: the next download adds those lessons again as new notes, and uploading creates duplicates.`);
            }
            if (serverLessons > 0) {
                parts.push(`${label ?? 'This version'} already has ${serverLessons} lesson(s). Disconnected notes aren't matched to them, so the next download adds them as new notes next to yours.${mapping && isManagedGroup(mapping) ? ' For a group curriculum, deleting the old folder and downloading the group fresh is usually better.' : ''}`);
            }
            const feedbackFolder = feedbackFolderPath({ path: folderPath });
            if (collectFeedbackFiles(this.app, { path: folderPath }).size > 0) {
                parts.push(`The notes in ${feedbackFolder}/ belong to the previous server too: the next feedback pull moves them to Obsidian's trash.`);
            }
            if (firstSync) {
                parts.push('Cancel leaves the folder as it is and doesn\'t sync it.');
            }
            return confirmList(this.app, {
                title: firstSync ? `Disconnect ${notes} from the previous server?` : `Disconnect ${notes}?`,
                message: parts.join(' '),
                items: files.map((file) => file.path),
                confirmLabel: `Disconnect ${notes}`,
            });
        }
        /**
         * Removes the connection properties from `files`; a mapped folder also forgets its sync stamps,
         * so its next run counts as a first sync again. Returns true when every note changed.
         */
        async applyDisconnect(folderPath, files, mapping = null) {
            const failed = await disconnectNotes(this.app, files);
            if (mapping && this.settings.folders.includes(mapping) && (mapping.lastSynced || mapping[syncStampKey()])) {
                delete mapping.lastSynced;
                delete mapping[syncStampKey()];
                await this.saveSettings();
            }
            this.updateStatusBar();
            this.refreshExplorerBadges();
            const where = `"${folderPath || '/'}"`;
            if (failed.length > 0) {
                new Notice(`Chalkenso: disconnected ${files.length - failed.length} of ${files.length} note(s) in ${where}. Could not change: ${listNames(failed, 3)}`, 15000);
                return false;
            }
            new Notice(`Chalkenso: disconnected ${files.length} note(s) in ${where}. Uploading the folder creates their lessons.`);
            return true;
        }
        /**
         * Folders that can be disconnected or mapped: every folder of the active server that is
         * mapped, and every folder directly under each organisation's Curriculums and Groups folders (not `_…` ones
         * such as `_detached`). `unmappedOnly` leaves out the mapped ones.
         */
        curriculumFolderCandidates(unmappedOnly = false) {
            const paths = new Set();
            if (!unmappedOnly) {
                for (const mapping of this.settings.folders) {
                    if (isInActiveEnv(this.settings, mapping) && normalizeFolderPath(mapping.path ?? '')) {
                        paths.add(normalizeFolderPath(mapping.path));
                    }
                }
            }
            const containers = activeConnections().flatMap((connection) => [curriculumsRootOf(connection), groupsRootOf(connection)]).filter(Boolean);
            for (const container of containers) {
                const folder = container ? this.app.vault.getAbstractFileByPath(container) : null;
                if (!(folder instanceof TFolder) || !isInsideRootFolder(folder.path)) {
                    continue;
                }
                for (const child of folder.children) {
                    if (child instanceof TFolder && !child.name.startsWith('_') && !(unmappedOnly && this.isMappedPath(child.path))) {
                        paths.add(child.path);
                    }
                }
            }
            return [...paths].sort((a, b) => compareNotePaths({ path: a }, { path: b }));
        }
        /** True when a mapping of either server uses exactly this folder. */
        isMappedPath(path) {
            return this.settings.folders.some((mapping) => normalizeFolderPath(mapping.path ?? '') === normalizeFolderPath(path));
        }
        /**
         * "Disconnect folder from its previous server": for notes synced with another server before
         * (they carry its lesson ids). After a confirmation stating how many notes change, removes the
         * active server's connection properties from every note in the folder (see `connectionKeys`).
         * `path` skips the folder picker (folder right-click).
         */
        async disconnectFolder(path = null) {
            if (path === null) {
                const candidates = this.curriculumFolderCandidates();
                if (candidates.length === 0) {
                    new Notice('Chalkenso: no curriculum folders to disconnect. Add your organisation and set the root folder in Settings → Chalkenso; folders directly under each organisation’s Curriculums and Groups folders are listed.');
                    return;
                }
                new PathSuggestModal(this.app, candidates, 'Folder to disconnect from its previous server', (chosen) => void this.disconnectFolder(chosen)).open();
                return;
            }
            const mapping = this.getFolderMappingByExactPath(path) ?? null;
            const key = normalizeFolderPath(path);
            if (this.busyMappings.has(key)) {
                new Notice(`Chalkenso: "${path}" is syncing; try again when it is done.`);
                return;
            }
            const files = mapping
                ? this.mappingFiles(mapping)
                : collectMarkdownFiles(this.app, { path }).filter((file) => {
                    // Notes of a mapped folder nested inside belong to that folder.
                    const covering = findCoveringMapping(this.settings, file.path);
                    return !covering || normalizeFolderPath(covering.path).length < key.length;
                });
            const notes = connectedNotes(this.app, files);
            if (notes.length === 0) {
                new Notice(`Chalkenso: nothing to disconnect in "${path}": no note has sync properties for the ${this.settings.devMode ? 'dev' : 'production'} server.`);
                return;
            }
            // Notes connected to lessons this very version has would come back as duplicates: say so.
            let matched = 0;
            if (mapping && activeVersionId(this.settings, mapping) && !this.mappingProblem(mapping)) {
                try {
                    const manifest = await loadManifest(this.settings, mapping);
                    const known = new Set(manifest.lessons.map((lesson) => lesson.id));
                    matched = notes.filter((file) => known.has(readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId))).length;
                }
                catch (error) {
                    console.warn(`Chalkenso: could not read the version of "${path}" before disconnecting`, error);
                }
            }
            if (!(await this.confirmDisconnect(path, notes, { mapping, matched }))) {
                return;
            }
            this.busyMappings.add(key);
            try {
                await this.applyDisconnect(path, notes, mapping);
            }
            finally {
                this.busyMappings.delete(key);
            }
        }
        /**
         * "Map folder to a curriculum version": syncs a folder you already have (moved from another
         * server, or named differently) with one of your workspaces that no folder syncs yet — what
         * ticking it in settings does, with your folder instead of a new one. The folder is downloaded
         * right away; its first sync offers to disconnect notes from a previous server.
         */
        async mapFolderToWorkspace(path = null) {
            if (!hasActiveConnection(this.settings)) {
                new Notice('Chalkenso: set the server URL and add your organisation with its sync token (usr_…) in Settings → Chalkenso first.');
                return;
            }
            if (path === null) {
                const candidates = this.curriculumFolderCandidates(true);
                if (candidates.length === 0) {
                    new Notice('Chalkenso: no unmapped folders directly under an organisation’s Curriculums or Groups folder (Settings → Chalkenso).');
                    return;
                }
                new PathSuggestModal(this.app, candidates, 'Folder to sync with a curriculum version', (chosen) => void this.mapFolderToWorkspace(chosen)).open();
                return;
            }
            if (this.isMappedPath(path)) {
                new Notice(`Chalkenso: "${path}" is already mapped.`);
                return;
            }
            // The folder's organisation: the one whose folder holds it (or the only one there is).
            const connections = activeConnections().filter((candidate) => candidate.token);
            const connection = this.host.connectionForPath(path) ?? (connections.length === 1 ? connections[0] : null);
            if (!connection) {
                new Notice(`Chalkenso: "${path}" isn't in an organisation's folder. Move it into the organisation's Curriculums or Groups folder first.`);
                return;
            }
            const me = await this.host.loadMe(connection.id, true);
            if (!me) {
                new Notice(`Chalkenso: could not load your account in ${organizationLabel(connection)} (${this.host.currentMe(connection.id)?.error ?? 'unknown error'}).`);
                return;
            }
            const workspaces = me.workspaces.filter((workspace) => !this.mappingForWorkspace(workspace.id));
            if (workspaces.length === 0) {
                new Notice(`Chalkenso: every curriculum version you can reach in ${organizationLabel(connection)} already syncs with a folder.`);
                return;
            }
            new WorkspaceSuggestModal(this.app, workspaces, `Version for "${path}" (${organizationLabel(connection)})`, (workspace) => void (async () => {
                try {
                    const mapping = await this.addWorkspaceFolder(workspace, connection, path);
                    await this.host.markSeen([{ key: `ws:${workspace.id}` }]);
                    new Notice(`Chalkenso: "${path}" now syncs with ${curriculumLabel(mapping) ?? workspaceLabel(workspace)}; downloading.`);
                    await this.runForMapping(mapping, 'download');
                }
                catch (error) {
                    this.noticeError(`map "${path}"`, error);
                }
            })()).open();
        }
        // ------------------------------------------------------------------------------------------
        // Upload / download / sync
        // ------------------------------------------------------------------------------------------
        /** Uploads the one note (with the revision check); a lesson gone from the server is recreated only after confirming. */
        async syncCurrentNote(file) {
            const mapping = this.requireMapping(file);
            if (!mapping) {
                return;
            }
            if (this.groupState(mapping)) {
                await this.handleUnavailableGroup(mapping);
                return;
            }
            if (this.isReadOnly(mapping)) {
                new Notice(`Chalkenso: "${file.basename}" was not uploaded: you can only read ${curriculumLabel(mapping) ?? 'this curriculum'} (download only).`);
                return;
            }
            new Notice('Chalkenso: uploading note…');
            try {
                let manifest = await loadManifest(this.settings, mapping);
                await this.rememberManifest(mapping, manifest);
                // A note from another server in a folder that never synced: offer to disconnect the folder's notes first.
                const lessonId = readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId);
                const foreign = lessonId && !manifest.lessons.some((lesson) => lesson.id === lessonId);
                if (foreign && this.neverSynced(mapping) && !(await this.checkFirstSync(mapping, manifest))) {
                    return;
                }
                manifest = await this.ensureArcs(mapping, [file], manifest);
                let result = await this.withSyncingIndicator(file, () => syncFile(this.app, this.settings, file, manifest, mapping));
                if (result.outcome === 'missing') {
                    if (!(await this.confirmRecreate([file]))) {
                        new Notice(`Chalkenso: "${file.basename}" was not uploaded; its lesson is gone from the server.`);
                        return;
                    }
                    result = await this.withSyncingIndicator(file, () => syncFile(this.app, this.settings, file, manifest, mapping, { recreate: true }));
                }
                new Notice(`Chalkenso: ${result.outcome} — ${result.message}`);
                if (result.outcome === 'created' || result.outcome === 'updated') {
                    const pushed = this.canPushTicks(mapping)
                        ? await pushLessonTicks(this.app, this.settings, mapping, file)
                        : undefined;
                    await this.pullFeedbackForMapping(mapping, pushed);
                }
            }
            catch (error) {
                this.noticeError('upload note', error);
            }
        }
        /**
         * Shows what uploading the note would change in Chalkenso (fields and a diff of the body), with
         * an Upload button that runs the normal upload — so the revision check still applies.
         */
        async showLessonChanges(file) {
            const mapping = this.requireMapping(file);
            if (!mapping) {
                return;
            }
            if (this.groupState(mapping)) {
                await this.handleUnavailableGroup(mapping);
                return;
            }
            await this.flushOpenEditors();
            let preview;
            try {
                const manifest = await loadManifest(this.settings, mapping, true);
                await this.rememberManifest(mapping, manifest);
                preview = await previewLessonUpload(this.app, this.settings, file, manifest);
            }
            catch (error) {
                this.noticeError('show changes', error);
                return;
            }
            const uploadBlocked = this.isReadOnly(mapping)
                ? `You can only read ${curriculumLabel(mapping) ?? 'this curriculum'}, so this note isn't uploaded.`
                : preview.uploadBlocked;
            new LessonChangesModal(this.app, { title: `Changes: ${file.basename}`, preview, uploadBlocked }, () => void this.syncCurrentNote(file)).open();
        }
        /** Runs download / upload / sync for the curriculum folder of a note. */
        async runForFileMapping(file, action) {
            const mapping = findFolderMapping(this.settings, file.path);
            if (!mapping) {
                new Notice(`Chalkenso: no synced folder covers "${file.path}".`);
                return;
            }
            await this.runForMapping(mapping, action);
        }
        /** Runs download / upload / sync for every curriculum folder of the active server's organisations. */
        async runForAllMappings(action) {
            // Fresh accounts first (every organisation): closed groups are cleaned up. Offline / failed:
            // carry on with the folders we have; nothing is removed.
            if (hasActiveConnection(this.settings)) {
                await this.host.loadAllMe(true);
                await this.groupCleanup;
            }
            const mappings = this.settings.folders.filter((mapping) => isMappingOn(this.settings, mapping) && !this.groupState(mapping));
            if (mappings.length === 0) {
                new Notice('Chalkenso: no curriculum folders are synced. Choose them in Settings → Chalkenso → What to sync.');
                return;
            }
            for (const mapping of mappings) {
                await this.runForMapping(mapping, action);
            }
        }
        /**
         * Download or sync every group-curriculum folder in one go (a Groups folder's menu, command,
         * settings): of one organisation (`connectionId`, its Groups folder) or of all of them. Reloads
         * each account first, so closed groups are cleaned up, then runs each group folder it can reach.
         */
        async runForGroupMappings(action, connectionId = null) {
            if (!hasActiveConnection(this.settings)) {
                new Notice('Chalkenso: set the server URL and add your organisation with its sync token (usr_…) in Settings → Chalkenso first.');
                return;
            }
            const connections = activeConnections().filter((connection) => connection.token && (!connectionId || connection.id === connectionId));
            const loaded = new Set();
            for (const connection of connections) {
                if (await this.host.loadMe(connection.id, true)) {
                    loaded.add(connection.id);
                }
                else {
                    new Notice(`Chalkenso: could not load your account in ${organizationLabel(connection)} (${this.host.currentMe(connection.id)?.error ?? 'unknown error'}); its group folders were not synced.`);
                }
            }
            await this.groupCleanup;
            if (loaded.size === 0) {
                return;
            }
            const groups = this.settings.folders.filter((mapping) => isManagedGroup(mapping) &&
                loaded.has(mapping.connection) &&
                isMappingOn(this.settings, mapping) &&
                activeVersionId(this.settings, mapping) &&
                !this.groupState(mapping));
            if (groups.length === 0) {
                new Notice('Chalkenso: no group curricula are synced. Choose them in Settings → Chalkenso → What to sync.');
                return;
            }
            for (const mapping of groups) {
                await this.runForMapping(mapping, action);
            }
        }
        /**
         * Download, upload or sync (upload, then download) one mapped folder. Only one run per folder at
         * a time. Feedback is pulled after every action.
         */
        async runForMapping(mapping, action) {
            const problem = this.mappingProblem(mapping);
            if (problem) {
                new Notice(`Chalkenso: ${problem}`);
                return;
            }
            if (this.groupState(mapping)) {
                await this.handleUnavailableGroup(mapping);
                return;
            }
            const key = normalizeFolderPath(mapping.path);
            if (this.busyMappings.has(key)) {
                new Notice(`Chalkenso: "${mapping.path || '/'}" is already syncing.`);
                return;
            }
            this.busyMappings.add(key);
            const versionId = activeVersionId(this.settings, mapping);
            // Read-only (no WRITE per /me): never upload; a sync is a download.
            const readOnly = this.isReadOnly(mapping);
            const closed = () => this.closedVersions.has(versionId);
            let ok = true;
            try {
                // First sync of the folder: notes still tied to another server are disconnected first,
                // or the folder is left alone (nothing uploaded, trashed or stamped).
                if (!(await this.checkFirstSync(mapping))) {
                    return;
                }
                let pushed;
                if ((action === 'upload' || action === 'sync') && !readOnly) {
                    pushed = await this.uploadMapping(mapping);
                    ok = ok && pushed.ok !== false;
                }
                else if (action === 'upload') {
                    new Notice(`Chalkenso: upload "${mapping.path || '/'}": skipped, you can only read ${curriculumLabel(mapping) ?? 'this curriculum'} (download only).`);
                }
                if ((action === 'download' || action === 'sync') && !closed()) {
                    ok = (await this.downloadMapping(mapping)) !== false && ok;
                }
                // Feedback (in-progress tasks) comes with every action, downloads included; pulling is
                // read-only and keeps local ticks, which are sent by the next upload or sync.
                if (!closed()) {
                    await this.pullFeedbackForMapping(mapping, pushed);
                }
                if (readOnly) {
                    this.noticeReadOnlyEdits(mapping);
                }
                if (ok && !closed() && !(action === 'upload' && readOnly)) {
                    mapping.lastSynced = new Date().toISOString();
                    await this.saveSettings();
                }
            }
            catch (error) {
                // Never fail silently: surface (and log) anything unexpected.
                const where = error?.stack ? ` (${String(error.stack).split('\n').slice(1, 3).join(' | ').trim()})` : '';
                new Notice(`Chalkenso: failed to ${action} "${mapping.path || '/'}" — ${error?.message ?? error}${where}`);
                console.error(`Chalkenso: failed to ${action} "${mapping.path || '/'}"`, error);
            }
            finally {
                this.busyMappings.delete(key);
                this.updateStatusBar();
                this.refreshExplorerBadges();
            }
            if (closed() && isManagedGroup(mapping)) {
                await this.removeGroupFolder(mapping, 'closed');
            }
        }
        /** A group folder that is closed / gone / another account's: clean it up (or explain) instead of syncing. */
        async handleUnavailableGroup(mapping) {
            const state = this.groupState(mapping);
            if (state === 'other-account') {
                new Notice(`Chalkenso: "${mapping.path}" belongs to another account's group curriculum; it is not synced with this token.`);
                return;
            }
            if (state === 'closed' || state === 'gone') {
                await this.removeGroupFolder(mapping, state);
            }
        }
        /**
         * One notice per run for a read-only folder with local edits: they are never uploaded. A download
         * still never overwrites them (a newer server copy goes to `_conflicts/`).
         */
        noticeReadOnlyEdits(mapping) {
            const edited = this.mappingFiles(mapping).filter((file) => computeNoteStatus(this.app.metadataCache.getFileCache(file)?.frontmatter, file.stat.mtime) === 'pending');
            if (edited.length === 0) {
                return;
            }
            new Notice(`${edited.length} note${edited.length === 1 ? '' : 's'} in ${mapping.path || '/'} ${edited.length === 1 ? 'was' : 'were'} edited locally, but you can only read this curriculum; your edits stay local and are not uploaded. When the lesson changes on the server, the new version is saved to _conflicts/ instead of replacing your note.\n${listNames(edited.map((file) => file.basename))}`, 15000);
        }
        /**
         * Uploads every new note (no lesson id) and every note edited since its last sync. Clean notes
         * are not sent. Returns the feedback ticks pushed, for the feedback notice.
         */
        async uploadMapping(mapping) {
            const pushed = { pushed: 0, failed: 0, ok: true };
            if (this.isReadOnly(mapping)) {
                return pushed; // no WRITE: nothing is ever sent (see runForMapping)
            }
            const canPushTicks = this.canPushTicks(mapping);
            const files = this.mappingFiles(mapping).filter((file) => {
                const status = computeNoteStatus(this.app.metadataCache.getFileCache(file)?.frontmatter, file.stat.mtime);
                return status === 'not-synced' || status === 'pending';
            });
            const where = `"${mapping.path || '/'}"`;
            if (files.length === 0) {
                new Notice(`Chalkenso: upload ${where}: nothing new or edited.`);
                return pushed;
            }
            new Notice(`Chalkenso: uploading ${files.length} note(s) from ${where}…`);
            try {
                let manifest = await loadManifest(this.settings, mapping);
                await this.rememberManifest(mapping, manifest);
                // Arcs the notes name but the version lacks are created first, in upload order.
                manifest = await this.ensureArcs(mapping, files, manifest);
                const results = [];
                const afterUpload = async (candidate, result) => {
                    results.push(result);
                    // Feedback closes only once the lesson it changes is on the server.
                    if ((result.outcome === 'created' || result.outcome === 'updated') && canPushTicks) {
                        const lessonPush = await pushLessonTicks(this.app, this.settings, mapping, candidate);
                        pushed.pushed += lessonPush.pushed;
                        pushed.failed += lessonPush.failed;
                    }
                };
                const missing = [];
                let forbidden = null;
                // One request per batch instead of one per note. Authorisation is checked once, up
                // front, so a 403/410 still means nothing was written — the notice below holds.
                for (const candidate of files) {
                    this.markSyncing(candidate, true);
                }
                let batchResults;
                try {
                    batchResults = await syncFilesBatched(this.app, this.settings, files, manifest, mapping);
                }
                finally {
                    for (const candidate of files) {
                        this.markSyncing(candidate, false);
                    }
                }
                for (const result of batchResults) {
                    if (result.outcome === 'missing') {
                        missing.push(result.file);
                        continue;
                    }
                    await afterUpload(result.file, result);
                    // Permissions unknown (offline /me) and the server says no: stop instead of failing every note.
                    if (result.outcome === 'error' && (result.status === 403 || result.status === 410)) {
                        forbidden = result;
                        break;
                    }
                }
                if (forbidden) {
                    pushed.ok = false;
                    if (forbidden.status === 403) {
                        new Notice(`Chalkenso: upload ${where} stopped: Chalkenso refused it (403), so your account probably can't edit ${curriculumLabel(mapping) ?? 'this curriculum'}. Nothing else was sent; your notes are unchanged. ${forbidden.message}`);
                    }
                    return pushed;
                }
                // A 404 may mean the lesson was deleted on purpose; recreate only when the user says so.
                if (missing.length > 0) {
                    const recreate = await this.confirmRecreate(missing);
                    for (const candidate of missing) {
                        if (!recreate) {
                            results.push({ file: candidate, outcome: 'skipped', message: 'Lesson gone from the server; not recreated.' });
                            continue;
                        }
                        const result = await this.withSyncingIndicator(candidate, () => syncFile(this.app, this.settings, candidate, manifest, mapping, { recreate: true }));
                        await afterUpload(candidate, result);
                    }
                }
                const count = (outcome) => results.filter((r) => r.outcome === outcome);
                const conflicts = count('conflict');
                const errors = count('error');
                // Conflicts / failures are only named when there are some (those words flag a notice as a problem).
                const lines = [
                    `Chalkenso: upload ${where}: ${count('created').length} created, ${count('updated').length} updated, ${count('skipped').length} skipped${conflicts.length ? `, ${conflicts.length} conflict(s)` : ''}${errors.length ? `, ${errors.length} failed` : ''}.`,
                ];
                if (conflicts.length > 0) {
                    lines.push(`Conflicts (server copy in ${CONFLICTS_FOLDER}/, note unchanged): ${listNames(conflicts.map((r) => r.file.basename))}`);
                }
                if (errors.length > 0) {
                    lines.push(`Failed: ${listNames(errors.map((r) => `${r.file.basename} (${r.message})`), 3)}`);
                }
                new Notice(lines.join('\n'), conflicts.length || errors.length ? 15000 : undefined);
                for (const failure of errors) {
                    console.warn(`Chalkenso: ${failure.file.path} — ${failure.message}`);
                }
            }
            catch (error) {
                pushed.ok = false;
                this.noticeError(`upload ${where}`, error);
            }
            return pushed;
        }
        /** Asks before recreating lessons whose update returned 404 (maybe deleted on the server on purpose). */
        confirmRecreate(files) {
            return confirmList(this.app, {
                title: 'Lessons missing on the server',
                message: 'These notes point at lessons that are no longer on the server; someone may have deleted them on purpose. Recreate them as new lessons? (Cancel keeps the notes as they are.)',
                items: files.map((file) => file.path),
                confirmLabel: 'Recreate lessons',
            });
        }
        /**
         * Brings server changes into the folder (GET /api/sync/curriculum?include=content):
         * - a lesson whose note is clean and behind (lower revision) → the note is rewritten;
         * - a lesson whose note was edited locally and is behind → CONFLICT: server copy in `_conflicts/`;
         * - a lesson with no note → a new note at the folder root;
         * - a note whose lesson is gone → trashed when clean, marked `orphaned` when edited;
         * - notes without a lesson id, and notes with `sync: false`, are never touched.
         * Then images the lessons use that are missing locally are fetched (never overwriting a file).
         */
        async downloadMapping(mapping) {
            const where = `"${mapping.path || '/'}"`;
            const stampKey = syncStampKey();
            let manifest;
            try {
                // Ask only for what changed since the last download; the list still arrives whole.
                manifest = await loadManifest(this.settings, mapping, true, mapping[stampKey] ?? null);
                await this.rememberManifest(mapping, manifest);
                if (!this.manifestIsSufficient(manifest, this.localRevisions(mapping))) {
                    // A lesson we would have to write came back without its body — the stamp was
                    // stale or a note is missing. Ask again for everything rather than guess.
                    manifest = await loadManifest(this.settings, mapping, true, null);
                }
            }
            catch (error) {
                this.noticeError(`download ${where}`, error);
                return false;
            }
            // Still short of what we need (an older server sends no content at all): refuse rather
            // than write empty notes.
            if (!this.manifestIsSufficient(manifest, this.localRevisions(mapping))) {
                new Notice(`Chalkenso: download ${where} failed: the server did not send lesson content. Is it up to date?`);
                return false;
            }
            const report = { created: [], updated: [], conflicts: [], trashed: [], orphaned: [], skipped: [], errors: [], images: 0, imageErrors: [] };
            const byId = new Map();
            const byProductionId = new Map();
            const connected = [];
            for (const file of this.mappingFiles(mapping)) {
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const lessonId = readFrontmatterString(frontmatter, FRONTMATTER.lessonId);
                if (lessonId) {
                    connected.push({ file, lessonId });
                    if (!byId.has(lessonId)) {
                        byId.set(lessonId, file);
                    }
                }
                else if (devMode) {
                    // A dev database copied from production keeps the ids: recognise those notes instead of duplicating them.
                    const productionId = readFrontmatterString(frontmatter, PRODUCTION_LESSON_ID);
                    if (productionId && !byProductionId.has(productionId)) {
                        byProductionId.set(productionId, file);
                    }
                }
            }
            const serverIds = new Set(manifest.lessons.map((lesson) => lesson.id));
            const current = []; // notes that match the server after this download: fetch their missing images
            for (const lesson of manifest.lessons) {
                try {
                    const file = byId.get(lesson.id) ?? null;
                    if (file) {
                        const outcome = await this.downloadIntoNote(mapping, file, lesson);
                        if (outcome === 'updated') {
                            report.updated.push(file.basename);
                        }
                        else if (outcome === 'conflict') {
                            report.conflicts.push(file.basename);
                        }
                        else if (outcome === 'skipped') {
                            report.skipped.push(file.basename);
                        }
                        if (outcome === 'updated' || outcome === 'unchanged') {
                            current.push({ file, lesson });
                        }
                        continue;
                    }
                    const productionNote = byProductionId.get(lesson.id) ?? null;
                    if (productionNote) {
                        const outcome = await this.linkProductionNote(productionNote, lesson);
                        (outcome === 'linked' ? report.updated : report.skipped).push(productionNote.basename);
                        continue;
                    }
                    const created = await createLessonNote(this.app, mapping, lesson);
                    report.created.push(created.basename);
                    current.push({ file: created, lesson });
                }
                catch (error) {
                    report.errors.push(`${lesson.title}: ${error.message}`);
                }
            }
            // Notes whose lesson is gone from the version.
            const gone = connected.filter(({ lessonId }) => !serverIds.has(lessonId));
            const toTrash = [];
            for (const { file } of gone) {
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const status = computeNoteStatus(frontmatter, file.stat.mtime);
                if (status === 'disabled') {
                    continue;
                }
                if (status === 'pending') {
                    await writeNoteStatus(this.app, file, 'orphaned');
                    report.orphaned.push(file.basename);
                }
                else if (status === 'synced') {
                    toTrash.push(file);
                }
            }
            if (toTrash.length > 0 && (await this.confirmTrashIfSuspicious(mapping, toTrash, connected.length))) {
                for (const file of toTrash) {
                    // Obsidian's own .trash folder, whatever the "deleted files" setting says: always recoverable.
                    await this.app.vault.trash(file, false);
                    report.trashed.push(file.basename);
                }
            }
            else if (toTrash.length > 0) {
                report.skipped.push(...toTrash.map((file) => `${file.basename} (not trashed)`));
            }
            for (const { file, lesson } of current) {
                const images = await downloadMissingImages(this.app, this.settings, mapping, file, lesson);
                report.images += images.written.length;
                report.imageErrors.push(...images.failed);
                if (this.recordDownloadedFiles(mapping, images.written)) {
                    await this.saveSettings();
                }
            }
            await this.linkGroupNotesToCore(manifest, current.map(({ file, lesson }) => ({ file, lesson })));
            this.noticeDownload(where, report);
            const clean = report.errors.length === 0;
            if (clean && typeof manifest.syncedAt === 'string') {
                // Only on a clean run: a stamp saved after a partial download would let the next one
                // skip bodies it still needs. (`manifestIsSufficient` would catch that, but not saving
                // is the cheaper correctness.)
                mapping[stampKey] = manifest.syncedAt;
                await this.saveSettings();
            }
            return clean;
        }
        /**
         * For a group curriculum whose core version is mapped to a folder too: points each group note's
         * `coreLesson` at the core note it was copied from, so the graph and backlinks connect the two.
         * Needs `baseLessonId` in the manifest (older servers don't send it: nothing happens).
         */
        async linkGroupNotesToCore(manifest, notes) {
            const baseVersionId = manifest.version?.baseVersion?.id;
            if (!baseVersionId) {
                return;
            }
            const coreMapping = this.settings.folders.find((candidate) => activeVersionId(this.settings, candidate) === baseVersionId);
            const coreNotes = coreMapping ? lessonNotesById(this.app, coreMapping) : new Map();
            for (const { file, lesson } of notes) {
                if (lesson.baseLessonId === undefined) {
                    continue;
                }
                const coreFile = lesson.baseLessonId ? coreNotes.get(lesson.baseLessonId) : null;
                const link = coreFile ? `[[${this.app.metadataCache.fileToLinktext(coreFile, file.path, true)}]]` : null;
                try {
                    await setLessonCoreLink(this.app, file, link);
                }
                catch (error) {
                    console.warn(`Chalkenso: could not link ${file.path} to its core lesson`, error);
                }
            }
        }
        /** lessonId → the revision that folder's note is at, read once per download. */
        localRevisions(mapping) {
            const revisions = new Map();
            for (const file of this.mappingFiles(mapping)) {
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const lessonId = readFrontmatterString(frontmatter, FRONTMATTER.lessonId);
                if (lessonId && !revisions.has(lessonId)) {
                    revisions.set(lessonId, readRevision(frontmatter));
                }
            }
            return revisions;
        }
        /**
         * Whether every lesson in this manifest is one we can act on: it either carries its body, or
         * the note we already hold is at least at the server's revision, so the missing body changes
         * nothing. A lesson with no note, an unreadable revision, or a note behind the server means
         * the delta is too thin and the caller has to ask for everything.
         */
        manifestIsSufficient(manifest, revisions) {
            if (!Array.isArray(manifest.lessons)) {
                return false;
            }
            return manifest.lessons.every((lesson) => {
                if (typeof lesson.markdownContent === 'string') {
                    return true;
                }
                const serverRevision = typeof lesson.revision === 'number' ? lesson.revision : null;
                const noteRevision = revisions.get(lesson.id);
                return (serverRevision !== null &&
                    noteRevision !== undefined &&
                    noteRevision !== null &&
                    noteRevision >= serverRevision);
            });
        }
        /**
         * Download for one note that carries this lesson's id. Returns `updated`, `unchanged`,
         * `conflict` or `skipped` (sync off for the note). A note without a revision counts as revision 0.
         */
        async downloadIntoNote(mapping, file, lesson) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const status = computeNoteStatus(frontmatter, file.stat.mtime);
            if (status === 'disabled') {
                return 'skipped';
            }
            // The manifest omits bodies for lessons it believes we already have. Writing one of
            // those into a note would blank it, so treat it exactly as an unchanged lesson —
            // including keeping a locally edited note out of the image pass, as before.
            if (typeof lesson.markdownContent !== 'string') {
                return status === 'pending' ? 'unchanged-edited' : 'unchanged';
            }
            const noteRevision = readRevision(frontmatter) ?? 0;
            const serverRevision = typeof lesson.revision === 'number' ? lesson.revision : null;
            if (serverRevision === null || serverRevision <= noteRevision) {
                return status === 'pending' ? 'unchanged-edited' : 'unchanged';
            }
            if (status === 'pending') {
                await writeConflictCopy(this.app, mapping, file, lesson);
                return 'conflict';
            }
            await applyServerLesson(this.app, file, lesson);
            return 'updated';
        }
        /**
         * Dev mode only: a note with a production `lessonId` equal to this dev lesson's id (a dev
         * database copied from production) is not duplicated. Its body is never replaced: when it is
         * identical to the dev lesson the dev keys are stamped (`linked`), otherwise it is left alone
         * (`skipped`).
         */
        async linkProductionNote(file, lesson) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const body = stripFrontmatter(await this.app.vault.read(file)).trim();
            if (!isNoteSyncEnabled(frontmatter) || body !== String(lesson.markdownContent ?? '').trim()) {
                return 'skipped';
            }
            await applyServerLesson(this.app, file, lesson);
            return 'linked';
        }
        /**
         * Clean notes whose lesson is gone are trashed without asking, unless it looks like the wrong
         * version was chosen (no note matched the server, or at least half of them would go): then the
         * user confirms the list first.
         */
        async confirmTrashIfSuspicious(mapping, files, connectedCount) {
            const matched = connectedCount - files.length;
            const suspicious = matched === 0 || (files.length >= 3 && files.length * 2 >= connectedCount);
            if (!suspicious) {
                return true;
            }
            return confirmList(this.app, {
                title: `Move ${files.length} note(s) to the trash?`,
                message: `These notes in "${mapping.path || '/'}" point at lessons that are not in ${curriculumLabel(mapping) ?? 'this version'} any more. That many usually means the folder is set to the wrong version. Move them to Obsidian's trash (.trash, recoverable)?`,
                items: files.map((file) => file.path),
                confirmLabel: 'Move to trash',
            });
        }
        noticeDownload(where, report) {
            const lines = [
                `Chalkenso: download ${where}: ${report.created.length} created, ${report.updated.length} updated, ${report.trashed.length} trashed${report.conflicts.length ? `, ${report.conflicts.length} conflict(s)` : ''}${report.orphaned.length ? `, ${report.orphaned.length} orphaned` : ''}${report.images ? `, ${report.images} image(s) fetched` : ''}.`,
            ];
            const add = (label, names) => {
                if (names.length > 0) {
                    lines.push(`${label}: ${listNames(names)}`);
                }
            };
            add('Created', report.created);
            add('Updated', report.updated);
            add(`Conflicts (server copy in ${CONFLICTS_FOLDER}/, note unchanged)`, report.conflicts);
            add('Moved to trash (lesson deleted on server)', report.trashed);
            add('Orphaned (lesson deleted on server, kept because of local edits)', report.orphaned);
            add('Skipped (sync off)', report.skipped);
            add('Failed', report.errors);
            add('Images not fetched', report.imageErrors);
            const loud = report.conflicts.length || report.orphaned.length || report.errors.length || report.trashed.length;
            new Notice(lines.join('\n'), loud ? 15000 : undefined);
        }
        /** "Delete lesson on server": confirm, DELETE, then disconnect the note (it is kept). */
        async confirmDeleteLesson(file) {
            const mapping = this.requireMapping(file);
            const lessonId = readFrontmatterString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId);
            if (!mapping || !lessonId) {
                return;
            }
            if (!this.canDeleteIn(mapping)) {
                new Notice(`Chalkenso: you can't delete lessons in ${curriculumLabel(mapping) ?? 'this curriculum'} (no DELETE permission).`);
                return;
            }
            const confirmed = await confirmList(this.app, {
                title: 'Delete lesson on server?',
                message: `Delete the lesson of "${file.basename}" from ${curriculumLabel(mapping) ?? 'Chalkenso'}? The note stays in your vault, disconnected; uploading it later creates a new lesson.`,
                confirmLabel: 'Delete on server',
            });
            if (!confirmed) {
                return;
            }
            let message = 'deleted on the server';
            try {
                await deleteLesson(syncTarget(this.settings, mapping), lessonId);
            }
            catch (error) {
                if (!(error instanceof CurriculumApiError && error.status === 404)) {
                    this.noticeError('delete lesson', error);
                    return;
                }
                message = 'was already gone from the server';
            }
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                delete fm[FRONTMATTER.lessonId];
                delete fm[FRONTMATTER.revision];
                delete fm[FRONTMATTER.slug];
                delete fm[FRONTMATTER.lessonStatus];
                delete fm[FRONTMATTER.lastSynced];
                fm[FRONTMATTER.syncStatus] = 'not-synced';
            });
            new Notice(`Chalkenso: "${file.basename}" ${message}; the note is kept.`);
        }
        /**
         * Settles a conflict. `local`: the note is taken as based on the server copy's revision, so the
         * next upload overwrites the server with it. `server`: the note is rewritten with the server
         * copy (after confirming). Either way the conflict copy goes to Obsidian's trash.
         */
        async resolveConflict(file, keep) {
            const mapping = findFolderMapping(this.settings, file.path);
            const conflict = this.conflictFileFor(file);
            if (!mapping || !conflict) {
                return;
            }
            const conflictFrontmatter = this.app.metadataCache.getFileCache(conflict)?.frontmatter;
            const serverRevision = Number(conflictFrontmatter?.serverRevision);
            if (!Number.isInteger(serverRevision)) {
                new Notice(`Chalkenso: ${conflict.path} has no serverRevision; download again to refresh it.`);
                return;
            }
            if (keep === 'local') {
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    fm[FRONTMATTER.revision] = serverRevision;
                });
                await this.app.vault.trash(conflict, false);
                new Notice(`Chalkenso: kept your version of "${file.basename}". Upload it to replace the server copy.`);
                return;
            }
            const confirmed = await confirmList(this.app, {
                title: 'Use the server version?',
                message: `Replace the text of "${file.basename}" with the server copy from ${conflict.path}? Your local edits in this note are lost (the note is overwritten, not trashed).`,
                confirmLabel: 'Use server version',
            });
            if (!confirmed) {
                return;
            }
            await applyServerLesson(this.app, file, {
                markdownContent: stripFrontmatter(await this.app.vault.read(conflict)),
                title: conflictFrontmatter?.serverTitle ?? undefined,
                arcTitle: conflictFrontmatter?.serverArc ?? null,
                status: conflictFrontmatter?.serverStatus ?? undefined,
                revision: serverRevision,
            });
            await this.app.vault.trash(conflict, false);
            new Notice(`Chalkenso: "${file.basename}" now has the server version.`);
        }
        /** Pulls in-progress feedback into every curriculum folder. */
        async pullAllFeedback() {
            const mappings = this.settings.folders.filter((mapping) => isMappingOn(this.settings, mapping) && activeVersionId(this.settings, mapping) && !this.groupState(mapping));
            if (mappings.length === 0) {
                new Notice('Chalkenso: no curriculum folders are synced. Choose them in Settings → Chalkenso → What to sync.');
                return;
            }
            for (const mapping of mappings) {
                const problem = this.mappingProblem(mapping);
                if (problem) {
                    new Notice(`Chalkenso: ${problem}`);
                    return;
                }
                await this.pullFeedbackForMapping(mapping);
            }
        }
        /**
         * Refreshes the folder's per-lesson feedback notes from the dashboard. `pushed` reports ticks
         * that a lesson sync just closed, so one notice covers both.
         */
        async pullFeedbackForMapping(mapping, pushed) {
            // Feedback needs READ + TASKS on the workspace (per /me); without them there's nothing to pull.
            if (!this.canPullFeedback(mapping) || this.groupState(mapping)) {
                return;
            }
            // A plan typed a moment ago must be on disk before the note is read and regenerated.
            await this.flushOpenEditors();
            try {
                const result = await pullFeedback(this.app, this.settings, mapping, this.canPushTicks(mapping));
                const parts = [`${result.items} open item(s) across ${result.lessons} lesson(s)`];
                if (result.plansSent) {
                    parts.unshift(`${result.plansSent} plan(s) sent`);
                }
                if (pushed?.pushed) {
                    parts.unshift(`${pushed.pushed} closed`);
                }
                if (pushed?.failed) {
                    parts.push(`${pushed.failed} could not be closed (kept ticked, retried next sync)`);
                }
                if (result.plansFailed) {
                    parts.push(`${result.plansFailed} plan(s) could not be sent (kept, retried next sync)`);
                }
                new Notice(`Chalkenso: feedback for "${mapping.path || '/'}" — ${parts.join(', ')}.`);
            }
            catch (error) {
                this.noticeError(`pull feedback for "${mapping.path || '/'}"`, error);
            }
        }
        /** The active note's feedback mapping when it is a feedback note, else null. */
        activePlanNote() {
            const file = this.app.workspace.getActiveFile();
            if (!file || file.extension !== 'md') {
                return null;
            }
            const mapping = findFeedbackFolderMapping(this.settings, file.path);
            return mapping ? { file, mapping } : null;
        }
        /**
         * Paints "Curriculum Updates · Plan: …" for the active feedback note. `content` is the editor's
         * text while typing; otherwise the saved note is read.
         */
        updatePlanStatus(content) {
            const el = this.planStatusBarEl;
            if (!el) {
                return;
            }
            const active = this.activePlanNote();
            if (!active) {
                el.empty();
                delete el.dataset.planStatus;
                setTooltip(el, '');
                return;
            }
            if (content === undefined) {
                void this.app.vault.cachedRead(active.file).then((text) => {
                    if (this.app.workspace.getActiveFile() === active.file) {
                        this.updatePlanStatus(text);
                    }
                });
                return;
            }
            const { state, label, tooltip } = this.describePlan(active, content);
            el.empty();
            el.dataset.planStatus = state;
            const iconEl = el.createSpan({ cls: 'chalkenso-plan-icon' });
            setIcon(iconEl, 'clipboard-list');
            el.createSpan({ text: `Curriculum Updates · Plan: ${label}` });
            const stateIcon = el.createSpan({ cls: 'chalkenso-plan-icon' });
            setIcon(stateIcon, { synced: 'check', pending: 'upload-cloud', uploading: 'loader', empty: 'pencil' }[state]);
            setTooltip(el, tooltip);
        }
        /** The plan state of a feedback note: `{ state, label, tooltip }` for the status bar and menu. */
        describePlan(active, content) {
            const summary = planSummary(content);
            const canWrite = this.canPushTicks(active.mapping);
            if (this.planUploadingPath === active.file.path) {
                return { state: 'uploading', label: 'Uploading…', tooltip: 'Sending the plan to Chalkenso', summary };
            }
            if (summary.pending > 0) {
                return {
                    state: 'pending',
                    label: summary.pending > 1 ? `Not synced (${summary.pending})` : 'Not synced',
                    tooltip: canWrite
                        ? `${summary.pending} plan(s) changed since the last upload — click for actions`
                        : `${summary.pending} plan(s) changed, but this workspace doesn't allow updating tasks`,
                    summary,
                };
            }
            if (summary.written === 0) {
                return { state: 'empty', label: 'No plan yet', tooltip: 'Write what should change under each item\'s Plan heading', summary };
            }
            return {
                state: 'synced',
                label: 'Synced',
                tooltip: `${summary.written} of ${summary.items} item(s) have a plan; all are in Chalkenso`,
                summary,
            };
        }
        /**
         * "Curriculum Updates · Plan" for a feedback note: plan state (when `content` is known), upload
         * plan, open the lesson note, feedback actions.
         */
        addPlanSection(menu, file, mapping, content) {
            const active = { file, mapping };
            const canWrite = this.canPushTicks(mapping);
            const uploading = this.planUploadingPath !== null;
            addMenuSection(menu, 'Curriculum Updates · Plan');
            if (content !== undefined) {
                const { label, summary } = this.describePlan(active, content);
                addMenuInfo(menu, `Plan: ${label}`);
                menu.addItem((item) => item
                    .setTitle(summary.pending > 0 ? `Upload plan (${summary.pending} changed)` : 'Upload plan — already synced')
                    .setIcon('upload-cloud')
                    .setDisabled(!canWrite || summary.pending === 0 || uploading)
                    .onClick(() => void this.uploadPlans(file)));
            }
            else {
                menu.addItem((item) => item
                    .setTitle('Upload plan')
                    .setIcon('upload-cloud')
                    .setDisabled(!canWrite || uploading)
                    .onClick(() => void this.uploadPlans(file)));
            }
            if (!canWrite) {
                addMenuInfo(menu, 'No permission to update tasks here', 'lock');
            }
            const lessonId = readString(this.app.metadataCache.getFileCache(file)?.frontmatter, FRONTMATTER.lessonId);
            const lessonFile = lessonId ? lessonNotesById(this.app, mapping).get(lessonId) : null;
            if (lessonFile) {
                menu.addItem((item) => item
                    .setTitle('Open lesson note')
                    .setIcon('file-text')
                    .onClick(() => void this.app.workspace.getLeaf(false).openFile(lessonFile)));
            }
            this.addFeedbackItems(menu, file);
        }
        /**
         * Sends the feedback note's changed plans to their tasks and re-stamps their markers as synced.
         * Only the markers change; the note is not regenerated. Plans that fail stay "not synced".
         */
        async uploadPlans(file) {
            const mapping = findFeedbackFolderMapping(this.settings, file.path);
            if (!mapping || this.planUploadingPath) {
                return;
            }
            if (!this.canPushTicks(mapping)) {
                new Notice('Chalkenso: this workspace does not allow updating tasks (needs WRITE + TASKS).');
                return;
            }
            await this.flushOpenEditors();
            this.planUploadingPath = file.path;
            this.updatePlanStatus();
            const sent = new Map();
            let failed = 0;
            try {
                for (const [taskId, plan] of parsePlans(await this.app.vault.read(file))) {
                    if (!isPlanEdited(plan)) {
                        continue;
                    }
                    try {
                        await updateTask(syncTarget(this.settings, mapping), taskId, { plan: plan.text });
                        sent.set(taskId, plan.text);
                    }
                    catch (error) {
                        failed++;
                        console.warn(`Chalkenso: could not send the plan for ${taskId}`, error);
                    }
                }
                if (sent.size > 0) {
                    // Stamps the text that was sent; anything typed meanwhile stays "not synced".
                    await this.app.vault.process(file, (content) => markPlansSynced(content, sent));
                }
            }
            catch (error) {
                this.noticeError('upload plan', error);
            }
            finally {
                this.planUploadingPath = null;
                this.updatePlanStatus();
            }
            if (sent.size === 0 && failed === 0) {
                new Notice('Chalkenso: plan already synced.');
            }
            else if (failed > 0) {
                new Notice(`Chalkenso: ${sent.size} plan(s) uploaded, ${failed} failed (still marked not synced — see console).`);
            }
            else {
                new Notice(`Chalkenso: ${sent.size} plan(s) uploaded to Chalkenso.`);
            }
        }
        /** Writes every open editor to disk, so the note on disk has what was just typed. */
        async flushOpenEditors() {
            for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
                if (typeof leaf.view?.save === 'function' && leaf.view.file) {
                    await leaf.view.save();
                }
            }
        }
        /** The feedback note for the active note (the feedback note itself, or its lesson's). */
        activeFeedbackFile() {
            const file = this.app.workspace.getActiveFile();
            return file ? this.feedbackFileFor(file) : null;
        }
        feedbackFileFor(file) {
            if (file.extension !== 'md') {
                return null;
            }
            const mapping = findFeedbackFolderMapping(this.settings, file.path) ?? findFolderMapping(this.settings, file.path);
            return mapping ? findFeedbackFile(this.app, mapping, file) : null;
        }
        /** Ticks every open item; they close in the dashboard on the lesson's next sync. */
        async markFeedbackDone(feedbackFile) {
            await this.app.vault.process(feedbackFile, tickAll);
            new Notice('Chalkenso: all feedback ticked — upload the lesson to close it in Chalkenso.');
        }
        /** Flips the note's `sync` property on/off and refreshes its status mirror. */
        async toggleNoteSync(file) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const enable = !isNoteSyncEnabled(frontmatter);
            const hasLessonId = typeof frontmatter?.[FRONTMATTER.lessonId] === 'string';
            const nextStatus = enable
                ? hasLessonId
                    ? 'synced'
                    : 'not-synced'
                : 'disabled';
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                fm[FRONTMATTER.sync] = enable;
                fm[FRONTMATTER.syncStatus] = nextStatus;
            });
            new Notice(`Chalkenso: note sync ${enable ? 'enabled' : 'disabled'}.`);
        }
        /** Reports the effective sync state for a note: folder gate + per-note status. */
        showNoteStatus(file) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const mapping = findFolderMapping(this.settings, file.path);
            const noteStatus = computeNoteStatus(frontmatter, file.stat.mtime);
            const parts = [];
            if (!mapping) {
                parts.push('No synced folder covers this note');
            }
            else {
                parts.push(`${isManagedGroup(mapping) ? 'Group folder' : 'Folder'} "${mapping.path || '/'}"`);
                const label = curriculumLabel(mapping);
                parts.push(label ? `syncs to ${label}` : 'version set');
                if (this.isReadOnly(mapping)) {
                    parts.push('read-only (download only)');
                }
            }
            parts.push(`note ${noteStatus}`);
            const revision = readRevision(frontmatter);
            if (revision !== null) {
                parts.push(`revision ${revision}`);
            }
            if (this.conflictFileFor(file)) {
                parts.push(`conflict: server copy in ${conflictPathFor(mapping, file)}`);
            }
            const arc = frontmatter?.[FRONTMATTER.arc];
            if (typeof arc === 'string' && arc.trim()) {
                parts.push(`arc "${arc.trim()}"`);
            }
            const lastSynced = frontmatter?.[FRONTMATTER.lastSynced];
            if (typeof lastSynced === 'string' && lastSynced.trim()) {
                parts.push(`last synced ${lastSynced}`);
            }
            new Notice(`Chalkenso: ${parts.join(' · ')}`);
        }
        /** Effective explorer/status-bar state for a file, or null when it is not in a synced folder. */
        effectiveStatus(file) {
            // A note being uploaded shows the spinner regardless of its stored status.
            if (this.syncingPaths.has(file.path)) {
                return 'syncing';
            }
            const mapping = findFolderMapping(this.settings, file.path);
            if (!mapping) {
                return null;
            }
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const status = computeNoteStatus(frontmatter, file.stat.mtime);
            if (status === 'disabled' || status === 'not-synced') {
                return status;
            }
            if (this.conflictFileFor(file)) {
                return 'conflict';
            }
            if (readFrontmatterString(frontmatter, FRONTMATTER.syncStatus) === 'orphaned') {
                return 'orphaned';
            }
            if (status === 'pending' && this.isReadOnly(mapping)) {
                return 'readonly-edit'; // never uploaded; a download keeps it (newer server copy → _conflicts/)
            }
            return status;
        }
        /** Marks/unmarks a note as uploading and repaints its explorer badge + the status bar. */
        markSyncing(file, syncing) {
            if (syncing) {
                this.syncingPaths.add(file.path);
            }
            else {
                this.syncingPaths.delete(file.path);
            }
            this.refreshExplorerBadges(file);
            this.updateStatusBar();
        }
        /** Runs a per-file sync while showing the spinner on that note, clearing it whatever happens. */
        async withSyncingIndicator(file, run) {
            this.markSyncing(file, true);
            try {
                return await run();
            }
            finally {
                this.markSyncing(file, false);
            }
        }
        /** The status-bar action menu for the active note (feedback notes include their plan state). */
        openMenu(evt) {
            const file = this.app.workspace.getActiveFile();
            const show = (content) => {
                const menu = new Menu();
                this.buildNoteActions(menu, file, { content, global: true });
                menu.showAtMouseEvent(evt);
            };
            if (file && findFeedbackFolderMapping(this.settings, file.path)) {
                void this.app.vault.cachedRead(file).then(show);
                return;
            }
            show();
        }
        /**
         * The actions for a note, in titled sections — shared by the status bar and the right-click
         * menus, so both show the same things for the same note:
         * - lesson: Lesson · <note>, Curriculum · <version>, Curriculum Updates
         * - feedback note: Curriculum Updates · Plan, Curriculum · <version>
         * With `global` (the status bar) it adds All curricula and Chalkenso. `content` is the note's
         * text when known, for the plan state. Adds nothing for notes outside curriculum folders unless
         * `global`.
         */
        buildNoteActions(menu, file, { content, global = false } = {}) {
            const mdFile = file && file.extension === 'md' ? file : null;
            const feedbackMapping = mdFile ? findFeedbackFolderMapping(this.settings, mdFile.path) : null;
            const mapping = mdFile && !feedbackMapping ? findFolderMapping(this.settings, mdFile.path) : null;
            if (feedbackMapping) {
                this.addPlanSection(menu, mdFile, feedbackMapping, content);
                this.addCurriculumFolderSection(menu, feedbackMapping);
            }
            else if (mapping) {
                this.addLessonSection(menu, mdFile, mapping);
                this.addCurriculumFolderSection(menu, mapping);
                this.addUpdatesSection(menu, mdFile);
            }
            else {
                const unsynced = this.unsyncedCurriculumContext(file);
                if (unsynced) {
                    this.addUnsyncedSection(menu, unsynced);
                }
                if (global) {
                    this.addUpdatesSection(menu, null);
                }
            }
            if (global) {
                this.addAllCurriculaSection(menu);
                this.host.addPluginSection(menu);
            }
        }
        /** "Lesson · <note>": its status and the actions on this one note. */
        addLessonSection(menu, file, mapping) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const status = this.effectiveStatus(file);
            const readOnly = this.isReadOnly(mapping);
            const enabled = isNoteSyncEnabled(frontmatter);
            addMenuSection(menu, `Lesson · ${file.basename}`);
            addMenuInfo(menu, `Status: ${status ? STATUS_LABEL[status] : 'unknown'}`);
            menu.addItem((item) => item
                .setTitle('Upload this lesson')
                .setIcon('upload')
                .setDisabled(readOnly)
                .onClick(() => void this.syncCurrentNote(file)));
            menu.addItem((item) => item
                .setTitle('Show changes…')
                .setIcon('file-diff')
                .onClick(() => void this.showLessonChanges(file)));
            menu.addItem((item) => item
                .setTitle('Set arc…')
                .setIcon('square-library')
                .onClick(() => void this.setArcForNote(file)));
            this.addConflictItems(menu, file);
            menu.addItem((item) => item
                .setTitle(enabled ? 'Disable sync for this lesson' : 'Enable sync for this lesson')
                .setIcon('power')
                .onClick(() => void this.toggleNoteSync(file)));
            menu.addItem((item) => item.setTitle('Show sync details').setIcon('list-checks').onClick(() => this.showNoteStatus(file)));
            if (this.hasLessonId(file) && this.canDeleteIn(mapping)) {
                menu.addItem((item) => item
                    .setTitle('Delete lesson on server…')
                    .setIcon('trash')
                    .onClick(() => void this.confirmDeleteLesson(file)));
            }
        }
        /** "Curriculum · <course · version>": the folder the note belongs to. */
        addCurriculumFolderSection(menu, mapping) {
            const hasVersion = Boolean(activeVersionId(this.settings, mapping));
            const label = curriculumLabel(mapping) ?? (mapping.path || '/');
            const readOnly = this.isReadOnly(mapping);
            addMenuSection(menu, `Curriculum · ${hasVersion ? label : 'no version chosen'}`);
            if (!hasVersion) {
                addMenuInfo(menu, 'Choose a version in Settings → Chalkenso', 'settings');
                return;
            }
            if (readOnly) {
                addMenuInfo(menu, 'Read-only: download only', 'lock');
            }
            menu.addItem((item) => item
                .setTitle(readOnly ? 'Sync folder (download only)' : 'Sync folder (upload, then download)')
                .setIcon('refresh-cw')
                .onClick(() => void this.runForMapping(mapping, 'sync')));
            menu.addItem((item) => item.setTitle('Upload folder').setIcon('upload').setDisabled(readOnly).onClick(() => void this.runForMapping(mapping, 'upload')));
            menu.addItem((item) => item.setTitle('Download folder').setIcon('download').onClick(() => void this.runForMapping(mapping, 'download')));
        }
        /** "Curriculum Updates": the lesson's feedback note and feedback actions. */
        addUpdatesSection(menu, file) {
            addMenuSection(menu, 'Curriculum Updates');
            const feedbackFile = file ? this.feedbackFileFor(file) : null;
            if (feedbackFile && feedbackFile !== file) {
                menu.addItem((item) => item
                    .setTitle('Open feedback & plan')
                    .setIcon('clipboard-list')
                    .onClick(() => void this.app.workspace.getLeaf(false).openFile(feedbackFile)));
            }
            this.addFeedbackItems(menu, file);
        }
        /** "All curricula": actions across every curriculum folder. */
        addAllCurriculaSection(menu) {
            addMenuSection(menu, 'All curricula');
            menu.addItem((item) => item
                .setTitle('Sync all curriculum folders')
                .setIcon('refresh-cw')
                .onClick(() => void this.runForAllMappings('sync')));
        }
        /** True when this module shows a status-bar item for the file (so the host's fallback hides). */
        showsStatusFor(file) {
            return Boolean(file && file.extension === 'md' &&
                (findFolderMapping(this.settings, file.path) || findFeedbackFolderMapping(this.settings, file.path)));
        }
        /**
         * For a file in curriculum territory that isn't a synced lesson — under the curriculums or
         * groups folder, or in a synced folder's README / plugin folders — `{ mapping, folder,
         * otherServer }`: the covering synced folder (if any), the course or group folder it is in (an
         * unmapped folder directly under the curriculums or groups folder), and whether that folder is
         * mapped for the other server. Null outside curriculum territory.
         */
        unsyncedCurriculumContext(file) {
            if (!file || this.showsStatusFor(file)) {
                return null;
            }
            const mapping = findCoveringMapping(this.settings, file.path);
            // Under any organisation's Curriculums or Groups folder.
            const container = activeConnections()
                .flatMap((connection) => [curriculumsRootOf(connection), groupsRootOf(connection)])
                .find((candidate) => candidate && file.path.startsWith(`${candidate}/`)) ?? null;
            if (!mapping && !container) {
                return null;
            }
            let folder = null;
            if (!mapping) {
                const segments = file.path.slice(container.length + 1).split('/');
                folder = segments.length > 1 && !segments[0].startsWith('_') ? `${container}/${segments[0]}` : null;
            }
            return { mapping, folder, otherServer: Boolean(folder) && this.isMappedPath(folder) };
        }
        /** "Curriculum · <folder>" for a file that isn't a synced lesson: why, and how to sync it. */
        addUnsyncedSection(menu, { mapping, folder, otherServer }) {
            if (mapping) {
                this.addCurriculumFolderSection(menu, mapping);
                addMenuInfo(menu, 'This file is not a lesson (folder README or plugin folder)');
                return;
            }
            addMenuSection(menu, `Curriculum · ${folder ? folder.split('/').pop() : 'not synced'}`);
            if (otherServer) {
                addMenuInfo(menu, `Folder of the ${this.settings.devMode ? 'production' : 'dev'} server`, 'users');
            }
            else if (folder) {
                addMenuInfo(menu, 'This folder is not synced. Choose what syncs in Settings → Chalkenso, or map it');
                this.addFolderSetupItems(menu, folder, false);
            }
            else {
                addMenuInfo(menu, 'Curriculum folders are created from Settings → Chalkenso → What to sync');
            }
        }
        /** "Map folder to a curriculum version…" (unmapped folders) and "Disconnect folder from its previous server…". */
        addFolderSetupItems(menu, path, mapped, prefix = '') {
            // After a "Chalkenso: " prefix the title goes on in lower case, like the other folder items.
            const title = (text) => `${prefix}${prefix ? text[0].toLowerCase() : text[0]}${text.slice(1)}`;
            if (!mapped) {
                menu.addItem((item) => item
                    .setTitle(title('Map folder to a curriculum version…'))
                    .setIcon('link')
                    .onClick(() => void this.mapFolderToWorkspace(path)));
            }
            menu.addItem((item) => item
                .setTitle(title('Disconnect folder from its previous server…'))
                .setIcon('unlink')
                .onClick(() => void this.disconnectFolder(path)));
        }
        /** "Mark lesson feedback done" (when the note has feedback) + "Pull feedback". */
        addFeedbackItems(menu, file, prefix = '') {
            const feedbackFile = file ? this.feedbackFileFor(file) : null;
            if (feedbackFile) {
                menu.addItem((item) => item
                    .setTitle(`${prefix}Mark lesson feedback done`)
                    .setIcon('check-circle')
                    .onClick(() => void this.markFeedbackDone(feedbackFile)));
            }
            menu.addItem((item) => item
                .setTitle(`${prefix}Pull feedback`)
                .setIcon('download')
                .onClick(() => void this.pullAllFeedback()));
        }
        /** Reflects the active note's curriculum/status and arc in the status bar. */
        updateStatusBar() {
            this.updatePlanStatus();
            // Mapping a folder (or switching dev/production) changes whether the host's fallback shows.
            this.host.updateFallbackStatusBar?.();
            const file = this.app.workspace.getActiveFile();
            const mdFile = file && file.extension === 'md' ? file : null;
            const status = mdFile ? this.effectiveStatus(mdFile) : null;
            const mapping = mdFile ? findFolderMapping(this.settings, mdFile.path) : null;
            if (this.statusBarEl) {
                if (status && mdFile) {
                    const label = mapping ? curriculumLabel(mapping) : null;
                    this.statusBarEl.dataset.chalkensoStatus = status;
                    const env = this.settings.devMode ? 'DEV · ' : '';
                    // "<where> · Published|Draft · <sync state>" (the publish state once it is in Chalkenso).
                    const frontmatter = this.app.metadataCache.getFileCache(mdFile)?.frontmatter;
                    const publish = status === 'not-synced' || status === 'syncing'
                        ? ''
                        : `${this.isPublished(frontmatter) ? 'Published' : 'Draft'} · `;
                    const lock = mapping && this.isReadOnly(mapping) ? 'Read-only · ' : '';
                    this.statusBarEl.setText(`${env}${label ?? 'Curriculum'} · ${lock}${publish}${STATUS_LABEL[status]}`);
                    this.statusBarEl.toggleClass('chalkenso-dev', this.settings.devMode);
                    this.statusBarEl.setAttribute('aria-label', label ? `Syncs to ${label} — ${STATUS_LABEL[status]}` : STATUS_LABEL[status]);
                }
                else {
                    delete this.statusBarEl.dataset.chalkensoStatus;
                    this.statusBarEl.setText('');
                    this.statusBarEl.removeAttribute('aria-label');
                }
            }
            if (this.changesStatusBarEl) {
                // Only while there is something to upload: a new lesson, or one edited since its last upload.
                const show = Boolean(mdFile && mapping && (status === 'pending' || status === 'not-synced') && !this.isReadOnly(mapping));
                if (show && this.changesStatusBarEl.childElementCount === 0) {
                    setIcon(this.changesStatusBarEl.createSpan({ cls: 'chalkenso-statusbar-icon' }), 'file-diff');
                    this.changesStatusBarEl.createSpan({ text: 'Show changes' });
                    setTooltip(this.changesStatusBarEl, 'Compare this note with Chalkenso before uploading');
                }
                this.changesStatusBarEl.toggle(show);
            }
            if (this.arcStatusBarEl) {
                // Only meaningful for notes in a synced folder; the arc is authored per note before syncing.
                if (mdFile && mapping) {
                    const frontmatter = this.app.metadataCache.getFileCache(mdFile)?.frontmatter;
                    const arc = frontmatter?.[FRONTMATTER.arc];
                    const arcTitle = typeof arc === 'string' && arc.trim() ? arc.trim() : null;
                    // Icon (denotes a lesson section) + text, rebuilt each update since setText clears children.
                    this.arcStatusBarEl.empty();
                    const iconEl = this.arcStatusBarEl.createSpan({ cls: 'chalkenso-arc-icon' });
                    setIcon(iconEl, 'square-library');
                    this.arcStatusBarEl.createSpan({ text: arcTitle ? `Arc: ${arcTitle}` : 'Arc: none' });
                    setTooltip(this.arcStatusBarEl, arcTitle ? `Arc: ${arcTitle} — click to change` : 'No arc set — click to choose');
                    this.arcStatusBarEl.toggleClass('chalkenso-arc-unset', !arcTitle);
                }
                else {
                    this.arcStatusBarEl.empty();
                    setTooltip(this.arcStatusBarEl, '');
                }
            }
        }
        /**
         * Explorer dots, tags and locks are painted by the host. It uses the file-explorer view's
         * internal item map, so it is best-effort and guarded — a UI change there never breaks syncing.
         */
        refreshExplorerBadges(only) {
            this.host.refreshExplorer(only);
        }
        /** The explorer dot for a lesson note: `{ status, published, tooltip, titleTooltip }`, or null. */
        dotState(file) {
            const status = this.effectiveStatus(file);
            if (!status) {
                return null;
            }
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            return {
                status,
                published: status !== 'not-synced' && this.isPublished(frontmatter),
                tooltip: this.statusDotTooltip(status, frontmatter),
                titleTooltip: this.titleTooltip(file, frontmatter),
            };
        }
        /** Lock icon after a synced folder's name when `/me` says it is read-only (download only). */
        paintFolderLock(el, folder) {
            const mapping = this.getFolderMappingByExactPath(folder.path);
            let lock = el.querySelector(':scope > .chalkenso-readonly-lock');
            if (!mapping || !isMappingOn(this.settings, mapping) || !this.isReadOnly(mapping)) {
                lock?.remove();
                return;
            }
            if (!lock) {
                lock = el.createSpan({ cls: 'chalkenso-readonly-lock' });
                setIcon(lock, 'lock');
            }
            setTooltip(lock, `${isManagedGroup(mapping) ? 'Group curriculum' : 'Curriculum'} · read-only: you can download, not upload`, { placement: 'right' });
        }
        /**
         * Published in Chalkenso, per the status the server returned on the last sync. Notes synced before
         * this was tracked fall back to their own `status` property until they are synced again.
         */
        isPublished(frontmatter) {
            const recorded = frontmatter?.[FRONTMATTER.lessonStatus] ?? frontmatter?.[FRONTMATTER.status];
            return typeof recorded === 'string' && recorded.trim().toUpperCase() === 'PUBLISHED';
        }
        /** Tooltip for the status dot: the sync state plus, when synced, the last sync time. */
        statusDotTooltip(status, frontmatter) {
            const synced = status !== 'not-synced' && status !== 'syncing';
            const base = synced
                ? `${this.isPublished(frontmatter) ? 'Published' : 'Draft'} · ${STATUS_LABEL[status]}`
                : STATUS_LABEL[status];
            if (status === 'synced' || status === 'pending' || status === 'readonly-edit' || status === 'conflict' || status === 'orphaned') {
                const lastSynced = frontmatter?.[FRONTMATTER.lastSynced];
                if (typeof lastSynced === 'string' && lastSynced.trim()) {
                    return `${base} · last synced ${this.formatTimestamp(lastSynced.trim())}`;
                }
            }
            return base;
        }
        /** Tooltip for the note title: the lesson name (title override or file name) and its arc. */
        titleTooltip(file, frontmatter) {
            const titleOverride = frontmatter?.[FRONTMATTER.title];
            const lessonName = typeof titleOverride === 'string' && titleOverride.trim() ? titleOverride.trim() : file.basename;
            const arc = frontmatter?.[FRONTMATTER.arc];
            const arcName = typeof arc === 'string' && arc.trim() ? arc.trim() : null;
            return `Lesson: ${lessonName} · ${arcName ? `Arc: ${arcName}` : 'No arc set'}`;
        }
        /** Formats an ISO timestamp for display, falling back to the raw string if unparseable. */
        formatTimestamp(iso) {
            const date = new Date(iso);
            return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
        }
        /** Finds a mapping whose path is exactly this folder (not merely a covering ancestor). */
        getFolderMappingByExactPath(path) {
            const normalized = path.replace(/\/+$/, '');
            return this.settings.folders.find((folder) => isInActiveEnv(this.settings, folder) && folder.path.replace(/\/+$/, '') === normalized);
        }
        /** Caches a folder's resolved course/version from a manifest so we can show where it syncs. */
        async rememberManifest(mapping, manifest) {
            if (mapping.courseTitle === manifest.version.course.title &&
                mapping.versionLabel === manifest.version.label) {
                return;
            }
            mapping.courseTitle = manifest.version.course.title;
            mapping.versionLabel = manifest.version.label;
            await this.saveSettings();
        }
        buildFileMenu(menu, file) {
            if (file instanceof TFolder) {
                this.buildFolderMenu(menu, file);
            }
            else if (file instanceof TFile && file.extension === 'md') {
                this.buildNoteMenu(menu, file);
            }
        }
        buildFolderMenu(menu, folder) {
            const path = folder.path === '/' ? '' : folder.path;
            // An organisation's Groups folder: act on its group curricula (it is never mapped by hand).
            const groupsOf = activeConnections().find((connection) => groupsRootOf(connection) && groupsRootOf(connection) === normalizeFolderPath(path));
            if (groupsOf) {
                menu.addItem((item) => item
                    .setTitle(`Chalkenso: download all group curricula of ${organizationLabel(groupsOf)}`)
                    .setIcon('download')
                    .onClick(() => void this.runForGroupMappings('download', groupsOf.id)));
                menu.addItem((item) => item
                    .setTitle(`Chalkenso: sync all group curricula of ${organizationLabel(groupsOf)} (upload, then download)`)
                    .setIcon('refresh-cw')
                    .onClick(() => void this.runForGroupMappings('sync', groupsOf.id)));
                return;
            }
            const mapping = this.getFolderMappingByExactPath(path);
            if (!mapping) {
                if (this.settings.folders.some((candidate) => !isInActiveEnv(this.settings, candidate) && normalizeFolderPath(candidate.path) === normalizeFolderPath(path))) {
                    menu.addItem((item) => item
                        .setTitle(`Chalkenso: folder of the ${this.settings.devMode ? 'production' : 'dev'} server`)
                        .setIcon('users')
                        .setDisabled(true));
                }
                else if (this.curriculumFolderCandidates(true).includes(path)) {
                    this.addFolderSetupItems(menu, path, false, 'Chalkenso: ');
                }
                return;
            }
            const managed = isManagedGroup(mapping);
            const ready = isMappingOn(this.settings, mapping) && Boolean(activeVersionId(this.settings, mapping)) && !this.groupState(mapping);
            const readOnly = this.isReadOnly(mapping);
            if (managed) {
                menu.addItem((item) => item
                    .setTitle(`Chalkenso: group curriculum${readOnly ? ' (read-only)' : ''}`)
                    .setIcon(readOnly ? 'lock' : 'users')
                    .setDisabled(true));
            }
            else if (readOnly) {
                menu.addItem((item) => item.setTitle('Chalkenso: read-only (download only)').setIcon('lock').setDisabled(true));
            }
            menu.addItem((item) => item
                .setTitle(readOnly ? 'Chalkenso: sync folder (download only)' : 'Chalkenso: sync folder (upload, then download)')
                .setIcon('refresh-cw')
                .setDisabled(!ready)
                .onClick(() => void this.runForMapping(mapping, 'sync')));
            menu.addItem((item) => item
                .setTitle('Chalkenso: upload folder')
                .setIcon('upload')
                .setDisabled(!ready || readOnly)
                .onClick(() => void this.runForMapping(mapping, 'upload')));
            menu.addItem((item) => item
                .setTitle('Chalkenso: download folder')
                .setIcon('download')
                .setDisabled(!ready)
                .onClick(() => void this.runForMapping(mapping, 'download')));
            menu.addItem((item) => item
                .setTitle('Chalkenso: pull feedback')
                .setIcon('download')
                .setDisabled(!ready)
                .onClick(() => void this.pullFeedbackForMapping(mapping)));
            this.addFolderSetupItems(menu, path, true, 'Chalkenso: ');
        }
        /** Right-click on a note (file explorer or inside the note): the same sections as the status bar. */
        buildNoteMenu(menu, file, content) {
            this.buildNoteActions(menu, file, { content });
        }
        /** "Resolve conflict" items, shown only while the note has a `_conflicts/` copy. */
        addConflictItems(menu, file, prefix = '') {
            if (!this.conflictFileFor(file)) {
                return;
            }
            menu.addItem((item) => item
                .setTitle(`${prefix}Resolve conflict: keep my version`)
                .setIcon('check')
                .onClick(() => void this.resolveConflict(file, 'local')));
            menu.addItem((item) => item
                .setTitle(`${prefix}Resolve conflict: use server version`)
                .setIcon('download')
                .onClick(() => void this.resolveConflict(file, 'server')));
        }
        noticeError(action, error) {
            // A closed group curriculum is explained by the clean-up notice instead.
            if (error instanceof CurriculumApiError && error.isGroupClosed && this.managedMappingFor(error.versionId)) {
                console.info(`Chalkenso: ${action} — group curriculum closed`);
                return;
            }
            const message = error instanceof CurriculumApiError
                ? error.message
                : error.message;
            new Notice(`Chalkenso: failed to ${action} — ${message}`);
            console.error(`Chalkenso: failed to ${action}`, error);
        }
    }

    return { Controller: CurriculumController, workspaceFolderPath, STATUS_LABEL, FOLDER_STATUS_ORDER, normalizeFolderPath, ensureFolderPath, isManagedGroup, isInActiveEnv, activeVersionId, sanitizeFolderName, curriculumsRootOf, groupsRootOf, organizationLabel };
})();

// ==============================================================================================
// Host plugin
// ==============================================================================================

/** A muted explanatory line in the settings tab. */
function settingsNote(containerEl, text) {
    containerEl.createEl('p', { cls: 'setting-item-description', text });
}

/** Autocomplete of vault folders; choosing one fires `change` (the root folder commits on change). */
class VaultFolderSuggest extends AbstractInputSuggest {
    constructor(app, inputEl) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }
    getSuggestions(query) {
        const lowerQuery = query.toLowerCase();
        return this.app.vault
            .getAllLoadedFiles()
            .filter((file) => file instanceof TFolder && !file.isRoot())
            .filter((folder) => folder.path.toLowerCase().includes(lowerQuery))
            .slice(0, 100);
    }
    renderSuggestion(folder, el) {
        el.setText(folder.path);
    }
    selectSuggestion(folder) {
        this.inputEl.value = folder.path;
        this.inputEl.trigger('input');
        this.inputEl.trigger('change');
        this.close();
    }
}

class ChalkensoSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        /** Checkbox changes not saved yet: item key → wanted (true = sync it). */
        this.draft = new Map();
    }
    display() {
        const { containerEl } = this;
        const general = this.plugin.store.general;
        containerEl.empty();

        if (general.devMode) {
            containerEl.createEl('p', {
                cls: 'chalkenso-dev-banner',
                text: `Developer mode is on — syncing with ${general.devBaseUrl || '(no dev server URL set)'} and the organisations added for it. Folders you choose now are created for the dev server (with " (dev)"), and dev ids are kept apart (devLessonId, devRevision, …).`,
            });
        }

        new Setting(containerEl).setName('Connection').setHeading();
        new Setting(containerEl)
            .setName('Server URL')
            .setDesc(`Your Chalkenso address: ${DEFAULT_BASE_URL}, or your own server.`)
            .addText((text) => text
            .setPlaceholder(DEFAULT_BASE_URL)
            .setValue(general.baseUrl)
            .onChange(async (value) => {
            await this.plugin.updateGeneral({ baseUrl: value.trim() });
        }));
        new Setting(containerEl)
            .setName('Developer mode')
            .setDesc('Sync with a dev server and the organisations added for it instead. Production ids in your notes are never touched.')
            .addToggle((toggle) => toggle.setValue(general.devMode).onChange(async (value) => {
            this.draft.clear();
            this.loadedMeThisOpen = false;
            await this.plugin.updateGeneral({ devMode: value });
            this.display();
        }));
        if (general.devMode) {
            new Setting(containerEl)
                .setName('Dev server URL')
                .addText((text) => text
                .setPlaceholder(DEFAULT_DEV_BASE_URL)
                .setValue(general.devBaseUrl)
                .onChange(async (value) => {
                await this.plugin.updateGeneral({ devBaseUrl: value.trim() });
            }));
        }

        new Setting(containerEl).setName('Organisations').setHeading().setClass('chalkenso-section-heading');
        const accounts = this.renderOrganisations(containerEl.createDiv({ cls: 'chalkenso-section' }));

        new Setting(containerEl).setName('Root folder').setHeading().setClass('chalkenso-section-heading');
        this.renderRootFolder(containerEl);

        new Setting(containerEl).setName('What to sync').setHeading().setClass('chalkenso-section-heading');
        this.renderSelection(containerEl.createDiv({ cls: 'chalkenso-section' }), accounts);

        new Setting(containerEl).setName('Lessons').setHeading().setClass('chalkenso-section-heading');
        new Setting(containerEl)
            .setName('Default lesson status')
            .setDesc('Applied to created lessons when a note has no `status` property.')
            .addDropdown((dropdown) => dropdown
            .addOption('DRAFT', 'Draft')
            .addOption('PUBLISHED', 'Published')
            .setValue(this.plugin.curriculum.settings.defaultStatus)
            .onChange(async (value) => {
            this.plugin.curriculum.settings.defaultStatus = value === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
            await this.plugin.curriculum.saveSettings();
        }));

        new Setting(containerEl).setName('Recent problems').setHeading().setClass('chalkenso-section-heading');
        const problems = containerEl.createDiv({ cls: 'chalkenso-section' });
        const renderProblems = () => this.plugin.renderProblems(problems, renderProblems);
        renderProblems();
    }
    hide() {
        this.loadedMeThisOpen = false;
        this.draft.clear();
        super.hide?.();
    }
    /**
     * One row per organisation of the active server — its name, who its token signs in as, its
     * folder, Refresh, Remove, and the token (paste a new one to replace it) — then "Add
     * organisation". Every opening of the settings loads each account fresh (`GET /api/sync/me`).
     * Returns the organisations whose account loaded, as `{ connection, me }`.
     */
    renderOrganisations(containerEl) {
        const plugin = this.plugin;
        const general = plugin.store.general;
        const connections = plugin.activeConnections();
        if (!this.loadedMeThisOpen) {
            // `loadMe` remembers failures too, and re-rendering only happens when no token changed
            // meanwhile, so this can't loop or steal focus while typing.
            this.loadedMeThisOpen = true;
            const keys = connections.map((connection) => plugin.meKey(connection)).join(',');
            void plugin.loadAllMe(true).then(() => {
                if (plugin.activeConnections().map((connection) => plugin.meKey(connection)).join(',') === keys && this.containerEl.isShown()) {
                    this.display();
                }
            });
        }
        const loaded = [];
        for (const connection of connections) {
            const me = plugin.currentMe(connection.id);
            const setting = new Setting(containerEl).setName(connection.organizationName || 'Organisation');
            setting.settingEl.addClass('chalkenso-organisation');
            const status = setting.descEl.createDiv({ cls: 'chalkenso-verify-status' });
            if (!me) {
                status.setText('Loading your account…');
            }
            else if (me.error) {
                status.setText(`Couldn't load your account: ${me.error} Folders you already sync still work.`);
                status.addClass('chalkenso-verify-error');
            }
            else {
                const { user } = me.data;
                const role = user?.role === 'SUPERADMIN' ? ' · super admin' : '';
                status.setText(`Signed in as ${user?.name ?? 'unknown'}${user?.email ? ` (${user.email})` : ''}${role} · folder ${connection.folder ?? '(once the root folder is chosen)'}`);
                status.addClass('chalkenso-verify-ok');
                loaded.push({ connection, me: me.data });
            }
            setting.addText((text) => {
                text.setPlaceholder('usr_… (paste a new token to replace it)').setValue(connection.token ?? '');
                text.inputEl.type = 'password';
                text.inputEl.addClass('chalkenso-token-input');
                text.inputEl.addEventListener('change', async () => {
                    const token = text.getValue().trim();
                    if (!token || token === connection.token) {
                        text.setValue(connection.token ?? '');
                        return;
                    }
                    const result = await plugin.replaceConnectionToken(connection, token);
                    if (result.error) {
                        new Notice(`Chalkenso: ${result.error}`);
                    }
                    this.draft.clear();
                    this.display();
                });
            });
            setting.addExtraButton((button) => button.setIcon('refresh-cw').setTooltip('Refresh').onClick(async () => {
                status.setText('Loading…');
                await plugin.loadMe(connection.id, true, { notify: true });
                this.display();
            }));
            setting.addExtraButton((button) => button.setIcon('trash-2').setTooltip('Remove this organisation').onClick(async () => {
                if (await plugin.removeConnection(connection)) {
                    this.draft.clear();
                    this.display();
                }
            }));
        }
        const baseUrl = (general.devMode ? general.devBaseUrl || DEFAULT_DEV_BASE_URL : general.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
        let token = '';
        new Setting(containerEl)
            .setName(connections.length ? 'Add another organisation' : 'Add your organisation')
            .setDesc(`Paste a sync token made in that organisation: in Chalkenso, switch to it, then Tokens at the bottom of the admin sidebar (${baseUrl}${TOKEN_PAGE_PATH}) → Create token. It starts with usr_, acts as you, and works in that organisation only. Its curriculums and groups get their own folder: ${plugin.rootFolder() ?? '<root folder>'}/<organisation name>.`)
            .addText((text) => {
            text.setPlaceholder('usr_…').onChange((value) => {
                token = value.trim();
            });
            text.inputEl.type = 'password';
            text.inputEl.addClass('chalkenso-token-input');
        })
            .addButton((button) => button.setButtonText('Add').setCta().onClick(async () => {
            if (!token.startsWith('usr_')) {
                new Notice('Chalkenso: paste a sync token; it starts with usr_.');
                return;
            }
            button.setDisabled(true);
            const result = await plugin.addConnection(token);
            new Notice(result.error ? `Chalkenso: ${result.error}` : `Chalkenso: added ${result.connection.organizationName}. Choose what to sync from it below.`);
            this.draft.clear();
            this.display();
        }));
        return loaded;
    }
    /** The one folder everything is kept in. */
    renderRootFolder(containerEl) {
        const plugin = this.plugin;
        const root = plugin.rootFolder();
        new Setting(containerEl)
            .setName('Folder')
            .setDesc('Everything you choose below is kept in this folder, and only what is inside it syncs: one folder per organisation, each with Curriculums/<course – version> and Groups/<course – group>. Rename or move folders in Obsidian as you like; the tag next to each folder says what it is.')
            .addText((text) => {
            text.setPlaceholder(DEFAULT_ROOT_FOLDER).setValue(root ?? '');
            text.inputEl.addEventListener('change', async () => {
                const value = normalizePath(text.getValue().trim()).replace(/^\/+|\/+$/g, '');
                if (value !== (plugin.rootFolder() ?? '')) {
                    await plugin.setRootFolder(value || null);
                    this.display();
                }
            });
            new VaultFolderSuggest(this.app, text.inputEl);
        });
        if (!root) {
            settingsNote(containerEl, 'Choose a folder to start. Until then nothing syncs.');
        }
    }
    /**
     * Everything each organisation's token can reach, as checkboxes under the organisation's name:
     * each curriculum and group curriculum. Checked = kept in the vault. Changes apply on "Save" (new
     * folders are created in the organisation's folder and downloaded; unchecked folders stop syncing
     * and stay in the vault).
     */
    renderSelection(containerEl, accounts) {
        const plugin = this.plugin;
        if (!plugin.rootFolder()) {
            settingsNote(containerEl, 'Choose the root folder above first.');
            return;
        }
        if (plugin.activeConnections().length === 0) {
            settingsNote(containerEl, 'Add your organisation above with its sync token. Once its account loads, every curriculum you can sync there is listed here to choose from.');
            return;
        }
        if (accounts.length === 0) {
            settingsNote(containerEl, 'Once an organisation’s account loads, everything you can sync there is listed here.');
            return;
        }
        const items = accounts.flatMap(({ connection, me }) => plugin.availableItems(connection, me));
        // Listed here = seen, so none of it is announced as new later.
        void plugin.markSeen(items);
        const named = plugin.activeConnections().length > 1;
        for (const { connection } of accounts) {
            const own = items.filter((item) => item.connection === connection);
            if (named) {
                containerEl.createDiv({ cls: 'chalkenso-organisation-heading', text: connection.organizationName || 'Organisation' });
            }
            if (own.length === 0) {
                containerEl.createEl('p', { cls: 'setting-item-description', text: named ? 'Nothing to sync here yet.' : 'Your account has nothing to sync yet.' });
                continue;
            }
            for (const group of [
                { title: 'Curriculums', items: own.filter((item) => item.type === 'curriculum') },
                { title: 'Groups', items: own.filter((item) => item.type === 'group') },
            ]) {
                if (group.items.length === 0) {
                    continue;
                }
                containerEl.createDiv({ cls: 'chalkenso-item-group', text: group.title });
                for (const item of group.items) {
                    this.renderItem(containerEl, item, () => refreshActions());
                }
            }
        }
        const actions = new Setting(containerEl).setClass('chalkenso-selection-actions');
        const summary = actions.descEl;
        let saveButton = null;
        let revertButton = null;
        const refreshActions = () => {
            const changes = plugin.selectionChanges(items, this.draft);
            const parts = [];
            if (changes.add.length) {
                parts.push(`${changes.add.length} to add (created in the organisation’s folder and downloaded)`);
            }
            if (changes.remove.length) {
                parts.push(`${changes.remove.length} to stop syncing (folders stay in your vault)`);
            }
            summary.setText(parts.length ? parts.join(' · ') : 'Check what you want in this vault, then Save. To sync a folder you already have, use “Map folder to a curriculum version”.');
            saveButton?.setDisabled(parts.length === 0);
            revertButton?.setDisabled(parts.length === 0);
        };
        actions
            .addButton((button) => {
            revertButton = button;
            button.setButtonText('Revert').onClick(() => {
                this.draft.clear();
                this.display();
            });
        })
            .addButton((button) => {
            saveButton = button;
            button.setButtonText('Save').setCta().onClick(async () => {
                button.setDisabled(true);
                const applied = await plugin.applySelection(plugin.selectionChanges(items, this.draft));
                if (applied) {
                    this.draft.clear();
                }
                this.display();
            });
        });
        refreshActions();
    }
    renderItem(containerEl, item, onChange) {
        const plugin = this.plugin;
        const row = containerEl.createEl('label', { cls: 'chalkenso-item' });
        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.draft.has(item.key) ? this.draft.get(item.key) : item.selected;
        const text = row.createDiv({ cls: 'chalkenso-item-text' });
        const name = text.createDiv({ cls: 'chalkenso-item-name', text: item.label });
        if (item.readOnly) {
            const lock = name.createSpan({ cls: 'chalkenso-readonly-lock' });
            setIcon(lock, 'lock');
            setTooltip(lock, 'Read-only: you can download, not upload');
        }
        const desc = text.createDiv({ cls: 'chalkenso-item-desc' });
        const describe = () => {
            const wanted = checkbox.checked;
            const lines = [];
            if (item.selected && wanted) {
                lines.push(`→ ${item.path || '/'}${item.lastSynced ? ` · last synced ${new Date(item.lastSynced).toLocaleString()}` : ''}`);
            }
            else if (item.selected) {
                lines.push(`Stops syncing on Save; ${item.path || '/'} stays in your vault`);
            }
            else if (wanted) {
                lines.push(`New folder on Save: ${plugin.plannedPath(item)}, then downloaded`);
            }
            if (item.detail) {
                lines.push(item.detail);
            }
            desc.setText(lines.join(' · '));
            row.toggleClass('is-changed', wanted !== item.selected);
        };
        checkbox.addEventListener('change', () => {
            if (checkbox.checked === item.selected) {
                this.draft.delete(item.key);
            }
            else {
                this.draft.set(item.key, checkbox.checked);
            }
            describe();
            onChange();
        });
        describe();
    }
}

class ChalkensoPlugin extends Plugin {
    async onload() {
        activeHost = this;
        /** `/me` per organisation (connection id → `{ key, data, error }`), and loads in flight. */
        this.meCache = new Map();
        this.mePending = new Map();
        await this.loadStore();

        this.curriculum = new Curriculum.Controller(this, 'curriculum');
        await this.curriculum.onload();
        this.bindSharedSettings(this.curriculum);
        // Each organisation's folder (with its Curriculums and Groups folders) lives in the root folder.
        if (this.placeConnections(this.rootFolder())) {
            await this.curriculum.saveSettings();
        }

        this.addSettingTab(new ChalkensoSettingTab(this.app, this));
        // One painter for the explorer (lesson dots, folder tags, locks).
        this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshExplorer()));
        this.registerEvent(this.app.vault.on('create', () => this.refreshExplorer()));
        this.app.workspace.onLayoutReady(() => this.refreshExplorer());
        // Fallback status-bar item when the active note isn't a synced lesson: the way to reach every action.
        this.fallbackStatusBarEl = this.addStatusBarItem();
        this.fallbackStatusBarEl.addClass('chalkenso-statusbar');
        this.fallbackStatusBarEl.onClickEvent((evt) => this.openPluginMenu(evt));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateFallbackStatusBar()));
        this.registerEvent(this.app.workspace.on('file-open', () => this.updateFallbackStatusBar()));
        this.registerEvent(this.app.vault.on('rename', () => this.updateFallbackStatusBar()));
        this.app.workspace.onLayoutReady(() => this.updateFallbackStatusBar());
        this.addCommand({
            id: 'show-problems',
            name: 'Show recent sync problems',
            callback: () => this.openProblems(),
        });
        // Keep folder mappings pointing at the right place when a synced folder is renamed or moved.
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFolder) {
                void this.followFolderMove(oldPath, file.path);
            }
        }));
        // Who am I / what can I reach, per organisation: tells about new things to sync. Offline is fine: chosen folders still sync.
        this.app.workspace.onLayoutReady(() => void this.loadAllMe(false, { notify: true }));
    }

    /** Shows the "Chalkenso" item only when the curriculum module has no status item for the active note. */
    updateFallbackStatusBar() {
        const el = this.fallbackStatusBarEl;
        if (!el) {
            return;
        }
        const file = this.app.workspace.getActiveFile();
        el.empty();
        if (this.curriculum?.showsStatusFor(file)) {
            setTooltip(el, '');
            return;
        }
        const inCurriculum = Boolean(this.curriculum?.unsyncedCurriculumContext(file));
        setIcon(el.createSpan({ cls: 'chalkenso-statusbar-icon' }), 'refresh-cw');
        el.createSpan({ text: `${this.store.general.devMode ? 'DEV · ' : ''}${inCurriculum ? 'Curriculum · not synced' : 'Chalkenso'}` });
        setTooltip(el, inCurriculum ? 'This note is not a synced lesson — click for actions' : 'Chalkenso actions');
    }

    /** The fallback menu: curriculum sections for the active file's folder, else the vault-wide ones. */
    openPluginMenu(evt) {
        const menu = new Menu();
        const file = this.app.workspace.getActiveFile();
        if (this.curriculum.unsyncedCurriculumContext(file)) {
            this.curriculum.buildNoteActions(menu, file, { global: true });
        }
        else {
            this.curriculum.addUpdatesSection(menu, null);
            this.curriculum.addAllCurriculaSection(menu);
            this.addPluginSection(menu);
        }
        menu.showAtMouseEvent(evt);
    }

    /** "Chalkenso" section closing every action menu: problems log and settings. */
    addPluginSection(menu) {
        addMenuSection(menu, 'Chalkenso');
        const problems = this.store.problems?.length ?? 0;
        menu.addItem((item) => item
            .setTitle(problems ? `Show recent sync problems (${problems})` : 'Show recent sync problems')
            .setIcon('alert-triangle')
            .onClick(() => this.openProblems()));
        menu.addItem((item) => item
            .setTitle('Settings')
            .setIcon('settings')
            .onClick(() => {
            this.app.setting?.open?.();
            this.app.setting?.openTabById?.(this.manifest.id);
        }));
    }

    onunload() {
        if (activeHost === this) {
            activeHost = null;
        }
        window.clearTimeout(this.explorerTimer);
        this.removeExplorerElements(EXPLORER_SELECTOR);
        this.curriculum?.onunload?.();
    }

    // ------------------------------------------------------------------------------------------
    // Settings storage: { general, curriculum, problems, seen }
    // ------------------------------------------------------------------------------------------

    async loadStore() {
        const data = (await this.loadData()) ?? {};
        // Only the settings this version has (anything else stored earlier is dropped on the next save).
        const general = Object.fromEntries(Object.entries(GENERAL_DEFAULTS).map(([key, value]) => [key, data.general && key in data.general ? data.general[key] : value]));
        general.connections = (Array.isArray(general.connections) ? general.connections : [])
            .filter((connection) => connection && typeof connection === 'object' && connection.id && (connection.env === 'prod' || connection.env === 'dev'));
        this.store = {
            general,
            curriculum: data.curriculum ?? {},
            problems: Array.isArray(data.problems) ? data.problems : [],
            /** Items (`ws:<versionId>`) already announced per server, so each is announced once. */
            seen: { prod: [], dev: [], ...(data.seen ?? {}) },
        };
    }

    // ------------------------------------------------------------------------------------------
    // Organisations: one connection per organisation and server (a sync token works in one)
    // ------------------------------------------------------------------------------------------

    activeEnv() {
        return this.store.general.devMode ? 'dev' : 'prod';
    }
    /** The organisations of the active server, in the order they were added. */
    activeConnections() {
        const env = this.activeEnv();
        return this.store.general.connections.filter((connection) => connection.env === env);
    }
    connectionById(id) {
        return id ? this.store.general.connections.find((connection) => connection.id === id) ?? null : null;
    }
    /** The organisation (active server) whose folder holds `path` (the innermost), or null. */
    connectionForPath(path) {
        const target = Curriculum.normalizeFolderPath(path ?? '');
        let best = null;
        for (const connection of this.activeConnections()) {
            const folder = Curriculum.normalizeFolderPath(connection.folder ?? '');
            if (folder && (target === folder || target.startsWith(`${folder}/`)) && (!best || folder.length > Curriculum.normalizeFolderPath(best.folder).length)) {
                best = connection;
            }
        }
        return best;
    }
    blankConnection(env, token) {
        return {
            id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            env,
            token,
            folder: null,
            curriculumsFolder: null,
            groupsFolder: null,
            organizationId: null,
            organizationName: null,
            userId: null,
        };
    }
    /**
     * Gives an organisation its folder in the root folder (`<root>/<Organisation>`, once its name is
     * known) with its Curriculums and Groups folders inside. A folder already inside the root folder
     * is kept (renamed folders are followed). True when anything changed; the caller saves.
     */
    placeConnection(connection, root = this.rootFolder()) {
        if (!root) {
            return false;
        }
        let changed = false;
        const insideRoot = (path) => path === root || String(path ?? '').startsWith(`${root}/`);
        if (!connection.folder || !insideRoot(connection.folder)) {
            if (!connection.organizationName) {
                return false; // named once its account loads
            }
            connection.folder = this.freeOrganizationFolder(`${root}/${Curriculum.sanitizeFolderName(connection.organizationName, 'Organisation')}`, connection);
            changed = true;
        }
        const inside = (path) => String(path ?? '').startsWith(`${connection.folder}/`);
        if (!inside(connection.curriculumsFolder)) {
            connection.curriculumsFolder = `${connection.folder}/Curriculums`;
            changed = true;
        }
        if (!inside(connection.groupsFolder)) {
            connection.groupsFolder = `${connection.folder}/Groups`;
            changed = true;
        }
        return changed;
    }
    placeConnections(root) {
        let changed = false;
        for (const connection of this.store.general.connections) {
            changed = this.placeConnection(connection, root) || changed;
        }
        return changed;
    }
    /** `path`, or `path (2)`, … when another organisation of the same server already uses it. */
    freeOrganizationFolder(base, connection) {
        const taken = (path) => this.store.general.connections.some((other) => other !== connection && other.env === connection.env && other.folder === path);
        let path = base;
        for (let n = 2; taken(path) && n < 100; n++) {
            path = `${base} (${n})`;
        }
        return path;
    }
    /**
     * Adds an organisation from a sync token: its account (`/me`) says which organisation the token
     * works in; one already connected is refused; it gets its folder `<root>/<Organisation>`.
     * Returns `{ connection }` or `{ error }`.
     */
    async addConnection(token) {
        const env = this.activeEnv();
        if (this.store.general.connections.some((connection) => connection.env === env && connection.token === token)) {
            return { error: 'that token is already added.' };
        }
        const connection = this.blankConnection(env, token);
        this.store.general.connections.push(connection);
        const me = await this.loadMe(connection.id, true);
        if (!me) {
            const error = this.currentMe(connection.id)?.error ?? 'could not load the account for that token.';
            this.store.general.connections = this.store.general.connections.filter((candidate) => candidate !== connection);
            this.meCache.delete(connection.id);
            await this.saveData(this.store);
            return { error };
        }
        await this.curriculum.saveSettings();
        return { connection };
    }
    /**
     * Replaces an organisation's token. The new one must work in the same organisation: a token of
     * another organisation is refused (add it as another organisation), so folders are never
     * compared with the wrong organisation's list. Returns `{}` or `{ error }`.
     */
    async replaceConnectionToken(connection, token) {
        let result;
        try {
            result = await this.fetchMe(connection.env, token);
        }
        catch (error) {
            return { error: error.message };
        }
        if (result.error) {
            return { error: result.error };
        }
        const organization = result.data.organization ?? null;
        if (organization && connection.organizationId && organization.id !== connection.organizationId) {
            return { error: `that token works in ${organization.name}, not ${connection.organizationName}. Add it as another organisation instead.` };
        }
        connection.token = token;
        this.meCache.delete(connection.id);
        await this.saveData(this.store);
        await this.loadMe(connection.id, true);
        return {};
    }
    /**
     * Removes an organisation (after confirming): its folders stop syncing and stay in the vault with
     * their notes; nothing is deleted in Chalkenso. Adding it again and ticking them reuses the folders.
     */
    async removeConnection(connection) {
        const mappings = this.curriculum.settings.folders.filter((mapping) => mapping.connection === connection.id);
        const confirmed = await confirmList(this.app, {
            title: `Remove ${connection.organizationName || 'this organisation'}?`,
            message: 'Its folders stop syncing. They and their notes stay in your vault, and nothing is deleted in Chalkenso. Add it again later and tick them: the same folders are used.',
            items: mappings.map((mapping) => mapping.path || '/'),
            confirmLabel: 'Remove',
        });
        if (!confirmed) {
            return false;
        }
        this.store.general.connections = this.store.general.connections.filter((candidate) => candidate !== connection);
        this.curriculum.settings.folders = this.curriculum.settings.folders.filter((mapping) => mapping.connection !== connection.id);
        this.meCache.delete(connection.id);
        await this.curriculum.saveSettings();
        return true;
    }
    // ------------------------------------------------------------------------------------------
    // Root folder + what to sync
    // ------------------------------------------------------------------------------------------

    /** The root folder, or null when none is chosen (then nothing syncs). */
    rootFolder() {
        const root = typeof this.store?.general.rootFolder === 'string' ? this.store.general.rootFolder.replace(/^\/+|\/+$/g, '') : '';
        return root || null;
    }
    /**
     * Chooses the root folder (null = none, nothing syncs). Each organisation's folder moves into it;
     * synced folders outside it stop syncing (their notes stay in the vault).
     */
    async setRootFolder(path) {
        this.store.general.rootFolder = path || null;
        this.placeConnections(path || null);
        await this.curriculum.saveSettings();
    }
    /**
     * Everything an organisation's account can sync, for the checkboxes: `{ key, type: 'curriculum' |
     * 'group', connection, label, detail, selected, path, lastSynced, readOnly, workspace, mapping }`.
     * Its folders for a version the server no longer lists are included (checked), so they can be
     * unchecked.
     */
    availableItems(connection, me) {
        const items = [];
        const listed = new Set();
        for (const workspace of Array.isArray(me?.workspaces) ? me.workspaces : []) {
            listed.add(workspace.id);
            const mapping = this.curriculum.mappingForWorkspace(workspace.id);
            const permissions = Array.isArray(workspace.permissions) ? workspace.permissions : [];
            const group = workspace.kind === 'group';
            items.push({
                key: `ws:${workspace.id}`,
                type: group ? 'group' : 'curriculum',
                connection,
                workspace,
                label: group
                    ? `${workspace.course?.title ?? 'Course'} – ${workspace.group?.name ?? workspace.label}`
                    : `${workspace.course?.title ?? 'Course'} – ${workspace.label}`,
                detail: [
                    workspace.status === 'PUBLISHED' ? 'published' : 'draft',
                    group && workspace.baseVersion?.label ? `from core ${workspace.baseVersion.label}` : null,
                    permissions.join(', ').toLowerCase() || null,
                ].filter(Boolean).join(' · '),
                readOnly: !permissions.includes('WRITE'),
                selected: Boolean(mapping),
                mapping,
                path: mapping?.path ?? null,
                lastSynced: mapping?.lastSynced ?? null,
            });
        }
        // Its curriculum folders of versions the server no longer lists for you: shown so they can be
        // unchecked. (Group folders are cleaned up instead.)
        const settings = this.curriculum.settings;
        for (const mapping of settings.folders) {
            if (mapping.connection !== connection.id || Curriculum.isManagedGroup(mapping) || !Curriculum.isInActiveEnv(settings, mapping)) {
                continue;
            }
            if (listed.has(Curriculum.activeVersionId(settings, mapping))) {
                continue;
            }
            items.push({
                key: `folder:${mapping.path}`,
                type: 'curriculum',
                connection,
                label: `${mapping.courseTitle ?? mapping.path}${mapping.versionLabel ? ` – ${mapping.versionLabel}` : ''}`,
                detail: 'not available to your account any more',
                readOnly: false,
                selected: true,
                mapping,
                path: mapping.path,
                lastSynced: mapping.lastSynced ?? null,
            });
        }
        return items;
    }
    /** The checkbox changes as `{ add: items, remove: items }`. */
    selectionChanges(items, draft) {
        const add = [];
        const remove = [];
        for (const item of items) {
            if (!draft.has(item.key) || draft.get(item.key) === item.selected) {
                continue;
            }
            (draft.get(item.key) ? add : remove).push(item);
        }
        return { add, remove };
    }
    /** Where a newly checked item's folder will be created (in its organisation's folder). */
    plannedPath(item) {
        return this.curriculum.freeGroupFolderPath(Curriculum.workspaceFolderPath(this.curriculum.settings, item.workspace, item.connection));
    }
    /**
     * Applies the checkboxes: unchecked folders stop syncing (after confirming; nothing is deleted),
     * checked ones get a folder in their organisation's folder and are downloaded right away. Local
     * notes are never uploaded here. Returns false when cancelled.
     */
    async applySelection({ add, remove }) {
        if (add.length === 0 && remove.length === 0) {
            return true;
        }
        await this.markSeen([...add, ...remove]);
        if (remove.length > 0) {
            const confirmed = await confirmList(this.app, {
                title: 'Stop syncing?',
                message: 'These folders stop syncing. They and their notes stay in your vault, and nothing is deleted in Chalkenso.',
                items: remove.map((item) => `${item.label} → ${item.path || '/'}`),
                confirmLabel: 'Stop syncing',
            });
            if (!confirmed) {
                return false;
            }
            for (const item of remove) {
                await this.curriculum.removeWorkspaceMapping(item.mapping);
            }
        }
        if (add.length === 0) {
            new Notice(`Chalkenso: stopped syncing ${remove.length} folder(s). They stay in your vault.`);
            return true;
        }
        const root = this.rootFolder();
        if (!root) {
            new Notice('Chalkenso: choose the root folder first (Settings → Chalkenso → Root folder).');
            return false;
        }
        await Curriculum.ensureFolderPath(this.app, root);
        const created = [];
        for (const item of add) {
            if (!item.workspace || !item.connection) {
                continue;
            }
            try {
                created.push(await this.curriculum.addWorkspaceFolder(item.workspace, item.connection));
            }
            catch (error) {
                new Notice(`Chalkenso: could not create the folder for ${item.label}: ${error.message}`);
            }
        }
        new Notice(`Chalkenso: added ${created.length} folder(s), downloading:\n${created.map((mapping) => mapping.path).join('\n')}`, 8000);
        for (const mapping of created) {
            await this.curriculum.runForMapping(mapping, 'download');
        }
        return true;
    }
    /** Remembers items as announced for the active server (see `noticeNewItems`). */
    async markSeen(items) {
        const env = this.activeEnv();
        const seen = new Set(this.store.seen[env] ?? []);
        const before = seen.size;
        for (const item of items) {
            seen.add(item.key);
        }
        if (seen.size !== before) {
            this.store.seen[env] = Array.from(seen);
            await this.saveData(this.store);
        }
    }
    /**
     * After an organisation's `/me` loaded: one notice for things that became available there since
     * last time (the first time: a pointer to settings), so a new group or course never goes unnoticed.
     */
    async noticeNewItems(me, connection) {
        const env = this.activeEnv();
        const seen = new Set(this.store.seen[env] ?? []);
        const items = this.availableItems(connection, me).filter((item) => !item.key.startsWith('folder:'));
        const fresh = items.filter((item) => !item.selected && !seen.has(item.key));
        if (fresh.length === 0) {
            return;
        }
        const first = seen.size === 0 && !this.curriculum.settings.folders.some((mapping) => mapping.env === env);
        this.store.seen[env] = [...seen, ...fresh.map((item) => item.key)];
        await this.saveData(this.store);
        const where = 'Settings → Chalkenso → What to sync';
        const organization = this.activeConnections().length > 1 ? ` in ${Curriculum.organizationLabel(connection)}` : '';
        new Notice(first
            ? `Chalkenso: choose what to keep in this vault under ${where} (${fresh.length} available${organization}).`
            : `Chalkenso: now available to you${organization}: ${fresh.map((item) => item.label).join(', ')}. Add it under ${where}.`, 15000);
    }

    // ------------------------------------------------------------------------------------------
    // File explorer: lesson status dots, folder tags, read-only locks
    // ------------------------------------------------------------------------------------------

    /** Repaints one file (and its folders) now, or everything shortly (coalesced). */
    refreshExplorer(only) {
        if (only) {
            const paths = [only.path];
            for (let parent = only.parent; parent && !parent.isRoot(); parent = parent.parent) {
                paths.push(parent.path);
            }
            this.paintExplorer(paths);
            return;
        }
        window.clearTimeout(this.explorerTimer);
        this.explorerTimer = window.setTimeout(() => this.paintExplorer(null), 50);
    }
    removeExplorerElements(selector) {
        for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
            leaf.view.containerEl?.querySelectorAll?.(selector).forEach((el) => el.remove());
        }
    }
    /** The explorer dot of a lesson note, or null. */
    noteDotState(file) {
        return this.curriculum?.dotState(file) ?? null;
    }
    paintExplorer(only) {
        if (!this.curriculum) {
            return;
        }
        try {
            for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
                const fileItems = leaf.view.fileItems;
                if (!fileItems) {
                    continue;
                }
                for (const path of only ?? Object.keys(fileItems)) {
                    const el = fileItems[path]?.selfEl;
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (!el || !file) {
                        continue;
                    }
                    if (file instanceof TFolder) {
                        this.paintFolderDot(el, file);
                        this.paintFolderTag(el, file);
                        this.curriculum.paintFolderLock(el, file);
                    }
                    else if (file instanceof TFile && file.extension === 'md') {
                        this.paintNoteDot(el, file);
                    }
                }
            }
        }
        catch (error) {
            console.debug('Chalkenso: could not paint the file explorer', error);
        }
    }
    /** The dot after a note's name: a real element, so it has its own tooltip (the title keeps one too). */
    paintNoteDot(el, file) {
        const state = this.noteDotState(file);
        let dot = el.querySelector(':scope > .chalkenso-dot');
        const titleEl = el.querySelector('.nav-file-title-content') ?? el;
        if (!state) {
            dot?.remove();
            setTooltip(titleEl, '');
            return;
        }
        if (!dot) {
            dot = el.createSpan({ cls: 'chalkenso-dot' });
        }
        dot.dataset.chalkensoStatus = state.status;
        dot.toggleClass('chalkenso-dot-published', Boolean(state.published));
        setTooltip(dot, state.tooltip, { placement: 'right' });
        setTooltip(titleEl, state.titleTooltip ?? '', { placement: 'right' });
    }
    /** A collapsed folder's roll-up dot: the most urgent state of the notes inside (CSS hides it when open). */
    paintFolderDot(el, folder) {
        const counts = {};
        let total = 0;
        Vault.recurseChildren(folder, (child) => {
            if (child instanceof TFile && child.extension === 'md') {
                const state = this.noteDotState(child);
                if (state) {
                    counts[state.status] = (counts[state.status] ?? 0) + 1;
                    total++;
                }
            }
        });
        const status = Curriculum.FOLDER_STATUS_ORDER.find((candidate) => counts[candidate]);
        let dot = el.querySelector(':scope > .chalkenso-dot');
        if (!status) {
            dot?.remove();
            return;
        }
        if (!dot) {
            dot = el.createSpan({ cls: 'chalkenso-dot chalkenso-folder-dot' });
        }
        dot.dataset.chalkensoStatus = status;
        setTooltip(dot, this.folderDotTooltip(status, counts, total), { placement: 'right' });
    }
    folderDotTooltip(status, counts, total) {
        const labels = Curriculum.STATUS_LABEL;
        if (status === 'disabled') {
            return labels[status];
        }
        const active = total - (counts.disabled ?? 0);
        const synced = counts.synced ?? 0;
        if (status === 'synced') {
            return `All ${active} note(s) synced`;
        }
        const parts = [`${synced} of ${active} note(s) synced`];
        for (const other of ['syncing', 'conflict', 'orphaned', 'readonly-edit', 'pending', 'not-synced']) {
            if (counts[other]) {
                parts.push(`${counts[other]} ${labels[other].toLowerCase()}`);
            }
        }
        return parts.join(' · ');
    }
    /**
     * What a folder is, for its tag: Chalkenso (the root folder), an organisation's folder, its
     * Curriculums or Groups folder, or a curriculum / group folder moved out of its container (null =
     * no tag). `key` picks the tag's colour in styles.css; `icon` is a Lucide icon name.
     */
    folderTag(folder) {
        const path = folder.path;
        const root = this.rootFolder();
        if (!root || !isInsideRootFolder(path)) {
            return null;
        }
        if (path === root) {
            return { key: 'root', icon: 'cloud', text: 'Chalkenso', tooltip: 'Root folder: everything Chalkenso keeps in this vault' };
        }
        for (const connection of this.activeConnections()) {
            const name = Curriculum.organizationLabel(connection);
            if (connection.folder && path === Curriculum.normalizeFolderPath(connection.folder)) {
                return { key: 'organization', icon: 'building-2', text: connection.organizationName || 'Organisation', tooltip: `${name}: its curriculums and groups (synced with its own token)` };
            }
            if (path === Curriculum.curriculumsRootOf(connection)) {
                return { key: 'curriculums', icon: 'graduation-cap', text: 'Curriculums', tooltip: `Curriculums of ${name}: one folder per course version` };
            }
            if (path === Curriculum.groupsRootOf(connection)) {
                return { key: 'groups', icon: 'users', text: 'Groups', tooltip: `Groups of ${name}: one folder per group curriculum` };
            }
        }
        const mapping = this.curriculum.getFolderMappingByExactPath(path);
        if (mapping) {
            // A curriculum folder moved out of its container still says what it is.
            const group = Curriculum.isManagedGroup(mapping);
            const connection = this.connectionById(mapping.connection);
            const container = group ? Curriculum.groupsRootOf(connection) : Curriculum.curriculumsRootOf(connection);
            if (!container || folder.parent?.path !== container) {
                return { key: group ? 'group' : 'curriculum', icon: group ? 'users' : 'graduation-cap', text: group ? 'Group' : 'Curriculum', tooltip: `${group ? 'Group curriculum' : 'Curriculum'}: ${mapping.courseTitle ?? ''}${mapping.versionLabel ? ` – ${mapping.versionLabel}` : ''}` };
            }
        }
        return null;
    }
    paintFolderTag(el, folder) {
        const tagInfo = this.folderTag(folder);
        let tag = el.querySelector(':scope > .chalkenso-folder-tag');
        if (!tagInfo) {
            tag?.remove();
            return;
        }
        if (!tag) {
            tag = el.createSpan({ cls: 'chalkenso-folder-tag' });
        }
        // Rebuilt only when the tag changes, so repainting the explorer doesn't churn the DOM.
        const signature = `${tagInfo.icon}|${tagInfo.text}`;
        if (tag.dataset.chalkensoTagSignature !== signature) {
            tag.empty();
            setIcon(tag.createSpan({ cls: 'chalkenso-folder-tag-icon' }), tagInfo.icon);
            tag.createSpan({ text: tagInfo.text });
            tag.dataset.chalkensoTagSignature = signature;
        }
        tag.dataset.chalkensoTag = tagInfo.key;
        setTooltip(tag, tagInfo.tooltip, { placement: 'right' });
    }

    // ------------------------------------------------------------------------------------------
    // Accounts: GET /api/sync/me per organisation (who its token signs in as, which organisation it
    // works in, and the workspaces it can reach)
    // ------------------------------------------------------------------------------------------

    /** Identifies an organisation's server + token, so a cached `/me` is only used for the one it came from. */
    meKey(connection) {
        const general = this.store.general;
        return `${connection.env}|${connection.env === 'dev' ? general.devBaseUrl : general.baseUrl}|${connection.token}`;
    }

    /** An organisation's cached `/me` result `{ data, error }` for its server + token, or null when not loaded. */
    currentMe(connectionId) {
        const connection = this.connectionById(connectionId);
        const me = connection ? this.meCache.get(connection.id) : null;
        return me && me.key === this.meKey(connection) ? me : null;
    }

    /** An organisation's workspaces from `/me`, or null when not loaded (or it failed). */
    currentWorkspaces(connectionId) {
        return this.currentMe(connectionId)?.data?.workspaces ?? null;
    }

    /** One `GET /api/sync/me` with a token: `{ data }` or `{ error, status }`. Throws when offline. */
    async fetchMe(env, token) {
        const general = this.store.general;
        const baseUrl = env === 'dev' ? general.devBaseUrl : general.baseUrl;
        if (!baseUrl) {
            return { data: null, error: 'Set the server URL first.' };
        }
        if (!token) {
            return { data: null, error: 'Paste the sync token (usr_…) first.' };
        }
        const response = await serverRequestUrl({
            url: `${baseUrl.replace(/\/+$/, '')}/api/sync/me`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status >= 400) {
            return { data: null, status: response.status, error: response.json?.error ?? `HTTP ${response.status}` };
        }
        const data = response.json;
        if (!data || !Array.isArray(data.workspaces)) {
            return { data: null, error: 'Unexpected response from /api/sync/me (is the server up to date?).' };
        }
        return { data, error: null };
    }

    /**
     * Copies who and where from `/me` onto the organisation (and gives it its folder once it has a
     * name). Servers that don't name the organisation yet leave it "Organisation". True when changed.
     */
    rememberOrganization(connection, data) {
        const fields = {
            organizationId: data.organization?.id ?? connection.organizationId ?? null,
            organizationName: data.organization?.name ?? connection.organizationName ?? 'Organisation',
            userId: data.user?.id ?? null,
        };
        let changed = false;
        for (const [key, value] of Object.entries(fields)) {
            if (connection[key] !== value) {
                connection[key] = value;
                changed = true;
            }
        }
        return this.placeConnection(connection) || changed;
    }

    /**
     * Loads an organisation's `/me` (cached per server + token unless `force`): `{ user: { id, name,
     * email, role }, organization: { id, name }, workspaces: [{ id, label, status, kind: 'core' |
     * 'group', course, group, baseVersion, permissions }] }`. A token that turns out to work in another
     * organisation than this one's is refused (its folders are never compared with that list), and so
     * is a second connection to the same organisation. On success that organisation's group folders
     * are reconciled and new workspaces announced. Failures are remembered (shown in settings); with
     * `notify`, an authorization failure also shows a notice. Returns the data, or null.
     */
    async loadMe(connectionId, force = false, { notify = false } = {}) {
        const connection = this.connectionById(connectionId);
        if (!connection) {
            return null;
        }
        const key = this.meKey(connection);
        const cached = this.currentMe(connection.id);
        if (cached && !force) {
            return cached.data;
        }
        const pending = this.mePending.get(connection.id);
        if (pending?.key === key) {
            return pending.promise;
        }
        const remember = (data, error) => {
            this.meCache.set(connection.id, { key, data, error });
            return data;
        };
        const promise = (async () => {
            try {
                const result = await this.fetchMe(connection.env, connection.token);
                if (result.error) {
                    if (notify && (result.status === 401 || result.status === 403)) {
                        new LoggedNotice(`Chalkenso: ${Curriculum.organizationLabel(connection)}: ${result.error}`);
                    }
                    return remember(null, result.error);
                }
                const data = result.data;
                const organization = data.organization ?? null;
                if (organization && connection.organizationId && organization.id !== connection.organizationId) {
                    return remember(null, `This token works in ${organization.name}, not ${connection.organizationName ?? 'this organisation'}. Paste a token made in ${connection.organizationName ?? 'it'}, or add it as another organisation.`);
                }
                const twin = organization && this.store.general.connections.find((other) => other !== connection && other.env === connection.env && other.organizationId === organization.id);
                if (twin) {
                    return remember(null, `${organization.name} is already connected.`);
                }
                if (this.rememberOrganization(connection, data)) {
                    await this.curriculum.saveSettings();
                }
                remember(data, null);
                // That organisation's group curricula no longer listed are cleaned up in the background
                // (it may ask first), which "Sync / Download all" waits for.
                try {
                    const groups = await this.curriculum.reconcileGroups(data, connection);
                    if (groups.gone.length > 0) {
                        const previous = this.curriculum.groupCleanup ?? Promise.resolve();
                        this.curriculum.groupCleanup = previous
                            .then(() => this.curriculum.removeGoneGroups(groups.gone))
                            .catch((error) => console.error('Chalkenso: group folder clean-up failed', error));
                    }
                }
                catch (error) {
                    console.error('Chalkenso: could not update group curriculum folders', error);
                }
                await this.noticeNewItems(data, connection).catch((error) => console.error('Chalkenso: could not announce new items', error));
                return data;
            }
            catch (error) {
                // Offline or unreachable: remembered for settings; syncing folders with a version still works.
                return remember(null, error.message);
            }
            finally {
                if (this.mePending.get(connection.id)?.key === key) {
                    this.mePending.delete(connection.id);
                }
            }
        })();
        this.mePending.set(connection.id, { key, promise });
        return promise;
    }

    /** Loads every organisation of the active server (in parallel); returns their data (null for failures). */
    async loadAllMe(force = false, options = {}) {
        return Promise.all(this.activeConnections().filter((connection) => connection.token).map((connection) => this.loadMe(connection.id, force, options)));
    }

    // ------------------------------------------------------------------------------------------
    // Problem log (persisted, newest first)
    // ------------------------------------------------------------------------------------------

    recordProblem(message) {
        const note = this.app.workspace.getActiveFile?.()?.path ?? null;
        this.store.problems.unshift({ at: new Date().toISOString(), message, note });
        this.store.problems.length = Math.min(this.store.problems.length, MAX_PROBLEMS);
        void this.saveData(this.store);
    }

    openProblems() {
        new ProblemsModal(this.app, this).open();
    }

    /** Renders the problem list into `containerEl` (used by the modal and the settings tab). */
    renderProblems(containerEl, rerender) {
        containerEl.empty();
        const problems = this.store.problems;
        if (problems.length === 0) {
            containerEl.createEl('p', { cls: 'setting-item-description', text: 'No problems recorded.' });
            return;
        }
        const list = containerEl.createDiv({ cls: 'chalkenso-problems' });
        for (const problem of problems) {
            const row = list.createDiv({ cls: 'chalkenso-problem' });
            row.createDiv({
                cls: 'chalkenso-problem-meta',
                text: `${new Date(problem.at).toLocaleString()}${problem.note ? ` · ${problem.note}` : ''}`,
            });
            row.createDiv({ cls: 'chalkenso-problem-message', text: problem.message });
        }
        new Setting(containerEl)
            .addButton((button) => button.setButtonText('Copy all').onClick(async () => {
            const text = problems
                .map((p) => `${p.at}${p.note ? ` [${p.note}]` : ''}\n${p.message}`)
                .join('\n\n');
            await navigator.clipboard.writeText(text);
            new ObsidianNotice('Chalkenso: problems copied to the clipboard.');
        }))
            .addButton((button) => button.setButtonText('Clear').setWarning().onClick(async () => {
            this.store.problems = [];
            await this.saveData(this.store);
            rerender();
        }));
    }

    /** A module's settings, with the shared values filled in (never the tokens: those are the host's, per organisation). */
    loadModuleData(scope) {
        const shared = Object.fromEntries(SHARED_KEYS.map((key) => [key, this.store.general[key]]));
        return { ...this.store[scope], ...shared };
    }

    async saveModuleData(scope, data) {
        const slice = { ...data };
        for (const key of SHARED_KEYS) {
            delete slice[key];
        }
        this.store[scope] = slice;
        await this.saveData(this.store);
    }

    /**
     * After the curriculum module loaded its settings, route its shared keys to the host's general
     * settings, so it always reads the URL / token / dev mode edited under Connection.
     */
    bindSharedSettings(module) {
        for (const key of SHARED_KEYS) {
            Object.defineProperty(module.settings, key, {
                configurable: true,
                enumerable: true,
                get: () => this.store.general[key],
                set: (value) => {
                    this.store.general[key] = value;
                },
            });
        }
    }

    /** Changes a general setting; the curriculum module re-applies it (dev-mode keys, status bar, explorer). */
    async updateGeneral(changes) {
        Object.assign(this.store.general, changes);
        await this.saveData(this.store);
        await this.curriculum.saveSettings();
    }

    /** A synced folder was renamed/moved inside Obsidian: rewrite the root folder, organisation folders, containers and matching mappings. */
    async followFolderMove(oldPath, newPath) {
        let changed = false;
        const moved = (path) => {
            const current = String(path ?? '').replace(/\/+$/, '');
            if (!current) {
                return null;
            }
            if (current === oldPath) {
                return newPath;
            }
            return current.startsWith(`${oldPath}/`) ? newPath + current.slice(oldPath.length) : null;
        };
        const root = moved(this.store.general.rootFolder);
        if (root !== null) {
            this.store.general.rootFolder = root;
            changed = true;
        }
        for (const connection of this.store.general.connections) {
            for (const key of ['folder', 'curriculumsFolder', 'groupsFolder']) {
                const next = moved(connection[key]);
                if (next !== null) {
                    connection[key] = next;
                    changed = true;
                }
            }
        }
        for (const mapping of this.curriculum.settings.folders ?? []) {
            const next = moved(mapping.path);
            if (next !== null) {
                mapping.path = next;
                changed = true;
            }
        }
        if (changed) {
            await this.curriculum.saveSettings();
            new Notice(`Chalkenso: updated synced folder "${oldPath}" → "${newPath}".`, 6000);
        }
    }
}

module.exports = ChalkensoPlugin;
