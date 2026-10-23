// The feedback loop through the vault: Pull feedback brings every piece of a lesson's feedback and its
// tasks, done included, into one note (Open, Improvement, Done); a ticked piece with a reply is sent
// as an answer; a plan under the "new" heading starts the lesson's improvement with the open
// feedback; a changed plan goes up; work started in the app is workable and says so; the notice says what
// happened. Runs the plugin (main.js) against the Obsidian stand-in and a fake
// /api/sync that keeps what it's sent.
// node tests/feedback.test.cjs   (in the plugin's folder)
const Module = require('node:module');
const path = require('node:path');
const mock = require('./obsidian-mock.cjs');

const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'obsidian' ? mock : originalLoad.call(this, request, ...rest); };
globalThis.window = globalThis;
globalThis.document = { querySelectorAll: () => [], body: mock.el() };
globalThis.navigator = { clipboard: { writeText: async () => {} } };

const ChalkensoPlugin = require(path.resolve(__dirname, '../main.js'));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };

const course = { id: 'c1', title: 'Web Development', slug: 'web' };
const core = { id: 'v1', kind: 'core', label: 'v3', status: 'PUBLISHED', course, permissions: ['READ', 'WRITE', 'DELETE', 'TASKS'] };
const lessonRef = (id, position, title) => ({ id, position, title, slug: `lesson-${id}` });
const L1 = lessonRef('l1', 1, 'Setup');
const L2 = lessonRef('l2', 2, 'Routes');
const lesson = (ref) => ({ ...ref, arcId: null, arcTitle: null, status: 'PUBLISHED', shortDescription: null, updatedAt: new Date().toISOString(), revision: 1, baseLessonId: null, assets: [], markdownContent: `Install the tools for ${ref.title}.` });
const comment = (id, ref, fields) => ({
  id, lesson: ref, selectedText: 'Install the tools', context: null, body: 'Which editor should I use?', proposerName: 'A learner · Evening group',
  adminResponse: null, adminRespondedAt: null, isInstructorNote: false, status: 'OPEN', createdAt: '2026-10-01T10:00:00.000Z', resolvedAt: null, taskIds: [], ...fields,
});
const task = (id, ref, fields) => ({
  id, title: `Lesson ${ref.position}: ${ref.title}`, description: null, aiNotes: null, plan: null, planUpdatedAt: null, status: 'IN_PROGRESS', aiReady: false, isBrief: false,
  proposerName: null, createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', lesson: ref, sourceComment: null, sourceComments: [], notes: [], workplace: null, completedAt: null, ...fields,
});

// What the fake Chalkenso has, and what the vault sent it.
const server = {
  feedback: [
    comment('c1', L1, {}),
    comment('c2', L1, { proposerName: 'Ana Novak', isInstructorNote: true, body: 'Ran long: show the editor first.' }),
    comment('c3', L1, { status: 'RESOLVED', adminResponse: 'Any editor works.', resolvedAt: '2026-10-03T10:00:00.000Z' }),
  ],
  tasks: [
    task('t-done', L1, { status: 'DONE', plan: 'Add the editor list.', completedAt: '2026-09-20T10:00:00.000Z' }),
    task('t-app', L2, { plan: 'Split the routes.', workplace: 'APP' }),
  ],
  sent: [],
};

