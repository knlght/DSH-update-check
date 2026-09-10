/**
 * dsh-update-check 浏览器半部的测试。
 *
 * 与 shutdown 的 client 测试同构：造最小 window / document / react 替身取出
 * factory，验证 apply 的注册与卸载行为。当前覆盖 slot disposer 的清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function loadClient() {
  let factory = null;
  const styles = [];
  globalThis.window = {
    __ModuleLoader__: { load(def) { factory = def.factory; } },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  globalThis.document = {
    createElement() {
      return { attrs: {}, textContent: '', parentNode: null, setAttribute(k, v) { this.attrs[k] = v; } };
    },
    head: {
      appendChild(el) { el.parentNode = globalThis.document.head; styles.push(el); },
      removeChild(el) { el.parentNode = null; },
    },
  };
  return { getFactory: () => factory, styles };
}

async function boot() {
  const env = loadClient();
  await import(`../lib/client.js?case=${Math.random().toString(36).slice(2)}`);
  const factory = env.getFactory();
  assert.ok(factory, 'client.js 应通过 ModuleLoader 注册 factory');
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
  };
  const mod = factory((name) => {
    if (name === 'react') return react;
    throw new Error('未预期的 require: ' + name);
  });
  return { env, mod };
}

function makeSlots() {
  const registrations = [];
  let injectDisposerCalls = 0;
  const slots = {
    inject(key, cb) { registrations.push({ key, entry: cb() }); return () => { injectDisposerCalls += 1; }; },
    register(opts, render) { return { opts, render }; },
  };
  return { slots, registrations, getInjectDisposerCalls: () => injectDisposerCalls };
}

function makeCtx(slots) {
  const effects = [];
  return {
    ctx: {
      get(name) { return name === 'slots' ? slots : undefined; },
      effect(fn) { const cleanup = fn(); effects.push(cleanup); return () => {}; },
    },
    effects,
  };
}

test('apply 应向 settings.section 注册一个条目', async () => {
  const { mod } = await boot();
  const { slots, registrations } = makeSlots();
  const { ctx } = makeCtx(slots);

  mod.apply(ctx);

  assert.equal(registrations.length, 1, '应恰好注入一个 slot');
  assert.equal(registrations[0].key, 'settings.section');
  assert.equal(registrations[0].entry.opts.id, 'dsh-update-check');
});

test('插件卸载时应撤销 slots.inject 返回的 disposer', async () => {
  const { mod } = await boot();
  const { slots, getInjectDisposerCalls } = makeSlots();
  const { ctx, effects } = makeCtx(slots);

  mod.apply(ctx);
  assert.equal(getInjectDisposerCalls(), 0, '挂载阶段不应立即撤销');

  assert.equal(effects.length, 1, '应注册一个清理 effect');
  effects[0]();

  assert.equal(getInjectDisposerCalls(), 1, '卸载时必须调用 slots.inject 的 disposer，否则设置页会残留条目');
});

test('卸载时应移除注入的样式元素', async () => {
  const { mod, env } = await boot();
  const { slots } = makeSlots();
  const { ctx, effects } = makeCtx(slots);

  mod.apply(ctx);
  assert.equal(env.styles.length, 1, '应注入一份样式');
  effects[0]();
  assert.equal(env.styles[0].parentNode, null, '卸载后样式应已从 head 移除');
});

test('slots 服务不存在时 apply 不应抛错', async () => {
  const { mod } = await boot();
  const ctx = { get() { return undefined; }, effect() { return () => {}; } };
  assert.doesNotThrow(() => mod.apply(ctx));
});
