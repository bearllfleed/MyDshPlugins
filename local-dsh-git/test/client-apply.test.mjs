/**
 * Wiring test for the browser half.
 *
 * `client.js` cannot be imported (it is a ModuleLoader script that needs
 * `window`), so this test evaluates it against stubs, captures the factory,
 * runs `apply()` with a recording ctx and asserts the three UI surfaces were
 * registered exactly as `CONTRACT.md` requires. It also renders the two
 * registered header components once, which catches a broken `t()`/icon path.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8');

/** Minimal React shim: the panel is never rendered, only registered. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  memo: (component) => component,
};

/** A `window`/`document` pair good enough for module evaluation. */
function makeBrowser() {
  const listeners = [];
  const element = () => ({
    dataset: {},
    style: {},
    textContent: '',
    setAttribute() {},
    appendChild() {},
    removeChild() {},
  });
  const document = {
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: element,
    addEventListener: (name, fn) => listeners.push([name, fn]),
    removeEventListener() {},
    execCommand: () => false,
  };
  const store = new Map();
  const window = {
    __ModuleLoader__: { load: (definition) => { window.definition = definition; } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    addEventListener: (name, fn) => listeners.push([name, fn]),
    removeEventListener() {},
  };
  return { window, document, store };
}

/**
 * Evaluate `client.js` with the stubs and return the captured module.
 * @returns {{ name: string, inject: string[], apply: (ctx: object) => void }}
 */
function loadModule() {
  const { window, document } = makeBrowser();
  const evaluate = new Function(
    'window',
    'document',
    'navigator',
    'console',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    SOURCE,
  );
  evaluate(window, document, undefined, console, setTimeout, clearTimeout, setInterval, clearInterval);
  assert.ok(window.definition, 'client.js must call window.__ModuleLoader__.load');
  assert.equal(window.definition.id, '@local/dsh-git');
  const required = [];
  const module = window.definition.factory((id) => {
    required.push(id);
    if (id === 'react') return React;
    throw new Error(`client.js must not require "${id}"`);
  });
  assert.deepEqual(required, ['react'], 'only react may be required');
  return module;
}

/** Recording context; `inject` runs its callback synchronously. */
function makeContext(records) {
  const slots = {
    register(registration, component) {
      records.slots.push({ registration, component });
      return () => {};
    },
    inject(name, callback) {
      records.slotInjections.push(name);
      return callback();
    },
  };
  const tabs = {
    register(definition) {
      records.tabs.push(definition);
      return () => {};
    },
  };
  const effect = (callback, label) => {
    records.effects.push(label);
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  };
  const scope = {
    slots,
    sidebarRightTabs: tabs,
    effect,
    get: () => undefined,
    inject: (dependencies, callback) => {
      records.injections.push(dependencies);
      return callback(scope);
    },
  };
  return {
    slots,
    locale: {
      register(namespace, dictionaries) {
        records.locales.push({ namespace, dictionaries });
        return () => {};
      },
      bind: () => (key) => key,
      getLocale: () => 'zh',
      getSnapshot: () => 'zh',
      subscribe: () => () => {},
    },
    effect,
    inject: (dependencies, callback) => {
      records.injections.push(dependencies);
      return callback(scope);
    },
    get(name) {
      records.gets.push(name);
      if (name === 'sidebarRight') return { openTab: (id) => records.opened.push(id) };
      return undefined;
    },
  };
}

/** @returns {{ module: any, records: any }} */
function applyModule() {
  const module = loadModule();
  const records = {
    slots: [],
    slotInjections: [],
    tabs: [],
    effects: [],
    injections: [],
    locales: [],
    gets: [],
    opened: [],
  };
  module.apply(makeContext(records));
  return { module, records };
}

test('module shape matches the bundle contract', () => {
  const module = loadModule();
  assert.equal(module.name, '@local/dsh-git');
  assert.deepEqual(module.inject, ['slots', 'locale']);
  assert.equal(typeof module.apply, 'function');
});

test('registers the right-sidebar tab with a guide card', () => {
  const { records } = applyModule();
  assert.equal(records.tabs.length, 1, 'exactly one tab type');
  const tab = records.tabs[0];
  assert.equal(tab.id, 'dsh-git');
  assert.equal(tab.kind, 'dsh-git');
  assert.equal(typeof tab.title, 'function');
  assert.equal(tab.title(), 'Git');
  assert.ok(Array.isArray(tab.guide) && tab.guide.length === 1, 'one guide card');
  const card = tab.guide[0];
  assert.equal(card.order, 30, 'guide card sits after the context card (order 20)');
  assert.equal(typeof card.title, 'function');
  assert.equal(typeof card.description, 'function');
  assert.equal(typeof card.icon, 'function');
  assert.equal(card.title(), '源代码管理');
  assert.notEqual(card.description(), '', 'guide card needs a description');
});

test('registers the pane body and the pane title under the tab id', () => {
  const { records } = applyModule();
  const names = records.slots.map((entry) => entry.registration.name);
  assert.ok(names.includes('sidebar.right.pane.tab'), 'pane body slot');
  assert.ok(names.includes('sidebar.right.pane.tab.title'), 'pane title slot');
  for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    const entry = records.slots.find((candidate) => candidate.registration.name === name);
    assert.equal(entry.registration.key, 'dsh-git');
    assert.equal(typeof entry.component, 'function');
  }
  // The title component must render without a session or a mounted panel.
  const title = records.slots.find((entry) => entry.registration.name === 'sidebar.right.pane.tab.title').component;
  const rendered = title({});
  assert.equal(rendered.type, 'span');
  assert.equal(rendered.props.className, 'dg-tabtitle');
});