globalThis.__requestUrl = async ({ url, method = 'GET', headers = {}, body }) => {
  const route = new URL(url).pathname;
  const json = body ? JSON.parse(body) : null;
  const reply = (status, payload) => ({ status, json: payload, text: JSON.stringify(payload), headers: {} });
  if (route === '/api/sync/me') return reply(200, { user: { id: 'u1', name: 'Maja' }, organization: { id: 'o1', name: 'Northwind Academy' }, workspaces: [core] });
  if (route === '/api/sync/curriculum') {
    return reply(200, { syncedAt: new Date().toISOString(), etag: '"v1"', version: { id: 'v1', label: 'v3', version: 1, status: 'PUBLISHED', course, group: null, baseVersion: null }, arcs: [], lessons: [lesson(L1), lesson(L2)] });
  }
  if (route === '/api/sync/tasks' && method === 'GET') return reply(200, { tasks: server.tasks, feedback: server.feedback });
  if (method !== 'GET') server.sent.push({ method, route, body: json, version: headers['X-Curriculum-Version-Id'] });
  const feedbackMatch = route.match(/^\/api\/sync\/feedback\/(.+)$/);
  if (feedbackMatch && method === 'PATCH') {
    const found = server.feedback.find((entry) => entry.id === feedbackMatch[1]);
    Object.assign(found, { status: 'RESOLVED', resolvedAt: '2026-10-21T10:00:00.000Z', adminResponse: json.reply || found.adminResponse });
    return reply(200, { feedback: { id: found.id, done: true, skipped: false } });
  }
  if (route === '/api/sync/improvements' && method === 'POST') {
    const used = server.feedback.filter((entry) => json.feedbackIds.includes(entry.id));
    used.forEach((entry) => { entry.taskIds = ['t-new']; });
    server.tasks.push(task('t-new', L1, { plan: json.plan, workplace: 'VAULT', sourceComments: used }));
    return reply(200, { task: { id: 't-new' } });
  }
  const taskMatch = route.match(/^\/api\/sync\/tasks\/(.+)$/);
  if (taskMatch && method === 'PATCH') {
    const found = server.tasks.find((entry) => entry.id === taskMatch[1]);
    found.workplace = 'VAULT';
    if (json.plan !== undefined) found.plan = json.plan;
    return reply(200, { task: { id: found.id } });
  }
  return reply(404, { error: 'Not found.' });
};
globalThis.__store = { general: { baseUrl: 'https://chalkenso.test', devMode: false, devBaseUrl: 'http://localhost:3100', rootFolder: 'Chalkenso', connections: [] }, curriculum: { folders: [], defaultStatus: 'DRAFT' }, problems: [], seen: { prod: [], dev: [] } };

