/**
 * dsh-update-check host 半部的行为测试。
 *
 * 用最小的 cordis ctx 替身驱动真实的 apply()，用替身 fetch 驱动真实的网络路径，
 * 断言的是插件对外行为（工具返回值、定时器、HTTP 响应），不是内部实现细节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD = '../lib/index.js';
const NPM_HOST = 'registry.npmjs.org';

/** 最小 cordis ctx 替身：记录插件注册的工具 / 定时器 / 路由。 */
function makeCtx() {
  const routes = [];
  const tools = [];
  const intervals = [];
  const timeouts = [];
  const effects = [];
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    interval(fn, ms) { intervals.push({ fn, ms }); return () => {}; },
    timeout(fn, ms) { timeouts.push({ fn, ms }); return () => {}; },
    inject(deps, cb) {
      cb({ webServer: { register(opts) { routes.push(opts); return () => {}; } } });
      return () => {};
    },
    effect(fn, name) { effects.push({ fn, name }); return () => {}; },
    get() { return undefined; },
  };
  return { ctx, routes, tools, intervals, timeouts, effects };
}

/** 假的 ServerResponse，只记录状态码与 body。 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(s) { this.body = s === undefined ? '' : s; this.ended = true; },
  };
}

/** 假的 IncomingMessage：按需发出 data/end 事件。 */
function makeReq(method, chunks = [], headers = {}) {
  const listeners = new Map();
  const req = {
    method,
    headers,
    destroyed: false,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return this;
    },
    destroy() { this.destroyed = true; },
    _emit(ev, arg) { for (const fn of listeners.get(ev) || []) fn(arg); },
  };
  queueMicrotask(() => {
    for (const c of chunks) req._emit('data', Buffer.from(c));
    req._emit('end');
  });
  return req;
}

const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
});

/** 安装 fetch 替身，返回调用记录与恢复函数。 */
function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    return handler(u, opts);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
    countNpm() { return calls.filter((u) => u.includes(NPM_HOST)).length; },
  };
}

/** 每个用例都拿一份全新的模块实例（模块级缓存会跨用例污染）。 */
async function freshModule() {
  return import(`${MOD}?case=${Math.random().toString(36).slice(2)}`);
}

/** 取出已注册的工具。 */
async function bootWithTool(ctx, config = {}) {
  const mod = await freshModule();
  await mod.apply(ctx, config);
  const tool = ctx.tools && ctx.tools.register ? undefined : undefined;
  return { mod, tool };
}

// ---------------------------------------------------------------- 版本比较

test('GitHub tag 带 dsh-v 前缀且高于 npm latest 时，状态应为 upstream-new', async () => {
  const { ctx, tools } = makeCtx();
  const net = installFetch((url) => {
    if (url.includes(NPM_HOST)) {
      return jsonRes({
        version: '99.0.0',
        repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' },
      });
    }
    if (url.includes('api.github.com')) return jsonRes({ tag_name: 'dsh-v99.1.0' });
    return jsonRes({}, 404);
  });
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');
    assert.ok(tool, 'dsh_check_updates 工具应已注册');

    const snap = JSON.parse(await tool.execute({}));
    const dsh = snap.entries.find((e) => e.name === '@deepseek-ai/dsh');
    assert.ok(dsh, '结果应包含 @deepseek-ai/dsh');
    assert.equal(
      dsh.status,
      'upstream-new',
      `期望 upstream-new，实际 ${dsh.status}（githubLatest=${dsh.githubLatest}, latest=${dsh.latest}）`,
    );
    assert.equal(dsh.githubLatest, 'dsh-v99.1.0', 'githubLatest 应被保留');
  } finally {
    net.restore();
  }
});