test('registers the conversation header button in the utilities slot', () => {
  const { records } = applyModule();
  const header = records.slots.find(
    (entry) => entry.registration.name === 'conversation.session.header.utilities',
  );
  assert.ok(header, 'header utilities registration');
  assert.equal(header.registration.id, 'dsh-git');
  assert.equal(header.registration.order, 10);
  assert.equal(typeof header.registration.label, 'function');
  const button = header.component({ sessionId: undefined });
  assert.equal(button.type, 'button');
  assert.equal(button.props.className, 'dg-headerbtn');
  assert.equal(typeof button.props.onClick, 'function');
  assert.equal(typeof button.props.title, 'string');
  assert.notEqual(button.props.title, '');
});

test('header button opens the git tab through the sidebar service', () => {
  const { records } = applyModule();
  const header = records.slots.find(
    (entry) => entry.registration.name === 'conversation.session.header.utilities',
  );
  header.component({}).props.onClick();
  assert.deepEqual(records.opened, ['dsh-git']);
});

test('registers zh and en dictionaries with identical key sets', () => {
  const { records } = applyModule();
  assert.equal(records.locales.length, 1);
  const [{ namespace, dictionaries }] = records.locales;
  assert.equal(namespace, 'dsh-git');
  const zh = Object.keys(dictionaries.zh);
  const en = Object.keys(dictionaries.en);
  assert.ok(zh.length > 150, `expected a full dictionary, got ${zh.length} keys`);
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh and en must cover the same keys');
  for (const key of zh) {
    assert.equal(typeof dictionaries.zh[key], 'string');
    assert.notEqual(dictionaries.zh[key], '', `zh.${key} must not be empty`);
    assert.notEqual(dictionaries.en[key], '', `en.${key} must not be empty`);
  }
  // Contract §8 keys must exist.
  for (const key of [
    'tab.title',
    'guide.title',
    'guide.description',
    'header.button',
    'action.commit',
    'branch.title',
    'history.title',
    'error.E_NOT_REPO',
    'error.E_AUTH_REQUIRED',
    'confirm.discard',
  ]) {
    assert.ok(zh.includes(key), `missing locale key ${key}`);
  }
});

test('locale files on disk match the embedded dictionaries', () => {
  const { records } = applyModule();
  const { dictionaries } = records.locales[0];
  for (const language of ['zh', 'en']) {
    const onDisk = JSON.parse(readFileSync(join(ROOT, 'locale', `${language}.json`), 'utf8'));
    assert.deepEqual(onDisk, dictionaries[language], `locale/${language}.json drifted from client.js`);
  }
});

test('works without the sidebar tab service', () => {
  const module = loadModule();
  const records = {
    slots: [],
    slotInjections: [],
    tabs: [],
    effects: [],
    injections: [],
    locales: [],
    gets: [],
    opened: [],
  };
  const ctx = makeContext(records);
  const slots = ctx.slots;
  ctx.inject = (dependencies, callback) =>
    callback({
      slots,
      sidebarRightTabs: undefined,
      effect: ctx.effect,
      get: () => undefined,
      inject: () => undefined,
    });
  module.apply(ctx);
  assert.equal(records.tabs.length, 0, 'no tab type without the service');
  const names = records.slots.map((entry) => entry.registration.name);
  assert.ok(names.includes('sidebar.right.pane.tab'), 'the fallback pane still renders');
  assert.ok(names.includes('conversation.session.header.utilities'), 'the header button survives');
});
