/**
 * dsh-quick-prompts — 客户端半边
 *
 * 在输入框右侧工具行放一个「⚡ 快捷语」按钮：点开是常用提示词列表，
 * 点某一条就把内容追加进聊天输入框（直接插入失败时自动回退为复制到剪贴板）。
 * 支持新建 / 编辑 / 删除，数据只存 localStorage，零网络请求、零 token 消耗。
 *
 * 三条纪律（沿用 DSH 生态里已被事故验证过的形状）：
 *   1. **fail-open**：找不到输入框、样式失败、存储被禁……都只降级（复制/提示），
 *      绝不连累宿主输入区。
 *   2. **绝不注入消息**：不监听会话事件、不 append 会话事件、不构造消息；
 *      唯一的动作是往输入框追加文本（或复制）。
 *   3. **只动自己的 DOM**：控件与弹层全部挂在自有类名（dqp-*）下，
 *      不碰官方元素、不改官方 class；弹层用 portal 挂到 body，避免被输入区裁剪。
 */
window.__ModuleLoader__.load({
  id: "dsh-quick-prompts",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    var PACKAGE_ID = "dsh-quick-prompts";
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "quick-prompts";
    var ENTRY_ORDER = 70;
    var STYLE_MARKER = PACKAGE_ID;
    var STORAGE_KEY = "dsh-quick-prompts:v1";
    var MAX_ITEMS = 100;
    var MAX_NAME = 40;
    var MAX_TEXT = 4000;
    var POPOVER_WIDTH = 320;

    /** 首次使用的种子提示词（只作为默认数据，可随意改删）。 */
    var SEED_ITEMS = [
      { id: "seed-trans-en", name: "翻译成英文", text: "请把下面的内容翻译成地道的英文，只输出译文：\n" },
      { id: "seed-summary", name: "总结要点", text: "请把上面的内容总结成要点，逐条列出。" },
      { id: "seed-explain-code", name: "解释代码", text: "请逐段解释下面这段代码的作用，指出关键逻辑和潜在问题：\n" },
      { id: "seed-polish", name: "润色文字", text: "请润色下面这段文字，使其更通顺、专业，保留原意：\n" },
      { id: "seed-titles", name: "起 3 个标题", text: "请为下面的内容起 3 个合适的标题：\n" },
    ];

    /* ══════════════════════ 纯函数（离线可测） ══════════════════════ */

    function makeId() {
      return "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function clampStr(value, max) {
      var s = String(value == null ? "" : value);
      return s.length > max ? s.slice(0, max) : s;
    }

    /** 列表里的单行预览：压掉换行，超长截断。 */
    function previewOf(text, maxLen) {
      var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
      if (s.length > maxLen) return s.slice(0, maxLen - 1) + "…";
      return s;
    }

    /**
     * 把片段追加进已有输入内容的拼接规则：空则直接用；
     * 已有内容不以换行结尾时补一个换行，避免黏在一起。
     */
    function buildAppendedText(existing, snippet) {
      var cur = String(existing == null ? "" : existing);
      var add = String(snippet == null ? "" : snippet);
      if (!add) return cur;
      if (!cur) return add;
      if (cur.charAt(cur.length - 1) === "\n") return cur + add;
      return cur + "\n" + add;
    }

    /** 校验并清洗存储数据；任何不合法都回退到种子数据，绝不抛错。 */
    function normalizeStorage(raw) {
      var seedItems = SEED_ITEMS.map(function (it) {
        return { id: it.id, name: it.name, text: it.text, createdAt: 0 };
      });
      var seed = { version: 1, mode: "insert", items: seedItems };
      var v = raw;
      try {
        if (typeof v === "string") v = v ? JSON.parse(v) : null;
        if (!v || typeof v !== "object") return seed;
        var items = Array.isArray(v.items) ? v.items : seedItems;
        var cleaned = [];
        for (var i = 0; i < items.length && cleaned.length < MAX_ITEMS; i++) {
          var it = items[i];
          if (!it || typeof it !== "object") continue;
          var name = clampStr(String(it.name == null ? "" : it.name).trim(), MAX_NAME);
          var text = String(it.text == null ? "" : it.text);
          if (!name || !text.trim()) continue;
          if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
          cleaned.push({
            id: clampStr(it.id || makeId(), 64),
            name: name,
            text: text,
            createdAt: Number(it.createdAt) || 0,
          });
        }
        return {
          version: 1,
          mode: v.mode === "copy" ? "copy" : "insert",
          items: cleaned.length > 0 ? cleaned : seedItems,
        };
      } catch {
        return seed;
      }
    }

    /* ══════════════════════ 存储与浏览器工具 ══════════════════════ */

    function readStorage() {
      try {
        return normalizeStorage(window.localStorage.getItem(STORAGE_KEY));
      } catch {
        return normalizeStorage(null);
      }
    }

    function writeStorage(data) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return true;
      } catch {
        return false;
      }
    }

    /** 找聊天输入框：优先可见的 <textarea>，其次 contenteditable；跳过本插件自己的弹层。 */
    function findChatTarget() {
      try {
        var i, el;
        var tas = document.querySelectorAll("textarea");
        for (i = tas.length - 1; i >= 0; i--) {
          el = tas[i];
          if (isVisible(el) && !el.closest(".dqp-popover") && !el.closest(".dqp-root")) {
            return { kind: "textarea", el: el };
          }
        }
        var ces = document.querySelectorAll('[contenteditable="true"]');
        for (i = ces.length - 1; i >= 0; i--) {
          el = ces[i];
          if (isVisible(el) && !el.closest(".dqp-popover") && !el.closest(".dqp-root")) {
            return { kind: "ce", el: el };
          }
        }
      } catch {
        /* fall through */
      }
      return null;
    }

    function isVisible(el) {
      try {
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    }

    /**
     * 往目标输入控件追加文本。textarea 走「原生 setter + input 事件」让 React 感知；
     * contenteditable 走 execCommand("insertText")。成功返回 true。
     */
    function insertText(target, text) {
      if (!target || !target.el || !text) return false;
      try {
        if (target.kind === "textarea") {
          var el = target.el;
          var proto = el instanceof window.HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          var next = buildAppendedText(el.value, text);
          setter.call(el, next);
          el.dispatchEvent(new window.Event("input", { bubbles: true }));
          el.focus();
          try {
            el.selectionStart = el.selectionEnd = next.length;
          } catch {
            /* 部分实现不允许脚本设置选区，忽略 */
          }
          return true;
        }
        if (target.kind === "ce") {
          var ce = target.el;
          ce.focus();
          try {
            var doc = ce.ownerDocument || document;
            var range = doc.createRange();
            range.selectNodeContents(ce);
            range.collapse(false);
            var sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch {
            /* 光标定位失败不阻断插入 */
          }
          return doc.execCommand("insertText", false, text);
        }
      } catch {
        /* 任何一步失败都交给调用方回退为复制 */
      }
      return false;
    }

    /** 复制到剪贴板，成功返回 true（带 execCommand 兜底）。 */
    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).catch(function () {
            legacyCopy(text);
          });
          return true;
        }
      } catch {
        /* fall through */
      }
      return legacyCopy(text);
    }

    function legacyCopy(text) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }

    var TOOLTIP_TIMER = null;

    function showToast(message) {
      try {
        var t = document.createElement("div");
        t.className = "dqp-toast";
        t.textContent = message;
        document.body.appendChild(t);
        window.setTimeout(function () {
          t.classList.add("dqp-toast-out");
        }, 1500);
        window.setTimeout(function () {
          if (t.parentNode) t.parentNode.removeChild(t);
        }, 1900);
      } catch {
        /* 提示失败就失败吧 */
      }
    }

    /* ══════════════════════ 样式（只挂自己的类名） ══════════════════════ */

    var CSS = [
      ".dqp-root{display:inline-flex;align-items:center;min-width:0}",
      ".dqp-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:999px;"
        + "border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.12));background:transparent;"
        + "color:var(--dsw-alias-label-primary,#0f1115);font-size:12px;line-height:1;cursor:pointer;"
        + "user-select:none;-webkit-user-select:none;white-space:nowrap}",
      ".dqp-btn:hover,.dqp-btn:focus-visible{border-color:var(--dsw-alias-state-business-primary,#4d93f8);"
        + "color:var(--dsw-alias-state-business-primary,#4d93f8)}",
      ".dqp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d93f8);outline-offset:2px}",
      ".dqp-popover{position:fixed;width:" + POPOVER_WIDTH + "px;max-width:calc(100vw - 16px);max-height:340px;"
        + "display:flex;flex-direction:column;background:var(--dsw-alias-bg-primary,#fff);"
        + "color:var(--dsw-alias-label-primary,#0f1115);border-radius:12px;overflow:hidden;"
        + "box-shadow:0 8px 30px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);z-index:2147483000;font-size:12px}",
      ".dqp-head{padding:10px 12px 6px;font-weight:600;flex:none}",
      ".dqp-list{overflow-y:auto;padding:0 6px 6px;min-height:0}",
      ".dqp-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:8px;"
        + "border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dqp-item:hover,.dqp-item:focus-visible{background:var(--dsw-alias-fill-secondary,rgba(15,17,21,.06))}",
      ".dqp-item-name{font-weight:600;flex:none;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dqp-item-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        + "color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dqp-item-actions{display:none;flex:none;gap:2px}",
      ".dqp-item:hover .dqp-item-actions,.dqp-item:focus-within .dqp-item-actions{display:inline-flex}",
      ".dqp-icon-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;"
        + "border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0}",
      ".dqp-icon-btn:hover{background:var(--dsw-alias-fill-tertiary,rgba(15,17,21,.1))}",
      ".dqp-icon-btn.dqp-danger:hover{color:var(--dsw-alias-state-error-primary,#e5484d)}",
      ".dqp-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dqp-editor{flex:none;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.12));"
        + "display:flex;flex-direction:column;gap:6px}",
      ".dqp-input,.dqp-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.18));"
        + "border-radius:8px;background:transparent;color:inherit;font:inherit;padding:6px 8px;resize:vertical}",
      ".dqp-input{height:28px}",
      ".dqp-textarea{min-height:56px;max-height:120px}",
      ".dqp-input:focus,.dqp-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d93f8)}",
      ".dqp-editor-actions{display:flex;justify-content:flex-end;gap:6px}",
      ".dqp-mini{height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.18));"
        + "background:transparent;color:inherit;font-size:11px;cursor:pointer}",
      ".dqp-mini.dqp-primary{background:var(--dsw-alias-state-business-primary,#4d93f8);border-color:transparent;color:#fff}",
      ".dqp-mini:disabled{opacity:.45;cursor:default}",
      ".dqp-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;"
        + "padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.12));"
        + "font-size:11px;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dqp-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(15,17,21,.86);"
        + "color:#fff;padding:7px 14px;border-radius:999px;font-size:12px;z-index:2147483600;pointer-events:none;"
        + "transition:opacity .35s}",
      ".dqp-toast-out{opacity:0}",
    ];

    function installStyles() {
      try {
        if (typeof document === "undefined" || !document.head) return null;
        var existing = document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
        if (existing) return existing;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", STYLE_MARKER);
        style.textContent = CSS.join("");
        document.head.appendChild(style);
        return style;
      } catch {
        /* 样式失败只影响观感，绝不影响功能 */
        return null;
      }
    }

    /* ══════════════════════ React 组件（无 JSX，纯 createElement） ══════════════════════ */

    function SnippetRow(props) {
      var it = props.item;
      return React.createElement(
        "button",
        {
          className: "dqp-item",
          type: "button",
          title: it.text,
          onClick: function (e) {
            e.stopPropagation();
            props.onUse(it);
          },
        },
        React.createElement("span", { className: "dqp-item-name" }, it.name),
        React.createElement("span", { className: "dqp-item-preview" }, previewOf(it.text, 60)),
        React.createElement(
          "span",
          { className: "dqp-item-actions", onClick: function (e) { e.stopPropagation(); } },
          React.createElement(
            "button",
            {
              className: "dqp-icon-btn",
              type: "button",
              title: "编辑",
              onClick: function () { props.onEdit(it); },
            },
            "✎",
          ),
          React.createElement(
            "button",
            {
              className: "dqp-icon-btn dqp-danger",
              type: "button",
              title: "删除",
              onClick: function () { props.onRemove(it); },
            },
            "✕",
          ),
        ),
      );
    }

    function EditorForm(props) {
      var nameR = React.useState(props.editing ? props.editing.name : "");
      var name = nameR[0], setName = nameR[1];
      var textR = React.useState(props.editing ? props.editing.text : "");
      var text = textR[0], setText = textR[1];
      var valid = name.trim().length > 0 && text.trim().length > 0;
      return React.createElement(
        "div",
        { className: "dqp-editor" },
        React.createElement("input", {
          className: "dqp-input",
          value: name,
          maxLength: MAX_NAME,
          placeholder: "名称（如：翻译成英文）",
          autoFocus: true,
          onChange: function (e) { setName(e.target.value); },
        }),
        React.createElement("textarea", {
          className: "dqp-textarea",
          value: text,
          maxLength: MAX_TEXT,
          placeholder: "提示词内容，会追加到输入框",
          onChange: function (e) { setText(e.target.value); },
        }),
        React.createElement(
          "div",
          { className: "dqp-editor-actions" },
          React.createElement(
            "button",
            { className: "dqp-mini", type: "button", onClick: props.onCancel },
            "取消",
          ),
          React.createElement(
            "button",
            {
              className: "dqp-mini dqp-primary",
              type: "button",
              disabled: !valid,
              onClick: function () { props.onSave(name.trim(), text); },
            },
            props.editing ? "保存修改" : "添加",
          ),
        ),
      );
    }

    function PromptPopover(props) {
      var data = props.data;
      var items = data.items;
      return React.createElement(
        "div",
        {
          className: "dqp-popover",
          role: "dialog",
          "aria-label": "快捷提示词",
          style: props.pos,
          ref: props.popRef,
        },
        React.createElement("div", { className: "dqp-head" }, "⚡ 快捷提示词"),
        React.createElement(
          "div",
          { className: "dqp-list" },
          props.editor === null && items.length === 0
            ? React.createElement("div", { className: "dqp-empty" }, "还没有快捷语，点下方「＋ 新建」添加")
            : null,
          props.editor === null
            ? items.map(function (it) {
                return React.createElement(SnippetRow, {
                  key: it.id,
                  item: it,
                  onUse: props.onUse,
                  onEdit: props.onEdit,
                  onRemove: props.onRemove,
                });
              })
            : null,
          props.editor !== null
            ? React.createElement(EditorForm, {
                editing: props.editor.id ? props.editor : null,
                onSave: props.onSave,
                onCancel: props.onCancel,
              })
            : null,
        ),
        props.editor === null
          ? React.createElement(
              "div",
              { className: "dqp-footer" },
              React.createElement(
                "button",
                {
                  className: "dqp-mini",
                  type: "button",
                  title: "切换使用方式",
                  onClick: props.onToggleMode,
                },
                data.mode === "copy" ? "方式：复制到剪贴板" : "方式：直接填入输入框",
              ),
              React.createElement(
                "button",
                { className: "dqp-mini dqp-primary", type: "button", onClick: props.onNew },
                "＋ 新建",
              ),
            )
          : null,
      );
    }

    function QuickPromptsWidget() {
      var openR = React.useState(false);
      var open = openR[0], setOpen = openR[1];
      var dataR = React.useState(readStorage);
      var data = dataR[0], setData = dataR[1];
      var editorR = React.useState(null);
      var editor = editorR[0], setEditor = editorR[1];
      var posR = React.useState(null);
      var pos = posR[0], setPos = posR[1];
      var btnRef = React.useRef(null);
      var popRef = React.useRef(null);

      function commit(next) {
        writeStorage(next);
        setData(next);
      }

      function openPopover() {
        var style = { right: "16px", bottom: "120px" };
        try {
          var rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
          if (rect && typeof window !== "undefined") {
            style.right = Math.max(8, window.innerWidth - rect.right) + "px";
            var spaceAbove = rect.top;
            var spaceBelow = window.innerHeight - rect.bottom;
            if (spaceAbove >= 380 || spaceAbove >= spaceBelow) {
              style.bottom = window.innerHeight - rect.top + 6 + "px";
            } else {
              style.top = rect.bottom + 6 + "px";
            }
          }
        } catch {
          /* 定位失败用兜底位置 */
        }
        setPos(style);
        setOpen(true);
      }

      React.useEffect(
        function () {
          if (!open) return undefined;
          function onDocDown(e) {
            try {
              if (popRef.current && popRef.current.contains(e.target)) return;
              if (btnRef.current && btnRef.current.contains(e.target)) return;
              setOpen(false);
            } catch {
              /* 判定失败保持打开 */
            }
          }
          function onKey(e) {
            if (e && e.key === "Escape") setOpen(false);
          }
          function onScroll(e) {
            try {
              if (popRef.current && popRef.current.contains(e.target)) return;
              setOpen(false);
            } catch {
              /* ignore */
            }
          }
          document.addEventListener("pointerdown", onDocDown, true);
          document.addEventListener("keydown", onKey, true);
          window.addEventListener("scroll", onScroll, true);
          window.addEventListener("resize", onScroll);
          return function () {
            document.removeEventListener("pointerdown", onDocDown, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onScroll);
          };
        },
        [open],
      );

      function useItem(it) {
        setOpen(false);
        if (data.mode === "copy") {
          if (copyText(it.text)) showToast("已复制，粘贴到输入框即可");
          else showToast("复制失败，请打开条目手动复制");
          return;
        }
        var target = findChatTarget();
        if (target && insertText(target, it.text)) {
          showToast("已填入输入框");
          return;
        }
        if (copyText(it.text)) showToast("没找到输入框，已复制到剪贴板");
        else showToast("无法自动填入，请手动复制");
      }

      function removeItem(it) {
        var ok = false;
        try {
          ok = window.confirm('删除「' + it.name + '」？');
        } catch {
          ok = true;
        }
        if (!ok) return;
        commit({
          version: 1,
          mode: data.mode,
          items: data.items.filter(function (x) { return x.id !== it.id; }),
        });
      }

      function saveItem(name, text) {
        var items;
        if (editor && editor.id) {
          items = data.items.map(function (x) {
            return x.id === editor.id ? { id: x.id, name: name, text: text, createdAt: x.createdAt } : x;
          });
        } else {
          items = data.items.concat([{ id: makeId(), name: name, text: text, createdAt: Date.now() }]);
          if (items.length > MAX_ITEMS) items = items.slice(items.length - MAX_ITEMS);
        }
        commit({ version: 1, mode: data.mode, items: items });
        setEditor(null);
      }

      var widget = React.createElement(
        "span",
        { className: "dqp-root" },
        React.createElement(
          "button",
          {
            className: "dqp-btn",
            type: "button",
            ref: btnRef,
            "aria-haspopup": "dialog",
            "aria-expanded": open ? "true" : "false",
            title: "快捷提示词",
            onClick: function () {
              if (open) setOpen(false);
              else openPopover();
            },
          },
          "⚡ 快捷语",
        ),
      );

      var popover = open
        ? ReactDOM.createPortal(
            React.createElement(PromptPopover, {
              data: data,
              pos: pos,
              editor: editor,
              popRef: popRef,
              onUse: useItem,
              onEdit: function (it) { setEditor({ id: it.id, name: it.name, text: it.text }); },
              onNew: function () { setEditor({}); },
              onSave: saveItem,
              onCancel: function () { setEditor(null); },
              onRemove: removeItem,
              onToggleMode: function () {
                commit({ version: 1, mode: data.mode === "copy" ? "insert" : "copy", items: data.items });
              },
            }),
            document.body,
          )
        : null;

      return React.createElement(React.Fragment, null, widget, popover);
    }

    /* ══════════════════════ 插槽注册 ══════════════════════ */

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "Quick prompts"; },
            },
            function SlotComponent(props) {
              return React.createElement(QuickPromptsWidget, Object.assign({}, props, {}));
            },
          );
        });
      } catch (error) {
        // 注册失败只意味着这块控件不出现，绝不能连累宿主输入区。
        try {
          console.error("[" + PACKAGE_ID + "] 插槽注册失败，控件不会出现：", error);
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    var inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    // 离线测试用的接缝（纯函数 + 常量）。运行时无副作用。
    exports.__internals = {
      PACKAGE_ID: PACKAGE_ID,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ID: ENTRY_ID,
      STORAGE_KEY: STORAGE_KEY,
      SEED_ITEMS: SEED_ITEMS,
      makeId: makeId,
      previewOf: previewOf,
      buildAppendedText: buildAppendedText,
      normalizeStorage: normalizeStorage,
    };

    return module.exports;
  },
});
