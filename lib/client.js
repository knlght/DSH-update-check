window.__ModuleLoader__.load({ id: "dsh_check_updates", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = apply;

/**
 * dsh-update-check 浏览器半部：Settings「更新检查」页面。
 * 数据经同源 HTTP 端点读取；样式引用 DSH 主题 token（--dsw-alias-*），明暗自适应。
 */
const react_1 = require("react");

const NS = 'update-check';
const CSS = '' +
  '.upck-root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:14px}' +
  '.upck-title{font-size:16px;font-weight:600;margin:0}' +
  '.upck-sub{color:var(--dsw-alias-label-secondary);font-size:12px}' +
  '.upck-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
  '.upck-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}' +
  '.upck-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}' +
  '.upck-btn:disabled{opacity:0.5;cursor:not-allowed}' +
  '.upck-select{padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}' +
  '.upck-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}' +
  '.upck-table{width:100%;border-collapse:collapse;font-size:13px}' +
  '.upck-table th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-weight:500}' +
  '.upck-table td{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
  '.upck-table tr:last-child td{border-bottom:none}' +
  '.upck-ok{color:var(--dsw-alias-state-success-primary)}' +
  '.upck-warn{color:var(--dsw-alias-state-warn-primary)}' +
  '.upck-muted{color:var(--dsw-alias-label-secondary)}' +
  '.upck-error{color:var(--dsw-alias-state-error-primary)}';

const INTERVAL_OPTIONS = [
  { label: '30 秒', value: 0.5 },
  { label: '1 分钟', value: 1 },
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '12 小时', value: 720 },
  { label: '24 小时', value: 1440 },
  { label: '关闭', value: 0 },
];

function formatTime(iso) {
  if (!iso) return '从未检查';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString();
  } catch (e) {
    return String(iso);
  }
}

function statusMeta(s) {
  if (s === 'up-to-date') return { text: '已是最新', cls: 'upck-ok' };
  if (s === 'outdated') return { text: '可更新', cls: 'upck-warn' };
  if (s === 'upstream-new') return { text: '上游新版未发布', cls: 'upck-warn' };
  if (s === 'unpublished') return { text: '未发布 npm', cls: 'upck-muted' };
  if (s === 'unknown') return { text: '未知', cls: 'upck-muted' };
  return { text: String(s || ''), cls: 'upck-muted' };
}

function cell(value) {
  return String(value === null || value === undefined || value === '' ? '—' : value);
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = 'http ' + res.status;
    try { const body = await res.json(); if (body && body.error) detail = body.error; } catch (e) { /* 保留 http 状态 */ }
    throw new Error(detail);
  }
  return res.json();
}

