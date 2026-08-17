# dsh-update-check

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">让 DSH 拥有版本可见性</b><br /><br />
  <code>dsh_check_updates</code> 模型工具 · Settings 更新检查页 · 周期自动复查<br /><br />
  <b>只报告，不执行升级</b>——升级决策永远掌握在用户手里。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

## ✨ 功能一览

- **🔍 版本检查**：对照 npm registry dist-tags，检查 DeepSeek Harness 本体（`@deepseek-ai/dsh`）与 profile 已装插件（如 `@anionex/dsh-vision-toolkit`）的当前版本与最新版本
- **🤖 模型工具** `dsh_check_updates`：agent 可在任意会话主动查询版本状态（支持传入额外包名）
- **🖥️ Settings 页面**：侧栏新增「更新检查」页——版本表格（包名/当前/最新/状态）、上次检查时间、「立即检查」按钮
- **⏰ 周期复查**：间隔可调（30 秒 / 1 分钟 / 30 分钟 / 1 小时 / 12 小时 / 24 小时 / 关闭），默认 1 小时；启动 30 秒后自动首查
- **🛡️ 失败保护**：registry 不可达时保留上次成功快照并记录错误；单包失败隔离为 unknown 条目，不影响其余包
- **🎨 原生风格**：UI 全部引用 DSH 主题 token（`--dsw-alias-*`），明暗主题自适应

## 📦 安装

```bash
dsh plugin --profile web add <本仓库 / npm 包名>
# 重启 dsh web 生效
```

## 🧠 设计要点

- 本机版本读取：profile node_modules → npm 全局根（`npm prefix -g`）逐级探测，无硬编码路径
- registry 查询：Node 原生 fetch（15 秒超时）
- 浏览器端点：`/_dsh/update-check/snapshot`（GET 快照）、`/_dsh/update-check/refresh`（GET 复查）、`/_dsh/update-check/set-interval`（POST 设间隔）
- 检查范围默认仅 DSH 本体 + profile 内已装插件；工具参数可临时扩展

## 🧩 生态

打上 <a href="https://github.com/topics/dsh-update-check"><code>dsh-update-check</code></a> topic 的插件可接入同一生态。欢迎通过 PR 改进本插件。

## 📄 许可

[MIT](./LICENSE)
