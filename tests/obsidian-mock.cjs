// A stand-in for the Obsidian API: enough for the plugin to load and run its folder, account and
// settings logic in Node (elements are callable proxies that accept anything; modals confirm unless
// `globalThis.__confirm === false`; `requestUrl` calls `globalThis.__requestUrl`).
function el() {
  const props = { dataset: {}, style: {}, children: [] };
  let proxy;
  const fn = function () {};
  proxy = new Proxy(fn, {
    get(_t, key) {
      if (key in props) return props[key];
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'isShown') return () => false;
      if (key === 'querySelector') return () => null;
      if (key === 'querySelectorAll') return () => [];
      // Anything else is another fake element: callable (returning itself) and with properties.
      return el();
    },
    set(_t, key, value) { props[key] = value; return true; },
    apply() { return proxy; },
  });
  return proxy;
}
class TAbstractFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); } }
class TFolder extends TAbstractFile { constructor(path) { super(path); this.children = []; } isRoot() { return this.path === '/' || this.path === ''; } }
class TFile extends TAbstractFile {
  constructor(path) { super(path); const dot = this.name.lastIndexOf('.'); this.extension = dot >= 0 ? this.name.slice(dot + 1) : ''; this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name; this.stat = { mtime: Date.now(), size: 0 }; }
}
class Vault {
  constructor() { this.files = new Map(); this.contents = new Map(); this.addFolder(''); }
  parentOf(path) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0, i) : ''; }
  addFolder(path) {
    if (this.files.has(path)) return this.files.get(path);
    const folder = new TFolder(path);
    this.files.set(path, folder);
    if (path) { const parent = this.addFolder(this.parentOf(path)); parent.children.push(folder); folder.parent = parent; }
    return folder;
  }
  getAbstractFileByPath(path) { return this.files.get(path) ?? null; }
  async createFolder(path) { if (this.files.has(path)) throw new Error('Folder already exists.'); return this.addFolder(path); }
  async create(path, content) {
    if (this.files.has(path)) throw new Error('File already exists.');
    const file = new TFile(path); const parent = this.addFolder(this.parentOf(path)); parent.children.push(file); file.parent = parent;
    this.files.set(path, file); this.contents.set(path, content); return file;
  }
  async read(file) { return this.contents.get(file.path) ?? ''; }
  async cachedRead(file) { return this.read(file); }
  async modify(file, content) { this.contents.set(file.path, content); }
  getFiles() { return [...this.files.values()].filter((f) => f instanceof TFile); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === 'md'); }
  async trash(file) { this.files.delete(file.path); this.contents.delete(file.path); const parent = this.files.get(this.parentOf(file.path)); if (parent) parent.children = parent.children.filter((child) => child !== file); }
  getAllLoadedFiles() { return [...this.files.values()]; }
  on() { return {}; }
}
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return globalThis.__store ? JSON.parse(JSON.stringify(globalThis.__store)) : null; }
  async saveData(data) { globalThis.__store = JSON.parse(JSON.stringify(data)); }
  addSettingTab(tab) { this.__tab = tab; } registerEvent() {} addCommand() {} register() {} registerDomEvent() {} registerInterval() {}
  addStatusBarItem() { return el(); }
  addRibbonIcon() { return el(); }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = el(); this.titleEl = el(); }
  open() { if (typeof this.resolve === 'function') { this.confirmed = globalThis.__confirm !== false; this.onClose?.(); } }
  close() { this.onClose?.(); }
}
class Notice { constructor(message) { (globalThis.__notices ??= []).push(String(message)); } setMessage() { return this; } hide() {} }
class Setting { constructor() { return el(); } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = el(); } }
class FuzzySuggestModal extends Modal {}
class AbstractInputSuggest { constructor() {} }
class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} }
module.exports = {
  AbstractInputSuggest, FuzzySuggestModal, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, Vault,
  normalizePath: (path) => String(path).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
  requestUrl: (params) => globalThis.__requestUrl(params),
  setIcon() {}, setTooltip() {}, stringifyYaml: (value) => JSON.stringify(value),
  el,
};
