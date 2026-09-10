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

const ALLOWED_MINUTES = [0.5, 1, 30, 60, 720, 1440, 0];
const REGISTRY = 'https://registry.npmjs.org/';
const GITHUB_CACHE_TTL_MS = 60 * 60 * 1000;

let globalRootCache = null;
const githubCache = new Map();

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

/** DSH 家目录（DSH_HOME 或 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 自动发现检查对象：DSH 本体 + profile 直接依赖中的插件类包 + 手动追加（跳过本插件自身）。 */
function discoverPackages(extra) {
  const names = ['@deepseek-ai/dsh'];
  try {
    const profilePath = join(dshHome(), 'profiles', 'web', 'package.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const deps = profile && profile.dependencies ? Object.keys(profile.dependencies) : [];
    for (const key of deps) {
      // 不检查自身：包目录名是 dsh-update-check，npm 包名却是 dsh_check_updates，
      // 只比对其中一个会漏掉，导致自身一直出现在结果列表里。
      if (key === 'dsh-update-check' || key === 'dsh_check_updates') continue;
      // 覆盖官方 @deepseek-ai/* 与所有包名含 dsh 的插件（如 @anionex/dsh-vision-toolkit），避免包名/scope 变化后漏检
      if (key.startsWith('@deepseek-ai/') || /dsh/i.test(key)) {
        if (!names.includes(key)) names.push(key);
      }
    }
  } catch {
    // profile 不可读：仅查本体与手动追加
  }
  if (Array.isArray(extra)) {
    for (const nm of extra) {
      if (typeof nm === 'string' && nm && !names.includes(nm)) names.push(nm);
    }
  }
  return names;
}

/** 从 npm repository.url 解析 GitHub owner/repo（失败返回 null）。 */
function parseGithubRepo(repository) {
  try {
    const raw = typeof repository === 'string' ? repository : repository && repository.url;
    if (typeof raw !== 'string') return null;
    const m = raw.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    return m[1] + '/' + m[2];
  } catch {
    return null;
  }
}

/** 读取本机已装版本：profile node_modules → npm 全局根 → APPDATA 兜底。 */
function readLocalVersion(pkgName) {
  const segments = pkgName.split('/');
  const candidates = [];
  const home = dshHome();
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

/** 读 registry latest 版本与 repository 元数据（15s 超时）。 */
async function fetchLatestMeta(pkgName) {
  const url = REGISTRY + pkgName.replace('/', '%2F') + '/latest';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (res.status === 404) return { version: null, githubRepo: null, unpublished: true };
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (!data || typeof data.version !== 'string') throw new Error('no version in registry response');
    return { version: data.version, githubRepo: parseGithubRepo(data.repository) };
  } finally {
    clearTimeout(timer);
  }
}

/** 读 GitHub latest release 的 tag（15s 超时 + 1h 缓存；失败返回 null 不阻断）。 */
async function fetchGithubLatest(repo) {
  const cached = githubCache.get(repo);
  if (cached && Date.now() - cached.ts < GITHUB_CACHE_TTL_MS) return cached.tag;
  const url = 'https://api.github.com/repos/' + repo + '/releases/latest';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-update-check' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.tag_name !== 'string') return null;
    githubCache.set(repo, { tag: data.tag_name, ts: Date.now() });
    return data.tag_name;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 语义化版本比较（容忍 v 前缀、缺段与预发布后缀）：a>b 返回 1，相等 0，a<b 返回 -1。
 *
 * 先把预发布后缀（-rc.1 之类）切下来再解析数字段。早期实现直接对整串 split('.')
 * 后 map(Number)，Number('2-rc') 得到 NaN，又被 `|| 0` 吞成 0，于是 0.1.2-rc.1 与
 * 0.1.5-rc.1 被判为相等 —— DSH 本体因此长期误报 up-to-date。
 */
function semverCompare(a, b) {
  const parse = (v) => {
    const s = String(v).replace(/^v/i, '');
    const i = s.indexOf('-');
    return {
      nums: (i < 0 ? s : s.slice(0, i)).split('.').map((n) => Number(n) || 0),
      pre: i < 0 ? '' : s.slice(i + 1),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  // 主版本相同：正式版 > 预发布版
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na = /^\d+$/.test(sa[i]);
    const nb = /^\d+$/.test(sb[i]);
    if (na && nb) {
      const da = Number(sa[i]);
      const db = Number(sb[i]);
      if (da !== db) return da > db ? 1 : -1;
    } else if (na !== nb) {
      return na ? -1 : 1; // 数字段优先级低于字母段（semver §11）
    } else if (sa[i] !== sb[i]) {
      return sa[i] > sb[i] ? 1 : -1;
    }
  }
  return 0;
}

/** 收集版本表：自动发现 profile 插件；单包失败隔离为 unknown；GitHub release 超前 npm 时标记 upstream-new。 */
async function collectVersions(extra) {
  const names = discoverPackages(extra);
  const entries = [];
  for (const pkgName of names) {
    try {
      const meta = await fetchLatestMeta(pkgName);
      const latest = meta.version;
      const current = readLocalVersion(pkgName);
      const githubLatest = meta.githubRepo && !meta.unpublished ? await fetchGithubLatest(meta.githubRepo) : null;
      let status;
      if (meta.unpublished) {
        // npm registry 上不存在该包（未发布）——仍展示本机版本
        status = current === null || current === '' ? 'unknown' : 'unpublished';
      } else if (current === null || current === '') {
        status = 'unknown';
      } else if (githubLatest && semverCompare(githubLatest, latest) > 0) {
        // 上游 GitHub 已发新版但 npm 尚未发布——即使本机与 npm 一致也提示
        status = 'upstream-new';
      } else if (semverCompare(current, latest) < 0) {
        status = 'outdated';
      } else {
        status = 'up-to-date';
      }
      const entry = { name: pkgName, current, latest, status };
      if (meta.unpublished) entry.reason = '未发布到 npm registry';
      if (githubLatest && semverCompare(githubLatest, latest) > 0) entry.githubLatest = githubLatest;
      entries.push(entry);
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

