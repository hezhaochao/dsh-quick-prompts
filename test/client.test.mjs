/**
 * dsh-quick-prompts 的离线测试。
 *
 * client.js 是给浏览器模块加载器用的 bundle，本测试在 Node 里用 vm 沙箱执行它：
 * 捕获 window.__ModuleLoader__.load 的注册参数，用桩模块替身调用工厂，
 * 然后对导出的纯函数做断言。不需要浏览器，也不需要 DSH 宿主。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENT_SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** 在沙箱里加载 client bundle，返回 { id, exports }。 */
function loadClient() {
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          sandbox.__loaded = def;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: "client.js" });

  const def = sandbox.__loaded;
  assert.ok(def, "模块加载器没有收到插件注册");
  assert.equal(def.id, PKG.name, "bundle id 必须与 package.json 的 name 一致");

  const React = { createElement: () => ({}), Fragment: "fragment" };
  const ReactDOM = { createPortal: (node) => node };
  const requireShim = (name) => {
    if (name === "react") return React;
    if (name === "react-dom") return ReactDOM;
    throw new Error(`工厂请求了意外的模块: ${name}`);
  };

  const exports = def.factory(requireShim);
  return { id: def.id, exports };
}

test("bundle 形状：导出 apply / inject / __internals", () => {
  const { exports } = loadClient();
  assert.equal(typeof exports.apply, "function");
  assert.ok(Array.isArray(exports.inject), "inject 应是服务名数组");
  assert.ok(exports.inject.includes("slots"));
  assert.equal(typeof exports.__internals, "object");
  assert.equal(typeof exports.__internals.buildAppendedText, "function");
  assert.equal(typeof exports.__internals.normalizeStorage, "function");
});

test("bundle 静态检查：与宿主半边的审计标志一致", () => {
  assert.ok(CLIENT_SRC.includes(`id: "${PKG.name}"`));
  assert.ok(CLIENT_SRC.includes("__ModuleLoader__.load"));
  assert.ok(CLIENT_SRC.includes("return module.exports"));
  assert.ok(CLIENT_SRC.includes("conversation.input.right"));
  assert.match(CLIENT_SRC, /exports\.apply\s*=/);
});

test("buildAppendedText：空内容直填、非空补换行、已有换行不重复", () => {
  const { buildAppendedText } = loadClient().exports.__internals;
  assert.equal(buildAppendedText("", "abc"), "abc");
  assert.equal(buildAppendedText(null, "abc"), "abc");
  assert.equal(buildAppendedText("你好", "abc"), "你好\nabc");
  assert.equal(buildAppendedText("你好\n", "abc"), "你好\nabc");
  assert.equal(buildAppendedText("你好", ""), "你好");
});

test("previewOf：压掉换行并按长度截断", () => {
  const { previewOf } = loadClient().exports.__internals;
  assert.equal(previewOf("a\n b  c", 20), "a b c");
  assert.equal(previewOf("x".repeat(30), 10), "x".repeat(9) + "…");
  assert.equal(previewOf(null, 10), "");
});

test("normalizeStorage：null / 坏数据回退种子数据", () => {
  const { normalizeStorage, SEED_ITEMS } = loadClient().exports.__internals;

  const fallback = normalizeStorage(null);
  assert.equal(fallback.mode, "insert");
  assert.equal(fallback.items.length, SEED_ITEMS.length);
  assert.deepEqual(fallback.items.map((it) => it.name), SEED_ITEMS.map((it) => it.name));

  assert.deepEqual(normalizeStorage("不是JSON"), fallback);

  const empty = normalizeStorage({ version: 1, items: [] });
  assert.equal(empty.items.length, SEED_ITEMS.length, "空列表回退到种子数据");
});

test("normalizeStorage：清洗非法条目、截断超长、模式只认 copy/insert", () => {
  const { normalizeStorage } = loadClient().exports.__internals;

  const cleaned = normalizeStorage({
    version: 1,
    mode: "copy",
    items: [
      { id: "a", name: "正常", text: "内容" },
      { name: "", text: "没名字，丢弃" },
      { name: "没内容，丢弃", text: "   " },
      null,
      { id: "b", name: "超长名" + "名".repeat(60), text: "内容" },
    ],
  });
  assert.equal(cleaned.mode, "copy");
  assert.equal(cleaned.items.length, 2);
  assert.equal(cleaned.items[0].id, "a");
  assert.ok(cleaned.items[1].name.length <= 40, "名字被截断到 40 字以内");
});

test("normalizeStorage：字符串存储照常解析", () => {
  const { normalizeStorage } = loadClient().exports.__internals;
  const parsed = normalizeStorage(
    JSON.stringify({ version: 1, mode: "insert", items: [{ id: "x", name: "n", text: "t" }] }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, "n");
});

test("package.json 元数据：dsh 插件声明齐全", () => {
  assert.equal(PKG.type, "module");
  assert.ok(PKG.dsh, "缺少 dsh 元数据");
  assert.ok(PKG.dsh.bundle && PKG.dsh.bundle.patch, "缺少 bundle patch 声明");
  assert.ok(PKG.dsh.client && PKG.dsh.client.platform === "web");
  assert.ok(PKG.engines && PKG.engines.dsh, "缺少 engines.dsh 兼容范围");
  assert.ok(Array.isArray(PKG.keywords) && PKG.keywords.includes("dsh-plugin"));
});

test("宿主半边：零宿主服务依赖、入口可静态审计", () => {
  const hostSrc = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(!/inject\s*[:=]/.test(hostSrc), "宿主半边不应声明 inject 服务");
  assert.match(hostSrc, /export function apply/);
});

test("cordis.patch.yml：insert 的 name 与包名一致", () => {
  const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.ok(patch.includes("- insert:"));
  assert.ok(patch.includes(`name: '${PKG.name}'`));
  assert.ok(patch.includes("id: quick-prompts"));
});
