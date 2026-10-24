# dsh-quick-prompts ⚡ 快捷提示词收藏夹

[![Test](https://github.com/hezhaochao/dsh-quick-prompts/actions/workflows/test.yml/badge.svg)](./actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.0--rc.1-4d93f8)](https://github.com/deepseek-ai)

一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai)插件：在输入框旁放一个「⚡ 快捷语」按钮，
点开就能把你常用的提示词一键填进输入框。纯浏览器端实现，**零依赖、零网络请求、零 token 消耗**。

## 功能

- ⚡ 输入框右侧工具行一个不占地方的小按钮，点开常用提示词列表
- 📋 点某一条 → 内容**追加**进聊天输入框（自动补换行，不覆盖你已输入的内容）
- 🧷 找不到输入框时自动**回退为复制到剪贴板**，也可在弹层底部把使用方式切成「复制」
- ✏️ 新建 / 编辑 / 删除收藏，默认内置 5 条常用提示词（翻译、总结、解释代码、润色、起标题）
- 💾 数据只存浏览器 localStorage（`dsh-quick-prompts:v1`），完全本地，可随意备份

## 安装

### 方式一：DSH 插件面板（桌面版）

打开 DeepSeek Harness 的插件管理面板，搜索 `dsh-quick-prompts` 或从 GitHub 安装：

```bash
dsh plugin --profile <你的 profile> add github:hezhaochao/dsh-quick-prompts
```

### 方式二：命令行

```bash
# 从 GitHub 安装
dsh plugin --profile desktop add github:hezhaochao/dsh-quick-prompts

# 或本地 link（克隆本仓库后）
dsh plugin --profile desktop add link:"<本仓库的绝对路径>"
```

### 卸载

```bash
dsh plugin --profile <你的 profile> remove dsh-quick-prompts
```

> 安装 / 卸载后重启 DSH 生效。`desktop` profile 请通过桌面端的插件面板管理。

## 使用

1. 重启后输入框右侧出现「⚡ 快捷语」按钮
2. 点击按钮弹出提示词列表，再点某一条即填入输入框
3. 鼠标悬停在条目上可 ✎ 编辑 / ✕ 删除；底部「＋ 新建」添加自己的提示词
4. 底部左侧可切换使用方式：**直接填入输入框** / **复制到剪贴板**
5. `Esc`、点击弹层外或滚动页面可关闭弹层

## 工作原理

沿用了 DSH 插件生态的标准形态，两个半边：

| 半边 | 文件 | 作用 |
|---|---|---|
| 宿主侧 | `lib/index.js` | cordis 插件入口，零依赖零服务，只做客户端产物静态审计（绝不抛错） |
| 浏览器侧 | `lib/client.js` | `__ModuleLoader__` 模块，往 `conversation.input.right` 插槽注册按钮组件 |

- `cordis.patch.yml` 声明 bundle patch，把本包挂进 DSH 配置树（`- insert: id: quick-prompts`）
- 弹层通过 React portal 挂到 `body`，避免被输入区裁剪
- 往 `<textarea>` 写入走「原生 value setter + `input` 事件」，让 React 正确感知；
  contenteditable 输入走 `execCommand("insertText")`
- 任何一步失败都只降级（复制 / 提示），绝不影响宿主输入区 —— fail-open

## 开发与测试

```bash
git clone https://github.com/hezhaochao/dsh-quick-prompts.git
cd dsh-quick-prompts
node test/client.test.mjs   # 离线单测（vm 沙箱加载 bundle，无需浏览器/DSH）
npm test                    # 同上
```

本地真机验证（不影响现有 profile）：

```bash
dsh plugin --profile zz-test add link:"<本仓库的绝对路径>"
dsh --profile zz-test --dump-config   # 应能看到 id: quick-prompts 条目
```

## 已知限制

- 「直接填入」依赖能在页面里找到可见的聊天输入框；DSH 大版本更新若改了输入框结构，
  插件会自动回退为复制到剪贴板，不会坏
- 填入是**追加**语义：会接在你已输入内容的后面（自动补换行）
- 数据在浏览器 localStorage 里，清除浏览器数据 / 重装会丢（导出备份功能规划中）

## 许可

[MIT](./LICENSE) © hezhaochao
