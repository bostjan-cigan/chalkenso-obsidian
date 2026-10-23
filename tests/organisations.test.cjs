// The Obsidian plugin with several organisations, without Obsidian or a server: loads
// main.js against a stand-in for the Obsidian API (obsidian-mock.cjs) and a fake
// /api/sync, then checks that each organisation gets its own folder and token, groups are decided per
// organisation, a token of the wrong organisation is refused, and renames, root changes and removing
// an organisation behave. Settings from older versions are not carried over.
// node tests/organisations.test.cjs   (in the plugin's folder)
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

// The fake server: who each token is, and which organisation it works in.
const workspace = (id, kind, course, label, extra = {}) => ({ id, kind, label, status: 'PUBLISHED', course: { id: `c-${course}`, title: course }, permissions: ['READ', 'WRITE', 'DELETE', 'TASKS'], ...extra });
const ACCOUNTS = {
  usr_A: { user: { id: 'u1', name: 'Maja', email: 'maja@example.com', role: 'USER' }, organization: { id: 'orgA', name: 'Northwind Academy' },
    workspaces: [workspace('vA1', 'core', 'Web Dev', 'v1'), workspace('gA1', 'group', 'Web Dev', 'Summer', { group: { id: 'grA', name: 'Summer 2026' }, baseVersion: { label: 'v1' } })] },
  usr_A2: { user: { id: 'u1', name: 'Maja' }, organization: { id: 'orgA', name: 'Northwind Academy' }, workspaces: [] },
  usr_B: { user: { id: 'u1', name: 'Maja', email: 'maja@example.com', role: 'USER' }, organization: { id: 'orgB', name: 'SmartNinja School' },
    workspaces: [workspace('vB1', 'core', 'Python', 'v1'), workspace('gB1', 'group', 'Python', 'Autumn', { group: { id: 'grB', name: 'Autumn 2026' }, baseVersion: { label: 'v1' } })] },
};
const requests = [];
globalThis.__requestUrl = async ({ url, method = 'GET', headers = {} }) => {
  const token = String(headers.Authorization ?? '').replace(/^Bearer /, '');
  const route = new URL(url).pathname;
  requests.push({ route, token, version: headers['X-Curriculum-Version-Id'] ?? null, method });
  const reply = (status, json) => ({ status, json, text: JSON.stringify(json), headers: {} });
  if (route === '/api/sync/me') return ACCOUNTS[token] ? reply(200, ACCOUNTS[token]) : reply(401, { error: 'Invalid token.' });
  if (route === '/api/sync/curriculum') {
    const id = headers['X-Curriculum-Version-Id'];
    const known = Object.values(ACCOUNTS).flatMap((account) => account.workspaces).find((candidate) => candidate.id === id);
    return reply(200, { version: { id, label: known?.label ?? 'v1', course: { id: 'c', title: known?.course.title ?? 'Course' } }, arcs: [], lessons: [], syncedAt: new Date().toISOString() });
  }
  if (route === '/api/sync/tasks') return reply(200, { tasks: [] });
  return reply(404, { error: 'Not found.' });
};

// Settings from an older version (one token, folders without an organisation): not carried over.
globalThis.__store = {
  general: { baseUrl: 'https://chalkenso.test', devMode: false, devBaseUrl: 'http://localhost:3100', token: 'usr_OLD', devToken: '', rootFolder: 'Chalkenso' },
  curriculum: {
    folders: [{ path: 'Chalkenso/Curriculums/Web Dev – v1', env: 'prod', versionId: 'vA1', devVersionId: '', courseTitle: 'Web Dev', versionLabel: 'v1' }],
    curriculumsFolder: 'Chalkenso/Curriculums', groupsFolder: 'Chalkenso/Groups', defaultStatus: 'DRAFT', rootFolder: 'Chalkenso', token: 'usr_OLD',
  },
  problems: [], seen: { prod: [], dev: [] },
};