function UpdateCheckSection() {
  const [snapshot, setSnapshot] = react_1.useState(null);
  const [loading, setLoading] = react_1.useState(true);
  const [busy, setBusy] = react_1.useState(false);
  const [error, setError] = react_1.useState(null);

  async function loadSnapshot() {
    setLoading(true);
    try {
      setSnapshot(await apiGet('/_dsh/update-check/snapshot'));
      setError(null);
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await apiGet('/_dsh/update-check/refresh'));
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetInterval(event) {
    const minutes = Number((event && event.target) ? event.target.value : null);
    setError(null);
    try {
      const res = await fetch('/_dsh/update-check/set-interval', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      const body = await res.json();
      if (body && body.ok) {
        setSnapshot(body.snapshot);
      } else {
        setError(String((body && body.error) || '设置间隔失败'));
      }
    } catch (e) {
      setError(String((e && e.message) || e));
    }
  }

  react_1.useEffect(function () {
    loadSnapshot();
  }, []);

  const entries = (snapshot && Array.isArray(snapshot.entries)) ? snapshot.entries : [];
  const lastCheckedAt = (snapshot && snapshot.lastCheckedAt) ? snapshot.lastCheckedAt : null;
  const isEmpty = entries.length === 0;
  const intervalMinutes = (snapshot && typeof snapshot.intervalMinutes === 'number') ? snapshot.intervalMinutes : 60;

  react_1.useEffect(function () {
    if (intervalMinutes <= 0) return;
    const handle = window.setInterval(function () {
      apiGet('/_dsh/update-check/snapshot').then(function (snap) {
        setSnapshot(snap);
      }).catch(function (e) {
        setError(String((e && e.message) || e));
      });
    }, intervalMinutes * 60 * 1000 + 4000);
    return function () {
      window.clearInterval(handle);
    };
  }, [intervalMinutes]);

  const title = react_1.createElement('h3', { className: 'upck-title' }, '更新检查');
  const timeRow = react_1.createElement('div', { className: 'upck-sub' }, '上次检查：' + formatTime(lastCheckedAt));

  const optionEls = INTERVAL_OPTIONS.map(function (opt) {
    return react_1.createElement(
      'option',
      { key: 'interval-' + String(opt.value), value: String(opt.value) },
      opt.label
    );
  });
  const select = react_1.createElement(
    'select',
    { className: 'upck-select', value: String(intervalMinutes), onChange: handleSetInterval },
    optionEls
  );
  const intervalRow = react_1.createElement(
    'div',
    { className: 'upck-row' },
    react_1.createElement('span', null, '检查间隔：'),
    select,
    react_1.createElement('span', { className: 'upck-sub' }, '到期自动复查，结果静默更新')
  );

  const btn = react_1.createElement(
    'button',
    { className: 'upck-btn', onClick: handleRefresh, disabled: busy },
    busy ? '检查中…' : '立即检查'
  );
  const errLine = error
    ? react_1.createElement('div', { className: 'upck-error' }, '错误：' + error)
    : null;
  const actionRow = react_1.createElement('div', { className: 'upck-row' }, btn, errLine);

  let body;
  if (loading) {
    body = react_1.createElement('div', { className: 'upck-sub' }, '加载中…');
  } else if (isEmpty) {
    body = react_1.createElement('div', { className: 'upck-sub' }, '暂无检查结果，点击“立即检查”。');
  } else {
    const rows = entries.map(function (entry, idx) {
      const meta = statusMeta(entry && entry.status);
      const latestText = (entry && entry.githubLatest)
        ? cell(entry.latest) + ' / ' + cell(entry.githubLatest)
        : cell(entry && entry.latest);
      return react_1.createElement(
        'tr',
        { key: 'row-' + (entry && entry.name ? entry.name : idx) },
        react_1.createElement('td', null, cell(entry && entry.name)),
        react_1.createElement('td', { className: 'upck-muted' }, cell(entry && entry.current)),
        react_1.createElement('td', null, latestText),
        react_1.createElement('td', { className: meta.cls }, meta.text)
      );
    });
    body = react_1.createElement(
      'div',
      { className: 'upck-card' },
      react_1.createElement(
        'table',
        { className: 'upck-table' },
        react_1.createElement(
          'thead',
          null,
          react_1.createElement(
            'tr',
            null,
            react_1.createElement('th', null, '包名'),
            react_1.createElement('th', null, '当前'),
            react_1.createElement('th', null, '最新'),
            react_1.createElement('th', null, '状态')
          )
        ),
        react_1.createElement('tbody', null, rows)
      )
    );
  }

  return react_1.createElement(
    'div',
    { className: 'upck-root' },
    title,
    timeRow,
    intervalRow,
    actionRow,
    body
  );
}

function apply(ctx) {
  const slots = ctx.get('slots');
  if (slots === undefined) return;

  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-dsh-plugin', NS);
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  const offSlot = slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'dsh-update-check', order: 35, label: () => '更新检查' },
    () => react_1.createElement(UpdateCheckSection, null)
  ));

  ctx.effect(() => () => {
    // slots.inject 返回 disposer，必须调用——否则插件卸载 / 热重载后设置页会残留条目
    if (typeof offSlot === 'function') offSlot();
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  }, NS + ':css');
}

return module.exports; } });

