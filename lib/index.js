/**
 * dsh-update-check — DeepSeek Harness 更新检查插件（Host 半部）。
 *
 * 能力：对照 npm registry 检查 DSH 本体与 profile 插件的版本；模型工具
 * `dsh_check_updates` 实时查询；周期复查（间隔可配置）；`/_dsh/update-check/*`
 * 三个 HTTP 端点供浏览器 Settings 页消费。只报告，不执行升级。
 * @module dsh-update-check
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export const name = 'dsh-update-check';
export const inject = ['timer', 'tools'];

const BASE_PACKAGES = ['@deepseek-ai/dsh', '@dsh-external/dsh-vision-toolkit'];
const ALLOWED_MINUTES = [0.5, 1, 30, 60, 720, 1440, 0];
const REGISTRY = 'https://registry.npmjs.org/';

let globalRootCache = null;

/** npm 全局根（`npm prefix -g`），惰性缓存。 */
function globalRoot() {
  if (globalRootCache !== null) return globalRootCache;
  try {
    const out = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10000, windowsHide: true });
    globalRootCache = out.trim();
  } catch {
    globalRootCache = '';
  }
  return globalRootCache;
}

/** 读取本机已装版本：profile node_modules → npm 全局根 → APPDATA 兜底。 */
function readLocalVersion(pkgName) {
  const segments = pkgName.split('/');
  const candidates = [];
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  candidates.push(join(home, 'profiles', 'web', 'node_modules', ...segments, 'package.json'));
  const gRoot = globalRoot();
  if (gRoot) candidates.push(join(gRoot, 'node_modules', ...segments, 'package.json'));
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', ...segments, 'package.json'));
  for (const p of candidates) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data && typeof data.version === 'string' && data.version) return data.version;
    } catch {
      // 路径不存在或不可读：继续下一候选
    }
  }
  return null;
}

/** 读 registry dist-tags 的 latest（15s 超时）。 */
async function fetchLatest(pkgName) {
  const url = REGISTRY + pkgName.replace('/', '%2F') + '/latest';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (!data || typeof data.version !== 'string') throw new Error('no version in registry response');
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

/** 收集版本表：单包失败隔离为 unknown 条目。 */
async function collectVersions(extra) {
  const names = [...BASE_PACKAGES];
  if (Array.isArray(extra)) {
    for (const nm of extra) {
      if (typeof nm === 'string' && nm && !names.includes(nm)) names.push(nm);
    }
  }
  const entries = [];
  for (const pkgName of names) {
    try {
      const latest = await fetchLatest(pkgName);
      const current = readLocalVersion(pkgName);
      let status;
      if (current === null || current === '') status = 'unknown';
      else if (current === latest) status = 'up-to-date';
      else status = 'outdated';
      entries.push({ name: pkgName, current, latest, status });
    } catch (error) {
      entries.push({ name: pkgName, current: null, latest: null, status: 'unknown', reason: String((error && error.message) || error) });
    }
  }
  return entries;
}

/** 收集 POST 请求的 JSON body。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

/** Plugin 入口。 */
export async function apply(ctx, config = {}) {
  const state = {
    lastCheckedAt: null,
    entries: [],
    lastError: null,
    intervalMinutes: typeof config.intervalMinutes === 'number' ? config.intervalMinutes : 60,
  };
  let intervalDisposer = null;

  const snapshot = () => ({
    lastCheckedAt: state.lastCheckedAt,
    entries: state.entries,
    lastError: state.lastError,
    intervalMinutes: state.intervalMinutes,
  });

  async function refresh(extra) {
    try {
      const fresh = await collectVersions(extra);
      const allUnknown = fresh.length > 0 && fresh.every((e) => e.status === 'unknown');
      const anyCurrent = fresh.some((e) => e.current !== null && e.current !== '');
      if (allUnknown && !anyCurrent) {
        if (state.entries.length > 0) {
          state.lastError = '整体检查失败：全部条目 unknown（registry 不可达或服务异常），保留上次成功快照';
          return snapshot();
        }
        state.entries = fresh;
        state.lastCheckedAt = new Date().toISOString();
        state.lastError = '整体检查失败：全部条目 unknown；本机首次检查尚无快照';
        return snapshot();
      }
      state.entries = fresh;
      state.lastCheckedAt = new Date().toISOString();
      state.lastError = null;
    } catch (error) {
      state.lastError = String((error && error.message) || error);
    }
    return snapshot();
  }

  function armInterval(minutes) {
    if (intervalDisposer) {
      intervalDisposer();
      intervalDisposer = null;
    }
    if (minutes > 0) {
      intervalDisposer = ctx.interval(() => {
        refresh().catch(() => {});
      }, minutes * 60 * 1000);
    }
  }

  function setIntervalMinutes(minutes) {
    if (typeof minutes !== 'number' || Number.isNaN(minutes)) {
      return { ok: false, error: '间隔参数必须是数字', snapshot: snapshot() };
    }
    const allowed = ALLOWED_MINUTES.some((m) => Math.abs(m - minutes) < 1e-9);
    if (!allowed) {
      return { ok: false, error: '非法间隔值：仅支持 30 秒 / 1 分钟 / 30 分钟 / 1 小时 / 12 小时 / 24 小时 / 关闭', snapshot: snapshot() };
    }
    state.intervalMinutes = minutes;
    armInterval(minutes);
    return { ok: true, snapshot: snapshot() };
  }

  // 模型工具
  const disposeTool = ctx.tools.register(defineTool({
    name: 'dsh_check_updates',
    description: '检查 DSH 本体与 web profile 插件的 npm 版本（current vs latest），只报告不执行升级。',
    parameters: {
      packages: { type: 'array', items: { type: 'string' }, description: '额外要检查的 npm 包名（可选）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v }],
    },
    execute: async (args) => {
      const extra = args && args.packages ? args.packages : [];
      const snap = await refresh(extra);
      return JSON.stringify(snap, null, 2);
    },
  }));

  // 浏览器 HTTP 端点（可选：webServer 存在时挂载）
  ctx.inject(['webServer'], (webCtx) => {
    const json = (res, status, data) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
    };
    const disposeGet = webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/update-check/snapshot',
      handler: (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        json(res, 200, snapshot());
      },
    });
    const disposeRefresh = webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/update-check/refresh',
      handler: async (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        json(res, 200, await refresh());
      },
    });
    const disposeInterval = webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/update-check/set-interval',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        try {
          const body = await readJsonBody(req);
          const result = setIntervalMinutes(body.minutes);
          json(res, result.ok ? 200 : 400, result);
        } catch (e) {
          json(res, 400, { ok: false, error: String((e && e.message) || e), snapshot: snapshot() });
        }
      },
    });
    return () => {
      disposeGet();
      disposeRefresh();
      disposeInterval();
    };
  });

  // 启动 30s 首次检查 + 周期复查
  const disposeTimeout = ctx.timeout(() => {
    refresh().catch(() => {});
  }, 30000);
  armInterval(state.intervalMinutes);

  return () => {
    disposeTimeout();
    if (intervalDisposer) intervalDisposer();
    disposeTool();
  };
}