(async () => {
  const vault = new mock.Vault();
  vault.addFolder('Chalkenso/Curriculums/Web Dev – v1');
  const app = {
    vault,
    workspace: { on: () => ({}), onLayoutReady: () => {}, getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }), getLeavesOfType: () => [] },
    metadataCache: { getFileCache: () => null, on: () => ({}) },
    fileManager: { processFrontMatter: async () => {}, renameFile: async () => {}, trashFile: async () => {} },
  };
  const plugin = new ChalkensoPlugin(app, { id: 'chalkenso' });
  await plugin.onload();
  const general = plugin.store.general;
  const folders = () => plugin.curriculum.settings.folders;

  // 1. Older settings are not carried over: start with no organisation and nothing synced
  check('older settings start empty: no organisation, no synced folder', general.connections.length === 0 && folders().length === 0 && general.rootFolder === 'Chalkenso');
  await plugin.curriculum.saveSettings();
  check('and their token is gone from storage', !JSON.stringify(globalThis.__store).includes('usr_OLD'), JSON.stringify(globalThis.__store).slice(0, 160));

  // 2. Adding organisations: each gets its own folder with Curriculums and Groups
  const addedA = await plugin.addConnection('usr_A');
  const A = addedA.connection;
  check('an organisation is added with its token, named by its account', Boolean(A) && A.organizationId === 'orgA' && A.organizationName === 'Northwind Academy' && A.userId === 'u1', addedA.error ?? '');
  check('it gets its own folder with Curriculums and Groups', A.folder === 'Chalkenso/Northwind Academy' && A.curriculumsFolder === 'Chalkenso/Northwind Academy/Curriculums' && A.groupsFolder === 'Chalkenso/Northwind Academy/Groups', JSON.stringify(A));
  const addedB = await plugin.addConnection('usr_B');
  const B = addedB.connection;
  check('a second organisation is added', Boolean(B) && B.organizationName === 'SmartNinja School' && general.connections.length === 2, addedB.error ?? '');
  check('in a folder of its own', B.folder === 'Chalkenso/SmartNinja School' && B.groupsFolder === 'Chalkenso/SmartNinja School/Groups');

  // 3. What to sync, per organisation
  const itemsA = plugin.availableItems(A, plugin.currentMe(A.id).data);
  const itemsB = plugin.availableItems(B, plugin.currentMe(B.id).data);
  check("each organisation's list has only its own curriculums and groups", itemsA.map((item) => item.key).join() === 'ws:vA1,ws:gA1' && itemsB.map((item) => item.key).join() === 'ws:vB1,ws:gB1' && itemsB.every((item) => item.connection === B));
  check('new folders are planned in their organisation’s folder', plugin.plannedPath(itemsA[0]) === 'Chalkenso/Northwind Academy/Curriculums/Web Dev – v1' && plugin.plannedPath(itemsB[1]) === 'Chalkenso/SmartNinja School/Groups/Python – Autumn 2026', `${plugin.plannedPath(itemsA[0])} | ${plugin.plannedPath(itemsB[1])}`);
  const coreA = await plugin.curriculum.addWorkspaceFolder(itemsA[0].workspace, A);
  const groupA = await plugin.curriculum.addWorkspaceFolder(itemsA[1].workspace, A);
  const coreB = await plugin.curriculum.addWorkspaceFolder(itemsB[0].workspace, B);
  const groupB = await plugin.curriculum.addWorkspaceFolder(itemsB[1].workspace, B);
  check('its folders belong to it', [coreA, groupA].every((m) => m.connection === A.id) && [coreB, groupB].every((m) => m.connection === B.id) && groupB.path.startsWith(`${B.groupsFolder}/`));
  check("a group's README is written", Boolean(vault.getAbstractFileByPath(`${groupB.path}/README.md`)));

  // 4. Groups are per organisation: one organisation's list never removes another's
  const goneForB = await plugin.curriculum.reconcileGroups(plugin.currentMe(B.id).data, B);
  const goneForA = await plugin.curriculum.reconcileGroups(plugin.currentMe(A.id).data, A);
  check("one organisation's account never touches another's groups", goneForB.gone.length === 0 && goneForA.gone.length === 0 && plugin.curriculum.groupState(groupA) === null && plugin.curriculum.groupState(groupB) === null);

  // 5. Each folder's requests use its organisation's token
  requests.length = 0;
  await plugin.curriculum.runForMapping(coreB, 'download');
  await plugin.curriculum.runForMapping(coreA, 'download');
  const used = requests.filter((request) => request.route !== '/api/sync/me');
  const forB = used.filter((request) => request.version === 'vB1');
  const forA = used.filter((request) => request.version === 'vA1');
  check("a folder's requests use its own organisation's token", forB.length > 0 && forB.every((request) => request.token === 'usr_B') && forA.length > 0 && forA.every((request) => request.token === 'usr_A'), used.map((r) => `${r.route}:${r.version}:${r.token}`).join(' '));

  // 6. The wrong token for an organisation is refused
  const twin = await plugin.addConnection('usr_A2');
  check('a second token for the same organisation is refused', Boolean(twin.error) && /already connected/.test(twin.error) && general.connections.length === 2, twin.error);
  const swap = await plugin.replaceConnectionToken(A, 'usr_B');
  check("replacing a token with another organisation's is refused", Boolean(swap.error) && /SmartNinja School/.test(swap.error) && A.token === 'usr_A', swap.error);
  A.token = 'usr_B';
  const wrong = await plugin.loadMe(A.id, true);
  check('a token that works in another organisation loads nothing', wrong === null && /works in SmartNinja School/.test(plugin.currentMe(A.id).error));
  check('so its groups are never treated as gone', plugin.curriculum.groupState(groupA) === null);
  A.token = 'usr_A';
  await plugin.loadMe(A.id, true);
  const bad = await plugin.addConnection('usr_nope');
  check('an invalid token is not added', Boolean(bad.error) && general.connections.length === 2, bad.error);

  // 7. The settings screen draws (organisations, what to sync, dev mode)
  let drew = true;
  try {
    plugin.__tab.display();
    plugin.__tab.loadedMeThisOpen = true;
    plugin.__tab.display();
    general.devMode = true;
    plugin.__tab.display();
    general.devMode = false;
    plugin.__tab.hide();
  }
  catch (error) {
    drew = false;
    console.error(error);
  }
  check('the settings screen draws', drew);

  // 8. Explorer tags, and which organisation a folder is in
  const tag = (p) => plugin.folderTag(vault.getAbstractFileByPath(p))?.key ?? null;
  const tags = ['Chalkenso', 'Chalkenso/Northwind Academy', 'Chalkenso/Northwind Academy/Curriculums', 'Chalkenso/SmartNinja School/Groups'].map(tag);
  check('folder tags: root, organisation, its Curriculums and Groups', tags.join() === 'root,organization,curriculums,groups', tags.join());
  check("a folder in an organisation's folder belongs to it", plugin.connectionForPath('Chalkenso/SmartNinja School/Curriculums/Anything')?.id === B.id && plugin.connectionForPath('Chalkenso/Northwind Academy/Groups/X')?.id === A.id && plugin.connectionForPath('Chalkenso/Elsewhere') === null);

  // 9. Renaming an organisation's folder in Obsidian is followed
  await plugin.followFolderMove('Chalkenso/SmartNinja School', 'Chalkenso/SmartNinja');
  check('renaming its folder moves its settings along', B.folder === 'Chalkenso/SmartNinja' && B.groupsFolder === 'Chalkenso/SmartNinja/Groups' && coreB.path.startsWith('Chalkenso/SmartNinja/Curriculums/'), `${B.folder} ${coreB.path}`);

  // 10. Developer mode keeps the servers apart
  general.devMode = true;
  check('dev mode shows only dev organisations, and production folders rest', plugin.activeConnections().length === 0 && folders().every((mapping) => plugin.curriculum.mappingProblem(mapping) !== null));
  general.devMode = false;

  // 11. A new root folder moves each organisation's folder into it
  await plugin.setRootFolder('Courses');
  check('a new root folder holds each organisation', A.folder === 'Courses/Northwind Academy' && A.curriculumsFolder === 'Courses/Northwind Academy/Curriculums' && B.folder.startsWith('Courses/'), `${A.folder} ${B.folder}`);
  await plugin.setRootFolder('Chalkenso');

  // 12. Removing an organisation
  const removed = await plugin.removeConnection(B);
  check('removing an organisation stops its folders syncing', removed && general.connections.length === 1 && folders().every((mapping) => mapping.connection !== B.id) && folders().length === 2);

  // 13. What is stored
  const stored = globalThis.__store;
  check('tokens are stored once, with their organisation', stored.general.connections.length === 1 && stored.general.connections[0].token === 'usr_A' && !JSON.stringify(stored.curriculum).includes('usr_') && !('token' in stored.general));
  check('the module keeps only its own settings', Object.keys(stored.curriculum).sort().join() === 'defaultStatus,folders', Object.keys(stored.curriculum).join());

  console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