/** The note's properties, read the way Obsidian's metadata cache would (the stand-in writes JSON). */
function frontmatterOf(content) {
  const match = String(content ?? '').match(/^---\n([\s\S]*?)\n?---\n/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

(async () => {
  const vault = new mock.Vault();
  const app = {
    vault,
    workspace: { on: () => ({}), onLayoutReady: () => {}, getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }), getLeavesOfType: () => [] },
    metadataCache: { getFileCache: (file) => ({ frontmatter: frontmatterOf(vault.contents.get(file.path)) }), on: () => ({}), getFirstLinkpathDest: () => null, fileToLinktext: (file) => file.basename },
    fileManager: { processFrontMatter: async () => {}, renameFile: async () => {}, trashFile: async () => {} },
  };
  const plugin = new ChalkensoPlugin(app, { id: 'chalkenso' });
  await plugin.onload();
  const { connection } = await plugin.addConnection('usr_T');
  const items = plugin.availableItems(connection, plugin.currentMe(connection.id).data);
  const mapping = await plugin.curriculum.addWorkspaceFolder(items.find((item) => item.workspace.id === 'v1').workspace, connection);
  await plugin.curriculum.downloadMapping(mapping);
  const noteOf = (name) => {
    const entry = Array.from(vault.contents.entries()).find(([notePath]) => notePath.startsWith(`${mapping.path}/_feedback/`) && notePath.includes(name));
    return entry ? { path: entry[0], content: entry[1] } : null;
  };
  const notices = () => globalThis.__notices ?? [];
  const pull = async () => { globalThis.__notices = []; await plugin.curriculum.pullFeedbackForMapping(mapping); return notices().join(' | '); };

  // 1. Everything comes down: open feedback with reply lines, a plan to start the improvement, the done record.
  let said = await pull();
  let setup = noteOf('Setup');
  check('a note for the lesson with feedback', Boolean(setup), [...vault.contents.keys()].join(', '));
  const text = setup?.content ?? '';
  check('open feedback, each with a checkbox and a reply line', text.includes('%%feedback:c1%%') && text.includes('%%feedback:c2%%') && (text.match(/^Reply:$/gm) ?? []).length === 2);
  check('an instructor note says so', text.includes('**Ana Novak · note**'));
  check('no improvement yet: a plan heading that starts one', text.includes('## Improvement') && text.includes('%%plan:new:'));
  check('done feedback and a done improvement, folded under Done', /## Done[\s\S]*\[!done\]- Lesson 1: Setup · done 2026-09-20[\s\S]*Any editor works\./.test(text) || /## Done[\s\S]*Any editor works\.[\s\S]*\[!done\]- Lesson 1: Setup/.test(text), text.slice(text.indexOf('## Done'), text.indexOf('## Done') + 400));
  check('done feedback is not open', !text.includes('%%feedback:c3%%'));
  check('the notice says what came down', said.includes('2 lesson(s): 3 open, 1 improvement(s), 2 done'), said);
  const routes = noteOf('Routes')?.content ?? '';
  check('work started in the app comes down workable, and says so', routes.includes('%%task:t-app%%') && routes.includes('%%plan:t-app:') && routes.includes('Split the routes.') && routes.includes('_Started in Chalkenso'), routes.slice(0, 900));
  server.sent = [];
  const routesNote = noteOf('Routes');
  await vault.modify({ path: routesNote.path }, routesNote.content.replace('Split the routes.', 'Split the routes, then name each one.'));
  await pull();
  const takenOver = server.sent.find((entry) => entry.route === '/api/sync/tasks/t-app');
  check('a plan from the vault takes it over', takenOver?.body.plan === 'Split the routes, then name each one.' && !noteOf('Routes').content.includes('_Started in Chalkenso'), JSON.stringify(server.sent));
  server.sent = [];

  // 2. Answer one (ticked, with a reply) and plan the other: both go up, and the note follows.
  const edited = text
    .replace(/- \[ \] (\*\*Ana Novak · note\*\* %%feedback:c2%%)([\s\S]*?)Reply:/, '- [x] $1$2Reply: Fixed in class.')
    .replace(/(#### Plan %%plan:new:[0-9a-f]*%%)/, '$1\n\nAdd a line about editors before the install.');
  await vault.modify({ path: setup.path }, edited);
  said = await pull();
  const answer = server.sent.find((entry) => entry.route === '/api/sync/feedback/c2');
  check('the ticked one is answered, with its reply', answer?.method === 'PATCH' && answer.body.status === 'RESOLVED' && answer.body.reply === 'Fixed in class.', JSON.stringify(answer));
  const started = server.sent.find((entry) => entry.route === '/api/sync/improvements');
  check('the plan starts the improvement with the open feedback left', started?.body.lessonId === 'l1' && started.body.plan === 'Add a line about editors before the install.' && JSON.stringify(started.body.feedbackIds) === '["c1"]' && started.version === 'v1', JSON.stringify(started));
  setup = noteOf('Setup');
  check('the improvement is in the note, with its plan', setup.content.includes('%%task:t-new%%') && setup.content.includes('%%plan:t-new:') && setup.content.includes('Add a line about editors before the install.') && !setup.content.includes('%%plan:new:'));
  check('nothing open left, the answer is under Done', setup.content.includes('_Nothing open') && /## Done[\s\S]*Fixed in class\./.test(setup.content));
  check('the notice says what went up', said.includes('1 answered') && said.includes('1 plan(s) sent'), said);

  // 3. A changed plan goes up; one that was not changed does not.
  server.sent = [];
  await vault.modify({ path: setup.path }, setup.content.replace('Add a line about editors before the install.', 'Add a line about editors, then the install.'));
  await pull();
  const changed = server.sent.filter((entry) => entry.route === '/api/sync/tasks/t-new');
  check('a changed plan is sent once', changed.length === 1 && changed[0].body.plan === 'Add a line about editors, then the install.' && changed[0].body.useFeedback === undefined, JSON.stringify(server.sent));
  server.sent = [];
  await pull();
  check('an unchanged plan is not sent again', server.sent.length === 0, JSON.stringify(server.sent));

  // 4. Finished in the app: it moves to Done on the next pull.
  Object.assign(server.tasks.find((entry) => entry.id === 't-new'), { status: 'DONE', completedAt: '2026-10-22T10:00:00.000Z' });
  await pull();
  setup = noteOf('Setup');
  check('finished in the app, it is under Done', !setup.content.includes('%%task:t-new%%') && /## Done[\s\S]*Lesson 1: Setup · done 2026-10-22/.test(setup.content));

  console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