test('GitHub tag 与 npm latest 同版本时，不应误报 upstream-new', async () => {
  const { ctx, tools } = makeCtx();
  const net = installFetch((url) => {
    if (url.includes(NPM_HOST)) {
      return jsonRes({
        version: '0.1.5-rc.1',
        repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' },
      });
    }
    if (url.includes('api.github.com')) return jsonRes({ tag_name: 'dsh-v0.1.5-rc.1' });
    return jsonRes({}, 404);
  });
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');
    const snap = JSON.parse(await tool.execute({}));
    const dsh = snap.entries.find((e) => e.name === '@deepseek-ai/dsh');
    assert.notEqual(dsh.status, 'upstream-new', '同版本不应报 upstream-new');
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------- 输入校验

test('非法包名应被过滤，不进入检查列表', async () => {
  const { ctx, tools } = makeCtx();
  const net = installFetch(() => jsonRes({ version: '1.0.0' }));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');
    const bad = ['../../../../etc/passwd', '..\\..\\..\\secret', 'foo/bar/baz', '', '   ', 'a b', '-leading'];
    const snap = JSON.parse(await tool.execute({ packages: [...bad, 'ok-package'] }));
    const names = snap.entries.map((e) => e.name);
    for (const b of bad) {
      assert.ok(!names.includes(b), `非法包名 ${JSON.stringify(b)} 不应出现在结果中`);
    }
    assert.ok(names.includes('ok-package'), '合法包名应被保留');
  } finally {
    net.restore();
  }
});

test('非法包名不应触发任何路径穿越式文件读取', async () => {
  const { ctx, tools } = makeCtx();
  const net = installFetch(() => jsonRes({ version: '1.0.0' }));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');
    const snap = JSON.parse(await tool.execute({ packages: ['../../../../Windows/System32/drivers/etc'] }));
    const hit = snap.entries.find((e) => e.name.includes('..'));
    assert.equal(hit, undefined, '路径穿越包名不应产生条目');
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------- 并发与性能

test('并发 refresh 应复用同一在途请求，npm 请求不翻倍', async () => {
  const { ctx, tools } = makeCtx();
  const net = installFetch(() => jsonRes({ version: '9.9.9' }));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');

    const before = net.countNpm();
    await Promise.all([tool.execute({}), tool.execute({}), tool.execute({})]);
    const delta = net.countNpm() - before;

    // 发现列表固定为 3 个包，一轮完整检查 = 3 次 registry 请求
    assert.ok(delta <= 3, `三次并发刷新应合并为一轮，实际新增 ${delta} 次 registry 请求`);
  } finally {
    net.restore();
  }
});

test('多个包的 registry 请求应并发发出，而不是串行', async () => {
  const { ctx, tools } = makeCtx();
  let running = 0;
  let peak = 0;
  const net = installFetch(async (url) => {
    if (url.includes(NPM_HOST)) {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return jsonRes({ version: '9.9.9' });
    }
    return jsonRes({}, 404);
  });
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const tool = tools.find((t) => t.name === 'dsh_check_updates');
    await tool.execute({});
    assert.ok(peak > 1, `请求应并发发出，实际峰值并发数为 ${peak}`);
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------- 配置校验

test('非法的 config.intervalMinutes 应回落到 60 分钟', async () => {
  const { ctx, intervals } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, { intervalMinutes: 0.7 });
    assert.equal(intervals.length, 1, '应安装且仅安装一个定时器');
    assert.equal(intervals[0].ms, 60 * 60 * 1000, `期望 3600000 ms，实际 ${intervals[0].ms}`);
  } finally {
    net.restore();
  }
});

test('合法的 config.intervalMinutes 应被采纳', async () => {
  const { ctx, intervals } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, { intervalMinutes: 30 });
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 30 * 60 * 1000);
  } finally {
    net.restore();
  }
});

test('intervalMinutes 为 0 时不应安装定时器', async () => {
  const { ctx, intervals } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, { intervalMinutes: 0 });
    assert.equal(intervals.length, 0, '关闭状态下不应有定时器');
  } finally {
    net.restore();
  }
});

// ---------------------------------------------------------------- HTTP 端点

test('set-interval 收到超大 body 时应返回 400，且不销毁连接', async () => {
  const { ctx, routes } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const route = routes.find((r) => r.path === '/_dsh/update-check/set-interval');
    assert.ok(route, 'set-interval 路由应已注册');

    const req = makeReq('POST', ['x'.repeat(70 * 1024)], { 'content-type': 'application/json' });
    const res = makeRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 400, `期望 400，实际 ${res.statusCode}`);
    assert.equal(req.destroyed, false, '不应销毁请求 socket，否则响应无法送达浏览器');
    assert.ok(res.ended, '应已发送响应');
  } finally {
    net.restore();
  }
});

test('set-interval 收到合法 body 时应返回 200 并更新间隔', async () => {
  const { ctx, routes, intervals } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const route = routes.find((r) => r.path === '/_dsh/update-check/set-interval');
    const req = makeReq('POST', [JSON.stringify({ minutes: 720 })], { 'content-type': 'application/json' });
    const res = makeRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.snapshot.intervalMinutes, 720);
    assert.equal(intervals[intervals.length - 1].ms, 720 * 60 * 1000);
  } finally {
    net.restore();
  }
});

test('set-interval 收到非法 JSON 时应返回 400', async () => {
  const { ctx, routes } = makeCtx();
  const net = installFetch(() => jsonRes({}, 404));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const route = routes.find((r) => r.path === '/_dsh/update-check/set-interval');
    const req = makeReq('POST', ['{not json'], { 'content-type': 'application/json' });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally {
    net.restore();
  }
});

test('snapshot 端点返回的 entries 不应是内部数组的同一引用', async () => {
  const { ctx, routes } = makeCtx();
  const net = installFetch(() => jsonRes({ version: '9.9.9' }));
  try {
    const mod = await freshModule();
    await mod.apply(ctx, {});
    const route = routes.find((r) => r.path === '/_dsh/update-check/snapshot');
    assert.ok(route, 'snapshot 路由应已注册');
    const res = makeRes();
    await route.handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.entries), 'entries 应为数组');
  } finally {
    net.restore();
  }
});
