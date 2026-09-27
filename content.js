(() => {
  "use strict";

  const ROOT_ID = "ddb-notes-root";
  if (document.getElementById(ROOT_ID)) return;

  const SAVE_DELAY = 600;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 720;
  const DEF_WIDTH = 340;
  const DEF_RATIO = 0.5;
  const POLL = 800;
  const SCHEMA = 5;
  const THEMES = ["auto", "light", "dark"];
  const HISTORY = 200;

  // ---------------------------------------------------------------- storage

  // chrome.storage.local.get fills in defaults itself when handed a
  // key -> default object, so every setting reads in a single round trip.
  const store = {
    async get(query) {
      try {
        return await chrome.storage.local.get(query);
      } catch {
        return Array.isArray(query) ? {} : { ...query };
      }
    },
    async set(key, value) {
      try {
        await chrome.storage.local.set({ [key]: value });
        return true;
      } catch {
        return false;
      }
    },
  };

  // Sheets live at /characters/<id>, and the same id also appears under
  // /profile/<user>/characters/<id> and the builder's /characters/<id>/builder.
  const CHAR_PATH = /\/characters\/(\d+)(?:\/|$)/;
  const characterId = () => {
    const m = CHAR_PATH.exec(location.pathname);
    return m ? m[1] : null;
  };

  const notesKey = (id) => `notes:${id}`;
  const UI_OPEN = "ui:open";
  const UI_WIDTH = "ui:width";
  const UI_PUSH = "ui:push";
  const UI_THEME = "ui:theme";
  const UI_SPLIT = "ui:split";
  const UI_RATIO = "ui:splitRatio";

  const uid = () =>
    `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // --------------------------------------------------------------- markdown

  // Notes are stored as Markdown and drawn one line per div. Every syntax
  // character stays in the DOM as text, wrapped in a .md-mark span that the
  // stylesheet hides on lines the caret is not on, so an offset into the
  // source is always the same offset into the line's text. That is what lets
  // the caret survive a re-render on every keystroke.

  const esc = (s) =>
    s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  const attr = (s) => esc(s).replace(/"/g, "&quot;");
  const mark = (s, keep = false) =>
    `<span class="md-mark${keep ? " md-keep" : ""}">${esc(s)}</span>`;
  const stick = (re, s, i) => {
    re.lastIndex = i;
    return re.exec(s);
  };

  const WORD_RE = /[\p{L}\p{N}]/u;
  const SPACE_RE = /\s/;
  const PUNCT_RE = /[!-/:-@[-`{-~]/;
  const CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
  const WIKI_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/y;
  const LINK_RE = /(!?)\[([^\]\n]+)\](\(((?:[^\s()]|\([^\s()]*\))*)(?:[ \t]+"[^"\n]*")?\))/y;
  const URL_RE = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}*_~]/iy;
  const TAG_RE = /#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/uy;

  // Longest first, so *** is tried before ** and ** before *.
  const DELIMS = [
    ["***", "***", "<strong><em>", "</em></strong>"],
    ["**", "**", "<strong>", "</strong>"],
    ["__", "__", "<strong>", "</strong>"],
    ["~~", "~~", "<s>", "</s>"],
    ["==", "==", "<mark>", "</mark>"],
    ["<u>", "</u>", "<u>", "</u>"],
    ["*", "*", "<em>", "</em>"],
    ["_", "_", "<em>", "</em>"],
  ];
  const DELIM_CHARS = new Set(["*", "_", "~", "=", "<"]);

  // Where the emphasis that opens at `from` closes. A closer has to hug its
  // text, a lone * cannot be half of a **, and _ does not close mid-word.
  function closer(s, from, close, flank) {
    let k = from + 1;
    while ((k = s.indexOf(close, k)) !== -1) {
      if (!flank) return k;
      const prev = s[k - 1];
      const next = s[k + close.length] || "";
      const ch = close[0];
      if (
        !SPACE_RE.test(prev) &&
        !(close.length === 1 && (prev === ch || next === ch)) &&
        !(ch === "_" && WORD_RE.test(next))
      ) {
        return k;
      }
      k++;
    }
    return -1;
  }

  function inline(s) {
    let out = "";
    let plain = 0;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      let html = null;
      let m = null;
      let end = i;

      if (c === "\\" && PUNCT_RE.test(s[i + 1] || "")) {
        html = mark("\\") + esc(s[i + 1]);
        end = i + 2;
      } else if (c === "`") {
        if ((m = stick(CODE_RE, s, i))) {
          html = mark(m[1]) + `<code>${esc(m[2])}</code>` + mark(m[1]);
        }
      } else if (c === "[" || c === "!") {
        if (c === "[" && (m = stick(WIKI_RE, s, i))) {
          const [, target, alias] = m;
          html =
            mark("[[") +
            (alias ? mark(`${target}|`) : "") +
            `<span class="md-wikilink" data-target="${attr(target)}">${esc(alias || target)}</span>` +
            mark("]]");
        } else if ((m = stick(LINK_RE, s, i))) {
          html =
            (m[1] ? mark("!") : "") +
            mark("[") +
            `<span class="md-link" data-href="${attr(m[4])}">${inline(m[2])}</span>` +
            mark(`]${m[3]}`);
        }
      } else if ((c === "h" || c === "H") && !(i && WORD_RE.test(s[i - 1]))) {
        if ((m = stick(URL_RE, s, i))) {
          html = `<span class="md-link md-url" data-href="${attr(m[0])}">${esc(m[0])}</span>`;
        }
      } else if (c === "#" && (!i || SPACE_RE.test(s[i - 1]))) {
        if ((m = stick(TAG_RE, s, i))) html = `<span class="md-tag">${esc(m[0])}</span>`;
      } else if (DELIM_CHARS.has(c)) {
        for (const [open, close, a, b] of DELIMS) {
          if (!s.startsWith(open, i)) continue;
          const from = i + open.length;
          const flank = open !== "<u>";
          if (flank && (from >= s.length || SPACE_RE.test(s[from]))) continue;
          if (open[0] === "_" && i && WORD_RE.test(s[i - 1])) continue;
          const k = closer(s, from, close, flank);
          if (k < 0) continue;
          html = mark(open) + a + inline(s.slice(from, k)) + b + mark(close);
          end = k + close.length;
          break;
        }
      }

      if (html === null) {
        i++;
        continue;
      }
      if (m) end = i + m[0].length;
      if (i > plain) out += esc(s.slice(plain, i));
      out += html;
      i = plain = end;
    }
    if (s.length > plain) out += esc(s.slice(plain));
    return out;
  }

  const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
  const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const HEAD_RE = /^(#{1,6})[ \t]+/;
  const QUOTE_RE = /^(?:[ \t]{0,3}>[ \t]?)+/;
  const TASK_RE = /^([ \t]*)([-*+][ \t]+)\[([ xX])\](?=[ \t]|$)/;
  const BULLET_RE = /^([ \t]*)([-*+])([ \t]+)/;
  const ORDER_RE = /^([ \t]*)(\d{1,9}[.)])([ \t]+)/;
  const ROW_RE = /^[ \t]*\|/;
  const SEP_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  // One line outside a code fence or table. A marker that would leave the
  // line with nothing visible is kept on screen, or the line would fold to
  // nothing and the caret could not reach it.
  function block(src) {
    if (!src) return { cls: "", html: "<br>" };
    if (HR_RE.test(src)) return { cls: "md-hr", html: esc(src) };

    let cls = "";
    let html = "";
    let rest = src;
    let m = QUOTE_RE.exec(rest);
    if (m) {
      rest = rest.slice(m[0].length);
      cls = "md-quote";
      html = mark(m[0], !rest);
    }

    if ((m = HEAD_RE.exec(rest))) {
      const body = rest.slice(m[0].length);
      return {
        cls: `${cls} md-h md-h${m[1].length}`.trim(),
        html: html + mark(m[0], !body) + inline(body),
      };
    }

    if ((m = TASK_RE.exec(rest))) {
      cls += ` md-li md-task${m[3] === " " ? "" : " md-done"}`;
      html +=
        esc(m[1]) +
        mark(m[2]) +
        `<span class="md-check">[${esc(m[3])}]</span>` +
        `<span class="md-task-text">${inline(rest.slice(m[0].length))}</span>`;
    } else if ((m = BULLET_RE.exec(rest))) {
      cls += " md-li";
      html +=
        esc(m[1]) + `<span class="md-bullet">${esc(m[2])}</span>` + esc(m[3]) +
        inline(rest.slice(m[0].length));
    } else if ((m = ORDER_RE.exec(rest))) {
      cls += " md-li";
      html +=
        esc(m[1]) + `<span class="md-ol">${esc(m[2])}</span>` + esc(m[3]) +
        inline(rest.slice(m[0].length));
    } else {
      html += inline(rest);
    }
    return { cls: cls.trim(), html: html || "<br>" };
  }

  // Pipes become marks and the text between them becomes cells, so a row
  // can lay out as a table when idle and fall back to its source when not.
  function tableRow(src, cls) {
    const parts = src.split(/(?<!\\)\|/);
    const last = parts.length - 1;
    const closed = !parts[last].trim();
    let html = "";
    for (let k = 1; k < parts.length; k++) {
      if (k === last && closed) {
        html += mark(`|${parts[k]}`);
        break;
      }
      html +=
        mark(k === 1 ? `${parts[0]}|` : "|") +
        `<span class="md-td${k === 1 ? " md-td0" : ""}">${inline(parts[k])}</span>`;
    }
    return { cls, html };
  }

  // block() depends on nothing but its source, and most lines are the same
  // from one keystroke to the next, so each rendering is kept by its text.
  const blockMemo = new Map();

  function renderBlock(src) {
    let row = blockMemo.get(src);
    if (!row) {
      if (blockMemo.size > 5000) blockMemo.clear();
      row = block(src);
      blockMemo.set(src, row);
    }
    return row;
  }

  function renderAll(lines) {
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const src = lines[i];
      let m = FENCE_RE.exec(src);

      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
          out.push({ cls: "md-fence md-fence-end", html: esc(src) });
          fence = null;
        } else {
          out.push({ cls: "md-code", html: src ? esc(src) : "<br>" });
        }
        continue;
      }

      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        fence = m[1];
        out.push({ cls: "md-fence md-fence-start", html: esc(src) });
        continue;
      }

      const next = lines[i + 1];
      if (ROW_RE.test(src) && next && SEP_RE.test(next) && next.includes("|")) {
        out.push(tableRow(src, "md-t md-th"));
        out.push({ cls: "md-t md-tsep", html: esc(lines[++i]) });
        while (i + 1 < lines.length && ROW_RE.test(lines[i + 1])) {
          out.push(tableRow(lines[++i], "md-t"));
        }
        continue;
      }

      out.push(renderBlock(src));
    }
    return out;
  }

  // ---------------------------------------------------------- html import

  // Notes saved before v4 were HTML, and pasted web content still is. Both
  // are parsed in an inert document, made once and reused, and walked into
  // Markdown lines.
  const scratch = document.implementation.createHTMLDocument("").body;
  const MARKUP = /[<>&]/;
  const RICH = /<(?:b|strong|i|em|u|s|strike|del|mark|code|pre|h[1-6]|li|a|table|blockquote|hr)[\s>]/i;

  const BLOCKS = new Set([
    "DIV", "P", "LI", "UL", "OL", "DL", "DT", "DD",
    "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "HR",
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR",
    "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "NAV", "MAIN",
    "FIGURE", "FIGCAPTION", "ADDRESS", "DETAILS", "SUMMARY", "FORM",
    "FIELDSET", "CENTER",
  ]);
  const SKIP = new Set([
    "SCRIPT", "STYLE", "TEMPLATE", "HEAD", "TITLE", "META", "LINK",
    "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "CANVAS", "BUTTON", "INPUT",
    "SELECT", "TEXTAREA",
  ]);
  const WRAPS = {
    B: ["**", "**"], STRONG: ["**", "**"], I: ["*", "*"], EM: ["*", "*"],
    U: ["<u>", "</u>"], S: ["~~", "~~"], STRIKE: ["~~", "~~"],
    DEL: ["~~", "~~"], MARK: ["==", "=="], CODE: ["`", "`"],
  };
  const URL_ESC = { " ": "%20", "(": "%28", ")": "%29" };

  function htmlToMd(html) {
    const src = String(html || "");
    if (!MARKUP.test(src)) return src;
    scratch.innerHTML = src;

    const out = [];
    let line = "";
    let open = false;
    let head = 0; // length of the prefix begin() wrote on the open line
    let quote = 0;
    let marker = "";
    let pre = false;
    let table = null;
    const lists = [];

    const begin = () => {
      if (open) return;
      open = true;
      line = "> ".repeat(quote) + marker;
      head = line.length;
      marker = "";
    };
    const flush = () => {
      if (!open) return;
      out.push(pre ? line : line.replace(/[ \t]+$/, ""));
      line = "";
      open = false;
    };
    const emit = (s) => {
      flush();
      begin();
      line += s;
      flush();
    };

    const text = (raw) => {
      if (pre) {
        raw.replace(/\r\n?/g, "\n").split("\n").forEach((part, k) => {
          if (k) {
            begin();
            flush();
          }
          if (part) {
            begin();
            line += part.replace(/ /g, " ");
          }
        });
        return;
      }
      let t = raw.replace(/[ \t\n\r\f]+/g, " ");
      if (!open) t = t.replace(/^ /, "");
      if (!t) return;
      begin();
      line += t.replace(/ /g, " ");
    };

    const visit = (parent) => {
      for (let n = parent.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) {
          text(n.nodeValue);
          continue;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = n.tagName.toUpperCase();
        if (SKIP.has(tag)) continue;

        if (tag === "BR") {
          // A br closing out a block is the editor's placeholder for an
          // empty line, not a second break.
          begin();
          if (n.nextSibling || !BLOCKS.has(parent.tagName)) flush();
        } else if (tag === "HR") {
          emit("---");
        } else if (tag === "PRE") {
          emit("```");
          pre = true;
          visit(n);
          flush();
          pre = false;
          emit("```");
        } else if (tag === "UL" || tag === "OL") {
          flush();
          lists.push({ ordered: tag === "OL", n: Number(n.getAttribute("start")) || 1 });
          visit(n);
          lists.pop();
          flush();
        } else if (tag === "LI") {
          flush();
          const list = lists[lists.length - 1];
          marker =
            "\t".repeat(Math.max(0, lists.length - 1)) +
            (list && list.ordered ? `${list.n++}. ` : "- ");
          visit(n);
          marker = "";
          flush();
        } else if (tag === "BLOCKQUOTE") {
          flush();
          quote++;
          visit(n);
          quote--;
          flush();
        } else if (/^H[1-6]$/.test(tag)) {
          flush();
          marker += `${"#".repeat(Number(tag[1]))} `;
          visit(n);
          marker = "";
          flush();
        } else if (tag === "TABLE") {
          flush();
          const outer = table;
          table = { rows: 0 };
          visit(n);
          table = outer;
          flush();
        } else if (tag === "TR") {
          const cells = Array.from(n.children).filter(
            (c) => c.tagName === "TD" || c.tagName === "TH"
          );
          if (!cells.length) continue;
          const row = cells.map((c) =>
            c.textContent.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
          );
          emit(`| ${row.join(" | ")} |`);
          if (table && !table.rows++) emit(`|${" --- |".repeat(cells.length)}`);
        } else if ((WRAPS[tag] || tag === "A") && !pre) {
          // Wrap whatever text the element added, with any edge spaces moved
          // outside the markers, where Markdown expects them.
          const was = open;
          const at = line.length;
          const rows = out.length;
          visit(n);
          if (!open || out.length !== rows) continue;
          const from = was ? at : head;
          const inner = line.slice(from);
          const core = inner.trim();
          if (!core) continue;
          const lead = was ? inner.slice(0, inner.length - inner.trimStart().length) : "";
          const trail = inner.slice(inner.trimEnd().length);
          let body = core;
          if (tag !== "A") {
            body = WRAPS[tag][0] + core + WRAPS[tag][1];
          } else {
            const href = n.getAttribute("href") || "";
            if (!/^(https?:|mailto:)/i.test(href)) continue;
            if (core !== href) {
              body = `[${core.replace(/[[\]]/g, "")}](${href.replace(/[ ()]/g, (c) => URL_ESC[c])})`;
            }
          }
          line = line.slice(0, from) + lead + body + trail;
        } else if (BLOCKS.has(tag)) {
          flush();
          visit(n);
          flush();
        } else {
          visit(n);
        }
      }
    };

    visit(scratch);
    flush();
    scratch.textContent = "";
    return out.join("\n").replace(/^\n+|\n+$/g, "");
  }

  // ------------------------------------------------------------------- ui

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.dataset.theme = "auto";
  root.innerHTML = `
    <button class="ddbn-tab" type="button" aria-expanded="false"
            aria-controls="ddbn-drawer" title="Open notes">
      <span class="ddbn-tab-label">Notes</span>
    </button>

    <aside class="ddbn-drawer" id="ddbn-drawer" role="complementary"
           aria-label="Character notes" hidden>
      <div class="ddbn-grip" role="separator" aria-orientation="vertical"
           aria-label="Resize notes drawer" tabindex="0"></div>

      <header class="ddbn-head">
        <h2 class="ddbn-title"></h2>
        <button class="ddbn-close" type="button" title="Close notes"
                aria-label="Close notes">&times;</button>
      </header>

      <div class="ddbn-toolbar" role="toolbar" aria-label="Markdown">
        <button type="button" data-md="bold" title="Bold: **text** (Ctrl+B)"
                aria-label="Bold"><b>B</b></button>
        <button type="button" data-md="italic" title="Italic: *text* (Ctrl+I)"
                aria-label="Italic"><i>I</i></button>
        <button type="button" data-md="strike" title="Strikethrough: ~~text~~"
                aria-label="Strikethrough"><s>S</s></button>
        <button type="button" data-md="heading" title="Heading: # to ###, click again to step down"
                aria-label="Heading">H</button>
        <span class="ddbn-sep" aria-hidden="true"></span>
        <button type="button" data-md="bullet" title="Bulleted list: - item"
                aria-label="Bulleted list">&bull;&nbsp;&mdash;</button>
        <button type="button" data-md="number" title="Numbered list: 1. item"
                aria-label="Numbered list">1.&nbsp;&mdash;</button>
        <button type="button" data-md="task" title="Checklist: - [ ] item (Ctrl+Enter ticks)"
                aria-label="Checklist">&#9744;</button>
        <button class="ddbn-split-toggle" type="button" aria-pressed="false"
                title="Split the drawer into two sections">Split</button>
      </div>

      <div class="ddbn-panes"></div>

      <footer class="ddbn-foot">
        <span class="ddbn-status" role="status" aria-live="polite"></span>
        <button class="ddbn-theme-toggle" type="button"
                title="Theme">Auto</button>
        <button class="ddbn-push-toggle" type="button" aria-pressed="true"
                title="Push the page aside instead of covering it">Push</button>
      </footer>
    </aside>
  `;
  document.documentElement.appendChild(root);

  const tab = root.querySelector(".ddbn-tab");
  const drawer = root.querySelector(".ddbn-drawer");
  const grip = root.querySelector(".ddbn-grip");
  const title = root.querySelector(".ddbn-title");
  const closeBtn = root.querySelector(".ddbn-close");
  const toolbar = root.querySelector(".ddbn-toolbar");
  const splitBtn = root.querySelector(".ddbn-split-toggle");
  const panes = root.querySelector(".ddbn-panes");
  const themeBtn = root.querySelector(".ddbn-theme-toggle");
  const pushBtn = root.querySelector(".ddbn-push-toggle");
  const status = root.querySelector(".ddbn-status");

  const htmlEl = document.documentElement;
  const rootStyle = root.style;
  const htmlStyle = htmlEl.style;

  // ------------------------------------------------------------------ panes

  const freshHistory = (text) => ({ stack: [text], index: 0, kind: "", at: 0, start: 0 });

  // Two identical stacked editors, each with its own strip of tabs, so the
  // drawer's height can carry reference notes above working notes.
  function buildPane(key, label) {
    const el = document.createElement("div");
    const watch = new MutationObserver(() => {});
    el.className = "ddbn-pane";
    el.dataset.pane = key;
    el.innerHTML = `
      <div class="ddbn-sectionbar">
        <div class="ddbn-sections" role="tablist"
             aria-label="${label} tabs"></div>
        <button class="ddbn-add" type="button" title="New note"
                aria-label="New note">+</button>
        <button class="ddbn-shelf-btn" type="button" aria-haspopup="true"
                aria-expanded="false" title="Closed notes">&#9662;</button>
        <div class="ddbn-shelf" role="menu" aria-label="Closed notes"
             tabindex="-1" hidden></div>
      </div>
      <div class="ddbn-editor" contenteditable="true" role="textbox"
           aria-multiline="true" aria-label="${label} notes"
           data-placeholder="Session notes, loot, NPC names, plans."></div>
    `;
    const editor = el.querySelector(".ddbn-editor");
    watch.observe(editor, { childList: true, characterData: true, subtree: true });
    return {
      key,
      el,
      list: el.querySelector(".ddbn-sections"),
      addBtn: el.querySelector(".ddbn-add"),
      shelfBtn: el.querySelector(".ddbn-shelf-btn"),
      shelf: el.querySelector(".ddbn-shelf"),
      editor,
      activeBtn: null,
      // Records the browser's own edits to the lines paint() drew.
      watch,
      // The source lines currently drawn, one per child of the editor.
      lines: [],
      // Lines showing their raw syntax because the selection touches them.
      activeEls: new Set(),
      hist: freshHistory(""),
    };
  }

  const paneA = buildPane("a", "Top");
  const paneB = buildPane("b", "Bottom");
  const divider = document.createElement("div");
  divider.className = "ddbn-hsplit";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "horizontal");
  divider.setAttribute("aria-label", "Resize the two note sections");
  divider.tabIndex = 0;

  panes.append(paneA.el, divider, paneB.el);
  const allPanes = [paneA, paneB];
  const other = (pane) => (pane === paneA ? paneB : paneA);

  // -------------------------------------------------------- document model

  // { v, sections: [{ id, name, md, updated }], tabs: { a: [id], b: [id] },
  //   active: { a: id | null, b: id | null }, updated }
  // A note sits on one pane's tab strip at most. One on neither is closed:
  // kept, and listed under the pane's closed-notes menu to reopen.
  let currentId = null;
  let doc = null;
  // Set whenever the model diverges from what is in storage, so the saves
  // fired on blur, on navigation and on tab hide cost nothing when there is
  // no actual change behind them.
  let dirty = false;

  const newSection = (name = "Section") => ({
    id: uid(),
    name,
    md: "",
    updated: Date.now(),
  });

  function emptyDoc() {
    const s = newSection("General");
    return {
      v: SCHEMA,
      sections: [s],
      tabs: { a: [s.id], b: [] },
      active: { a: s.id, b: null },
      updated: 0,
    };
  }

  // v1 was one { html, updated }; v2 added sections with a single activeId;
  // v3 split the active section per pane. Up to v3 notes were HTML, and v4
  // stores Markdown, so older markup is converted on the way in. v5 gave
  // each pane its own tabs. Nothing written before an upgrade is stranded.
  function migrate(saved, split) {
    if (!saved || typeof saved !== "object") return emptyDoc();

    let sections = null;

    if (Array.isArray(saved.sections) && saved.sections.length) {
      sections = saved.sections
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          id: typeof s.id === "string" && s.id ? s.id : uid(),
          name: String(s.name || "Section").slice(0, 60),
          md:
            typeof s.md === "string" ? s.md
            : typeof s.html === "string" ? htmlToMd(s.html)
            : "",
          updated: Number(s.updated) || Date.now(),
        }));
    } else if (typeof saved.html === "string") {
      const s = newSection("General");
      s.md = htmlToMd(saved.html);
      s.updated = Number(saved.updated) || Date.now();
      sections = [s];
    }

    if (!sections || !sections.length) return emptyDoc();

    const ids = new Set(sections.map((s) => s.id));
    const wantA = saved.active ? saved.active.a : saved.activeId;
    const wantB = saved.active ? saved.active.b : null;
    let tabs;

    if (saved.tabs && Array.isArray(saved.tabs.a) && Array.isArray(saved.tabs.b)) {
      const seen = new Set();
      const keep = (list) => list.filter((id) => ids.has(id) && !seen.has(id) && seen.add(id));
      tabs = { a: keep(saved.tabs.a), b: keep(saved.tabs.b) };
    } else {
      // Both strips used to list every section. Everything lands on top,
      // except that a sheet that is split right now keeps its bottom note.
      const b = split && ids.has(wantB) && wantB !== wantA ? [wantB] : [];
      tabs = { a: sections.map((s) => s.id).filter((id) => !b.includes(id)), b };
    }

    const pick = (list, want) => (list.includes(want) ? want : list[0] || null);

    return {
      v: SCHEMA,
      sections,
      tabs,
      active: { a: pick(tabs.a, wantA), b: pick(tabs.b, wantB) },
      updated: Number(saved.updated) || Date.now(),
    };
  }

  const sectionById = (id) =>
    doc ? doc.sections.find((s) => s.id === id) || null : null;

  const activeSection = (pane) => (doc ? sectionById(doc.active[pane.key]) : null);

  const isOpenAnywhere = (id) => doc.tabs.a.includes(id) || doc.tabs.b.includes(id);
  const closedSections = () =>
    doc ? doc.sections.filter((s) => !isOpenAnywhere(s.id)) : [];

  // ------------------------------------------------------------- open state

  let isOpen = false;

  function setOpen(open, persist = true) {
    isOpen = open;
    root.classList.toggle("is-open", open);
    drawer.hidden = !open;
    tab.setAttribute("aria-expanded", String(open));
    tab.title = open ? "Close notes" : "Open notes";
    if (persist) store.set(UI_OPEN, open);
    if (!open) closeShelf();
    syncPush();
    if (open) {
      // Tab strips rendered while the drawer was closed skip the scroll, so
      // catch up on the way in.
      for (const p of allPanes) revealActive(p);
      focusPane(lastFocused);
    }
  }

  tab.addEventListener("click", () => setOpen(!isOpen));
  closeBtn.addEventListener("click", () => {
    setOpen(false);
    tab.focus();
  });

  // Scoped to the drawer rather than the document: the page's own keystrokes
  // never reach this handler at all.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shelfPane) {
      const back = shelfPane.shelfBtn;
      closeShelf();
      back.focus();
    } else if (e.key === "Escape" && isOpen && drawer.contains(e.target)) {
      setOpen(false);
      tab.focus();
    }
  });

  // ----------------------------------------------------------------- theme

  // Stored as auto | light | dark; "auto" is resolved by a
  // prefers-color-scheme rule in the stylesheet rather than here.
  let theme = "auto";

  function syncTheme() {
    root.dataset.theme = theme;
    themeBtn.textContent = theme[0].toUpperCase() + theme.slice(1);
    themeBtn.title =
      theme === "auto"
        ? "Theme: follows your system. Click for light."
        : theme === "light"
        ? "Theme: light. Click for dark."
        : "Theme: dark. Click to follow your system.";
  }

  themeBtn.addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set(UI_THEME, theme);
    syncTheme();
  });

  // ------------------------------------------------------------- push mode

  // Push narrows the document itself instead of floating over it, so the
  // page's own flex layout reflows into whatever space is left.
  let pushEnabled = true;

  function syncPush() {
    const on = pushEnabled && isOpen && !root.hidden;

    // Containment pulls the page's own position:fixed chrome in with the
    // push, but it would collapse a body that does not stand on its own
    // height. Measure before the push so the reading is unaffected.
    if (on && !htmlEl.classList.contains("ddbn-contain")) {
      const h = document.body ? document.body.getBoundingClientRect().height : 0;
      htmlEl.classList.toggle("ddbn-contain", h >= window.innerHeight * 0.9);
    } else if (!on) {
      htmlEl.classList.remove("ddbn-contain");
    }

    htmlEl.classList.toggle("ddbn-pushed", on);
    pushBtn.setAttribute("aria-pressed", String(pushEnabled));
    pushBtn.classList.toggle("is-active", pushEnabled);
    pushBtn.title = pushEnabled
      ? "Push mode on: the page reflows beside the drawer"
      : "Overlay mode: the drawer floats over the page";
    notifyResize();
  }

  // Layouts driven by JS rather than CSS only recompute on a resize event.
  let resizeTimer = 0;
  function notifyResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 240);
  }

  pushBtn.addEventListener("click", () => {
    pushEnabled = !pushEnabled;
    store.set(UI_PUSH, pushEnabled);
    syncPush();
  });

  // ----------------------------------------------------------- width resize

  // The live width is kept here rather than read back out of the computed
  // style, so nothing in the resize or drag path forces a style recalc.
  let width = 0;

  function applyWidth(px) {
    const cap = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.7))
    );
    const w = Math.min(cap, Math.max(MIN_WIDTH, Math.round(px)));
    if (w !== width) {
      width = w;
      htmlStyle.setProperty("--ddbn-width", `${w}px`);
    }
    return w;
  }

  let dragging = false;
  let dragX = 0;
  let dragFrame = 0;

  // Pointer events outrun paint, so the width lands once per frame.
  function dragStep() {
    dragFrame = 0;
    applyWidth(window.innerWidth - dragX);
  }

  function endWidthDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    // Land the last move that was still waiting on a frame.
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragStep();
    }
    document.body.style.userSelect = "";
    store.set(UI_WIDTH, width);
    notifyResize();
  }

  grip.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragX = e.clientX;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  });

  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dragX = e.clientX;
    if (!dragFrame) dragFrame = requestAnimationFrame(dragStep);
  });

  grip.addEventListener("pointerup", endWidthDrag);
  grip.addEventListener("pointercancel", endWidthDrag);

  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 12;
    if (e.key === "ArrowLeft") applyWidth(width + step);
    else if (e.key === "ArrowRight") applyWidth(width - step);
    else return;
    e.preventDefault();
    store.set(UI_WIDTH, width);
    notifyResize();
  });

  window.addEventListener("resize", () => {
    // Re-clamp against the new viewport, but never fight an active drag.
    if (!dragging) applyWidth(width);
  });

  // ------------------------------------------------------------ split view

  let splitOn = false;
  let ratio = 0;

  function applyRatio(r) {
    const next = Math.min(0.85, Math.max(0.15, r));
    if (next !== ratio) {
      ratio = next;
      rootStyle.setProperty("--ddbn-split", `${(next * 100).toFixed(2)}%`);
    }
    return ratio;
  }

  // Splitting sends the highlighted top tab down to a pane of its own.
  // Unsplitting folds the bottom tabs back onto the top strip, so tabs.b is
  // only ever non-empty while the split is on.
  function setSplit(on, persist = true) {
    // Flush while the old state still stands: once splitOn flips, the
    // bottom pane counts as hidden and its edits stop being collected.
    if (doc) flushAll();

    if (doc && on && !splitOn) {
      const id = doc.active.a;
      // The top would be left with nothing to show.
      if (!id || doc.tabs.a.length < 2) return;
      dropTab(paneA, id);
      doc.tabs.b.push(id);
      doc.active.b = id;
      dirty = true;
    } else if (doc && !on && doc.tabs.b.length) {
      for (const id of doc.tabs.b) if (!doc.tabs.a.includes(id)) doc.tabs.a.push(id);
      if (!doc.active.a) doc.active.a = doc.active.b;
      doc.tabs.b = [];
      doc.active.b = null;
      dirty = true;
    }

    splitOn = on;
    root.classList.toggle("is-split", on);
    splitBtn.setAttribute("aria-pressed", String(on));
    splitBtn.classList.toggle("is-active", on);
    if (persist) store.set(UI_SPLIT, on);

    if (doc) {
      showActive(paneA);
      showActive(paneB);
      if (persist && dirty) save();
    }
    renderTabs();
    if (!on && lastFocused === paneB) focusPane(paneA, false);
    if (on && persist) focusPane(paneB);
  }

  // Two panes only while both have a tab. When either runs out, closed or
  // dragged away, the drawer goes back to one pane holding what is left.
  function settle() {
    if (!doc) return;
    if (splitOn && !(doc.tabs.a.length && doc.tabs.b.length)) setSplit(false);
    else if (!splitOn && doc.tabs.b.length) setSplit(false, false);
  }

  function syncSplitBtn() {
    const can = splitOn || Boolean(doc && doc.tabs.a.length > 1);
    splitBtn.disabled = !can;
    splitBtn.title = splitOn
      ? "Back to one pane (the bottom tabs move up)"
      : can
      ? "Move this tab to a pane of its own below"
      : "Open a second tab to split";
  }

  splitBtn.addEventListener("click", () => setSplit(!splitOn));

  let dividerDrag = false;
  let dividerTop = 0;
  let dividerHeight = 0;
  let dividerY = 0;
  let ratioFrame = 0;

  function ratioStep() {
    ratioFrame = 0;
    applyRatio((dividerY - dividerTop) / dividerHeight);
  }

  function endRatioDrag(e) {
    if (!dividerDrag) return;
    dividerDrag = false;
    if (divider.hasPointerCapture(e.pointerId)) {
      divider.releasePointerCapture(e.pointerId);
    }
    if (ratioFrame) {
      cancelAnimationFrame(ratioFrame);
      ratioStep();
    }
    document.body.style.userSelect = "";
    root.classList.remove("is-hdragging");
    store.set(UI_RATIO, ratio);
  }

  divider.addEventListener("pointerdown", (e) => {
    // The pane column cannot change size mid-drag, so one measurement is
    // enough; reading it per move was a forced layout on every event.
    const box = panes.getBoundingClientRect();
    if (box.height <= 0) return;
    dividerTop = box.top;
    dividerHeight = box.height;
    dividerY = e.clientY;
    dividerDrag = true;
    divider.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    root.classList.add("is-hdragging");
  });

  divider.addEventListener("pointermove", (e) => {
    if (!dividerDrag) return;
    dividerY = e.clientY;
    if (!ratioFrame) ratioFrame = requestAnimationFrame(ratioStep);
  });

  divider.addEventListener("pointerup", endRatioDrag);
  divider.addEventListener("pointercancel", endRatioDrag);

  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    if (e.key === "ArrowUp") applyRatio(ratio - step);
    else if (e.key === "ArrowDown") applyRatio(ratio + step);
    else return;
    e.preventDefault();
    store.set(UI_RATIO, ratio);
  });

  // -------------------------------------------------------------- sections

  function revealActive(pane) {
    if (pane.activeBtn) {
      pane.activeBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function renderSections(pane) {
    pane.activeBtn = null;
    const frag = document.createDocumentFragment();

    for (const id of doc ? doc.tabs[pane.key] : []) {
      const s = sectionById(id);
      if (!s) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddbn-sec";
      btn.dataset.id = s.id;
      btn.setAttribute("role", "tab");
      const active = s.id === doc.active[pane.key];
      btn.setAttribute("aria-selected", String(active));
      btn.draggable = true;
      btn.title = active
        ? `${s.name} — double-click to rename, drag to move`
        : `${s.name} — drag to move`;

      const name = document.createElement("span");
      name.className = "ddbn-sec-name";
      name.textContent = s.name;
      btn.appendChild(name);

      if (active) {
        btn.classList.add("is-active");
        pane.activeBtn = btn;
        const close = document.createElement("span");
        close.className = "ddbn-sec-close";
        close.dataset.close = s.id;
        close.setAttribute("role", "button");
        close.setAttribute("aria-label", `Close tab ${s.name}`);
        close.title = "Close tab. The note is kept and can be reopened from the ▾ list.";
        close.textContent = "×";
        btn.appendChild(close);
      }

      frag.appendChild(btn);
    }

    pane.list.replaceChildren(frag);

    const closed = closedSections().length;
    pane.shelfBtn.textContent = closed ? `▾ ${closed}` : "▾";
    pane.shelfBtn.title = closed
      ? `${closed} closed note${closed === 1 ? "" : "s"}. Click to reopen one.`
      : "Closed notes";
    pane.shelfBtn.setAttribute("aria-label", pane.shelfBtn.title);

    // Scrolling a closed drawer into view is a forced layout for nothing;
    // setOpen replays it.
    if (isOpen) revealActive(pane);
  }

  // The closed-note count shows on both strips, so both redraw together.
  function renderTabs() {
    renderSections(paneA);
    renderSections(paneB);
    syncSplitBtn();
  }

  function flushPane(pane) {
    if (!splitOn && pane === paneB) return;
    const s = activeSection(pane);
    if (!s) return;
    const md = serialize(pane.editor, []).text;
    if (md !== s.md) {
      s.md = md;
      s.updated = Date.now();
      dirty = true;
    }
  }

  function flushAll() {
    flushPane(paneA);
    flushPane(paneB);
  }

  function updatePlaceholder(pane) {
    const s = activeSection(pane);
    pane.editor.dataset.placeholder = s
      ? `Notes for ${s.name}. Type Markdown: # heading, **bold**, - list, - [ ] task.`
      : "No note open here. Start typing to make one, or reopen one from the ▾ list.";
  }

  function showActive(pane) {
    const s = activeSection(pane);
    const md = s ? s.md : "";
    paint(pane, md, null);
    pane.hist = freshHistory(md);
    updatePlaceholder(pane);
  }

  // Takes a note off a pane's strip. If it was showing, the tab to its left
  // (or right) takes over, or the pane is left empty.
  function dropTab(pane, id) {
    const list = doc.tabs[pane.key];
    const i = list.indexOf(id);
    if (i < 0) return;
    list.splice(i, 1);
    if (doc.active[pane.key] === id) doc.active[pane.key] = list[Math.max(0, i - 1)] ?? null;
  }

  // Shows a note in this pane, adding it to the strip if it is not there.
  // One the other pane holds moves over, since a note sits on one strip
  // at most. Callers flush first.
  function openHere(pane, id) {
    const twin = other(pane);
    const was = doc.active[twin.key];
    dropTab(twin, id);
    if (doc.active[twin.key] !== was) showActive(twin);

    const list = doc.tabs[pane.key];
    if (!list.includes(id)) list.push(id);
    doc.active[pane.key] = id;
    dirty = true;
    showActive(pane);
    settle();
    renderTabs();
    save();
    focusPane(pane);
  }

  // Drag and drop: `index` is the slot on the target strip, counted before
  // the dragged tab leaves its own. A tab dropped on the other pane is shown
  // there; one reordered within its strip leaves the view alone.
  function moveTab(from, id, to, index) {
    if (!doc) return;
    const src = doc.tabs[from.key];
    const i = src.indexOf(id);
    if (i < 0) return;
    flushAll();

    if (from === to) {
      const at = index > i ? index - 1 : index;
      if (at === i) return;
      src.splice(i, 1);
      src.splice(at, 0, id);
    } else {
      const was = doc.active[from.key];
      dropTab(from, id);
      doc.tabs[to.key].splice(Math.min(index, doc.tabs[to.key].length), 0, id);
      doc.active[to.key] = id;
      if (doc.active[from.key] !== was) showActive(from);
      showActive(to);
      settle();
      focusPane(to);
    }
    dirty = true;
    renderTabs();
    save();
  }

  function selectSection(pane, id) {
    if (!doc || id === doc.active[pane.key]) return;
    flushAll();
    openHere(pane, id);
  }

  // A named section comes from following a [[link]] to one that does not
  // exist yet, so it opens ready to write in rather than to rename.
  function addSection(pane, name) {
    if (!doc) return;
    flushAll();
    const s = newSection(name || `Section ${doc.sections.length + 1}`);
    doc.sections.push(s);
    doc.tabs[pane.key].push(s.id);
    doc.active[pane.key] = s.id;
    dirty = true;
    showActive(pane);
    renderTabs();
    save();
    if (name) focusPane(pane);
    else if (pane.activeBtn) beginRename(pane.activeBtn.firstElementChild);
  }

  // Typing into a pane with nothing open starts a new note there. The text
  // itself is collected by the next flush, like any other edit.
  function claim(pane) {
    if (!doc || activeSection(pane)) return;
    const s = newSection(`Section ${doc.sections.length + 1}`);
    doc.sections.push(s);
    doc.tabs[pane.key].push(s.id);
    doc.active[pane.key] = s.id;
    dirty = true;
    renderTabs();
    updatePlaceholder(pane);
  }

  // Names the extension hands out on its own; a blank note still wearing
  // one was never used, so closing it drops it instead of keeping it.
  const UNTOUCHED = /^(General|Section \d+)$/;

  // Closing only takes the tab away. The note stays in the document and is
  // listed under the ▾ menu until it is reopened or deleted there.
  function closeTab(pane, id) {
    if (!doc) return;
    flushAll();
    const s = sectionById(id);
    if (!s) return;
    dropTab(pane, id);
    if (!s.md.trim() && UNTOUCHED.test(s.name)) {
      doc.sections.splice(doc.sections.indexOf(s), 1);
    }
    dirty = true;
    showActive(pane);
    settle();
    renderTabs();
    save();
  }

  function deleteForever(id) {
    const s = sectionById(id);
    if (!s) return false;
    if (s.md.trim() && !confirm(`Delete "${s.name}" and its notes for good?`)) return false;
    for (const p of allPanes) dropTab(p, id);
    doc.sections.splice(doc.sections.indexOf(s), 1);
    dirty = true;
    renderTabs();
    save();
    return true;
  }

  // ------------------------------------------------------- closed notes

  let shelfPane = null;

  // First words of a note, for telling closed notes apart by more than name.
  const preview = (md) =>
    (md.split("\n").find((l) => l.trim()) || "")
      .replace(/^[\s#>*+-]*(\[[ xX]\]\s*)?/, "")
      .slice(0, 60);

  function shelfRow(s, deletable) {
    const row = document.createElement("div");
    row.className = "ddbn-shelf-row";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "ddbn-shelf-open";
    open.dataset.open = s.id;
    open.setAttribute("role", "menuitem");
    open.title = `Open "${s.name}" in this pane`;
    const name = document.createElement("span");
    name.className = "ddbn-shelf-name";
    name.textContent = s.name;
    const meta = document.createElement("span");
    meta.className = "ddbn-shelf-meta";
    const words = preview(s.md);
    meta.textContent = new Date(s.updated).toLocaleDateString() + (words ? ` · ${words}` : "");
    open.append(name, meta);
    row.appendChild(open);

    if (deletable) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ddbn-shelf-del";
      del.dataset.drop = s.id;
      del.title = `Delete "${s.name}" for good`;
      del.setAttribute("aria-label", del.title);
      del.textContent = "×";
      row.appendChild(del);
    }
    return row;
  }

  // Lists the closed notes, newest first, and under them whatever the other
  // pane has open, so a note can be moved across (or reached at all while
  // the bottom pane is hidden).
  function openShelf(pane) {
    closeShelf();
    if (!doc) return;
    flushAll();
    shelfPane = pane;

    const frag = document.createDocumentFragment();
    const group = (label, list, deletable) => {
      if (!list.length) return;
      const head = document.createElement("div");
      head.className = "ddbn-shelf-head";
      head.textContent = label;
      frag.appendChild(head);
      for (const s of list) frag.appendChild(shelfRow(s, deletable));
    };

    const twin = other(pane);
    const where = twin === paneB ? "bottom" : "top";
    group("Closed notes", closedSections().sort((a, b) => b.updated - a.updated), true);
    group(
      `Open in the ${where} pane`,
      doc.tabs[twin.key].map(sectionById).filter(Boolean),
      false
    );
    if (!frag.childNodes.length) {
      const empty = document.createElement("div");
      empty.className = "ddbn-shelf-empty";
      empty.textContent = "Nothing here yet. Closing a tab keeps its note in this list.";
      frag.appendChild(empty);
    }

    pane.shelf.replaceChildren(frag);
    pane.shelf.hidden = false;
    pane.shelfBtn.setAttribute("aria-expanded", "true");
    // Focus stays inside the menu, even when it holds no buttons, so Escape
    // still reaches it.
    (pane.shelf.querySelector("button") || pane.shelf).focus({ preventScroll: true });
  }

  function closeShelf() {
    if (!shelfPane) return;
    shelfPane.shelf.hidden = true;
    shelfPane.shelf.replaceChildren();
    shelfPane.shelfBtn.setAttribute("aria-expanded", "false");
    shelfPane = null;
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!shelfPane) return;
      if (shelfPane.shelf.contains(e.target) || shelfPane.shelfBtn.contains(e.target)) return;
      closeShelf();
    },
    true
  );

  // Rename in place: the label itself becomes editable on double-click.
  let renaming = null;

  function beginRename(nameEl) {
    if (renaming || !nameEl) return;
    const btn = nameEl.closest(".ddbn-sec");
    if (!btn) return;
    renaming = btn.dataset.id;

    nameEl.contentEditable = "true";
    nameEl.classList.add("is-editing");
    nameEl.focus();

    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = (keep) => {
      nameEl.removeEventListener("keydown", onKey);
      nameEl.removeEventListener("blur", onBlur);
      nameEl.contentEditable = "false";
      nameEl.classList.remove("is-editing");
      const id = renaming;
      renaming = null;

      const s = sectionById(id);
      if (!s) return;
      const next = nameEl.textContent.trim().slice(0, 60);
      if (keep && next && next !== s.name) {
        s.name = next;
        s.updated = Date.now();
        dirty = true;
        save();
      }
      renderTabs();
      // Only the label changed, so leave the editors' contents alone.
      for (const p of allPanes) {
        if (doc && doc.active[p.key] === id) updatePlaceholder(p);
      }
    };

    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    };
    const onBlur = () => commit(true);

    nameEl.addEventListener("keydown", onKey);
    nameEl.addEventListener("blur", onBlur);
  }

  // ------------------------------------------------------------ tab drag

  // The tab travels under a type of its own, so no text editor (the notes
  // included) will take it as a drop.
  const TAB_TYPE = "application/x-quill20-tab";
  let tabDrag = null;

  // Slot on the pane's strip under the pointer; anywhere below the strip,
  // over the note itself, means the end of it.
  function dropIndex(pane, e) {
    const btns = pane.list.querySelectorAll(".ddbn-sec");
    const bar = pane.list.getBoundingClientRect();
    if (e.clientY > bar.bottom) return btns.length;
    for (let i = 0; i < btns.length; i++) {
      const r = btns[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return i;
    }
    return btns.length;
  }

  function clearDropMark() {
    for (const p of allPanes) {
      p.el.classList.remove("is-drop-target");
      for (const b of p.list.querySelectorAll(".is-drop-before, .is-drop-after")) {
        b.classList.remove("is-drop-before", "is-drop-after");
      }
    }
  }

  function showDropMark(pane, index) {
    clearDropMark();
    pane.el.classList.add("is-drop-target");
    const btns = pane.list.querySelectorAll(".ddbn-sec");
    if (index < btns.length) btns[index].classList.add("is-drop-before");
    else if (btns.length) btns[btns.length - 1].classList.add("is-drop-after");
  }

  document.addEventListener("dragend", () => {
    if (!tabDrag) return;
    tabDrag.btn.classList.remove("is-dragging");
    tabDrag = null;
    clearDropMark();
  });

  for (const pane of allPanes) {
    pane.addBtn.addEventListener("click", () => addSection(pane));

    pane.list.addEventListener("dragstart", (e) => {
      const btn = e.target.closest?.(".ddbn-sec");
      if (!btn || renaming) {
        e.preventDefault();
        return;
      }
      closeShelf();
      tabDrag = { from: pane, id: btn.dataset.id, btn };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(TAB_TYPE, btn.dataset.id);
      btn.classList.add("is-dragging");
    });

    // The whole pane takes the drop, so a tab can be let go over the other
    // pane's note as well as its strip.
    pane.el.addEventListener("dragover", (e) => {
      if (!tabDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      showDropMark(pane, dropIndex(pane, e));
    });

    pane.el.addEventListener("dragleave", (e) => {
      if (tabDrag && !pane.el.contains(e.relatedTarget)) clearDropMark();
    });

    pane.el.addEventListener("drop", (e) => {
      if (!tabDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const { from, id } = tabDrag;
      const index = dropIndex(pane, e);
      clearDropMark();
      moveTab(from, id, pane, index);
    });

    pane.shelfBtn.addEventListener("click", () => {
      if (shelfPane === pane) closeShelf();
      else openShelf(pane);
    });

    pane.shelf.addEventListener("click", (e) => {
      const drop = e.target.closest("[data-drop]");
      if (drop) {
        // Redraw the list in place so several can go in a row.
        if (deleteForever(drop.dataset.drop)) openShelf(pane);
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        closeShelf();
        selectSection(pane, open.dataset.open);
      }
    });

    pane.list.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) {
        e.stopPropagation();
        closeTab(pane, close.dataset.close);
        return;
      }
      const btn = e.target.closest(".ddbn-sec");
      if (btn && !renaming) selectSection(pane, btn.dataset.id);
    });

    pane.list.addEventListener("dblclick", (e) => {
      const btn = e.target.closest(".ddbn-sec");
      if (!btn || !doc || btn.dataset.id !== doc.active[pane.key]) return;
      e.preventDefault();
      beginRename(btn.querySelector(".ddbn-sec-name"));
    });

    // The strip scrolls sideways; a plain wheel should move it.
    pane.list.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY === 0) return;
        if (pane.list.scrollWidth <= pane.list.clientWidth) return;
        e.preventDefault();
        pane.list.scrollLeft += e.deltaY;
      },
      { passive: false }
    );

    const ed = pane.editor;
    ed.addEventListener("beforeinput", (e) => onBeforeInput(pane, e));
    ed.addEventListener("input", (e) => {
      if (!e.isComposing) refresh(pane, TYPING.has(e.inputType) ? "type" : "edit");
    });
    ed.addEventListener("compositionend", () => refresh(pane, "type"));
    ed.addEventListener("keydown", (e) => onEditorKey(pane, e));
    ed.addEventListener("mousedown", (e) => onEditorPointer(pane, e));
    ed.addEventListener("copy", (e) => onCopy(pane, e, false));
    ed.addEventListener("cut", (e) => onCopy(pane, e, true));
    ed.addEventListener("paste", (e) => onPaste(pane, e));
    ed.addEventListener("focus", () => {
      markFocus(pane);
      syncActive(pane);
    });
    ed.addEventListener("blur", () => {
      syncActive(pane);
      clearTimeout(saveTimer);
      save();
    });
  }

  // ------------------------------------------------------ live preview

  // Reads the editor back into source text. The browser's own edits can
  // leave any shape behind (merged lines, stray text at the top level, a
  // placeholder <br>), so this walks blocks and breaks generically rather
  // than trusting the one-div-per-line layout that paint() writes. Each
  // { node, offset } in `points` comes back as an offset into the text.
  function serialize(ed, points) {
    const at = points.map(() => -1);
    let done = "";
    let line = "";
    let open = false;

    const flush = () => {
      done += `${line}\n`;
      line = "";
      open = false;
    };
    const pin = (node, i) => {
      for (let k = 0; k < points.length; k++) {
        if (at[k] < 0 && points[k].node === node && points[k].offset === i) {
          at[k] = done.length + line.length;
        }
      }
    };

    const visit = (parent) => {
      let i = 0;
      for (let n = parent.firstChild; n; n = n.nextSibling, i++) {
        pin(parent, i);
        if (n.nodeType === Node.TEXT_NODE) {
          for (let k = 0; k < points.length; k++) {
            if (at[k] < 0 && points[k].node === n) {
              at[k] = done.length + line.length + Math.min(points[k].offset, n.length);
            }
          }
          if (n.length) {
            line += n.nodeValue;
            open = true;
          }
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.tagName === "BR") {
            if (n.nextSibling || parent === ed || !BLOCKS.has(parent.tagName)) flush();
            else open = true;
          } else if (BLOCKS.has(n.tagName)) {
            if (open) flush();
            const before = done.length;
            visit(n);
            if (open || done.length === before) flush();
          } else {
            visit(n);
          }
        }
      }
      pin(parent, i);
    };

    visit(ed);
    if (open) flush();
    const text = done.slice(0, -1).replace(/ /g, " ");
    return { text, at: at.map((a) => (a < 0 ? text.length : Math.min(a, text.length))) };
  }

  function readEditor(pane) {
    const ed = pane.editor;
    const s = window.getSelection();
    let points = [];
    if (s.rangeCount) {
      const r = s.getRangeAt(0);
      if (ed.contains(r.startContainer) && ed.contains(r.endContainer)) {
        points = [
          { node: r.startContainer, offset: r.startOffset },
          { node: r.endContainer, offset: r.endOffset },
        ];
      }
    }
    const { text, at } = serialize(ed, points);
    return { text, sel: points.length ? { start: at[0], end: at[1] } : null };
  }

  function lineAt(lines, offset) {
    let i = 0;
    let rest = offset;
    while (i < lines.length - 1 && rest > lines[i].length) {
      rest -= lines[i].length + 1;
      i++;
    }
    return [i, Math.min(rest, lines[i] ? lines[i].length : 0)];
  }

  function domPoint(pane, offset) {
    const ed = pane.editor;
    if (!pane.lines.length) return [ed, 0];
    const [i, col] = lineAt(pane.lines, offset);
    const el = ed.children[i];
    if (!el) return [ed, ed.childNodes.length];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = col;
    let last = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (left <= n.length) return [n, left];
      left -= n.length;
      last = n;
    }
    return last ? [last, last.length] : [el, 0];
  }

  function setSel(pane, sel) {
    const [an, ao] = domPoint(pane, sel.start);
    const [fn, fo] = sel.end === sel.start ? [an, ao] : domPoint(pane, sel.end);
    window.getSelection().setBaseAndExtent(an, ao, fn, fo);
  }

  // A line can be kept if it was drawn from the same markup and the browser
  // has not edited it since. Edits are picked up from the pane's observer
  // synchronously, so they are current inside the input handler.
  // An edited line still survives when the edit left exactly the markup a
  // fresh render would produce, which is what typing plain text does.
  function fits(node, row) {
    if (node.nodeType !== Node.ELEMENT_NODE || node._cls !== row.cls) return false;
    if (!node._edited) return node._html === row.html;
    if (node.innerHTML !== row.html) return false;
    node._edited = false;
    node._html = row.html;
    return true;
  }

  function markEdited(pane) {
    const ed = pane.editor;
    for (const rec of pane.watch.takeRecords()) {
      let node = rec.target;
      while (node && node.parentNode !== ed) node = node.parentNode;
      if (node) node._edited = true;
    }
  }

  function makeLine(row) {
    const el = document.createElement("div");
    el.className = row.cls ? `md-line ${row.cls}` : "md-line";
    el._cls = row.cls;
    el._html = row.html;
    el.innerHTML = row.html;
    return el;
  }

  // Draws `text` into the editor. Lines that already match are left alone,
  // matched from both ends, so a keystroke usually swaps out one line and
  // typing into plain text swaps out none. The selection is only put back
  // when something under it was replaced, or when `force` asks for it.
  function paint(pane, text, sel, force = false) {
    const ed = pane.editor;
    const lines = text ? text.split("\n") : [];
    const rows = renderAll(lines);
    markEdited(pane);
    const kids = Array.from(ed.childNodes);
    const max = Math.min(kids.length, rows.length);

    let head = 0;
    while (head < max && fits(kids[head], rows[head])) head++;
    let tail = 0;
    while (
      tail < max - head &&
      fits(kids[kids.length - 1 - tail], rows[rows.length - 1 - tail])
    ) {
      tail++;
    }

    const changed = head < kids.length - tail || head < rows.length - tail;
    if (changed) {
      const ref = tail ? kids[kids.length - tail] : null;
      for (let i = head; i < kids.length - tail; i++) kids[i].remove();
      const frag = document.createDocumentFragment();
      for (let i = head; i < rows.length - tail; i++) frag.appendChild(makeLine(rows[i]));
      ed.insertBefore(frag, ref);
      // Those were this script's own mutations, not the browser's.
      pane.watch.takeRecords();
    }

    pane.lines = lines;
    if (sel && (changed || force)) setSel(pane, sel);
    syncActive(pane);
  }

  function topLine(ed, node, offset) {
    if (node === ed) {
      const kids = ed.children;
      return kids.length ? kids[Math.min(offset, kids.length - 1)] : null;
    }
    while (node && node.parentNode !== ed) node = node.parentNode;
    return node && node.nodeType === Node.ELEMENT_NODE ? node : null;
  }

  // Lines the selection touches show their raw syntax. A table opens as a
  // whole, since one row dropping out of the grid would reflow the rest.
  function syncActive(pane) {
    const ed = pane.editor;
    const next = new Set();
    const s = window.getSelection();
    if (document.activeElement === ed && s.rangeCount) {
      const r = s.getRangeAt(0);
      let first = topLine(ed, r.startContainer, r.startOffset);
      let last = topLine(ed, r.endContainer, r.endOffset);
      if (first && last) {
        while (
          first.classList.contains("md-t") &&
          first.previousElementSibling?.classList.contains("md-t")
        ) {
          first = first.previousElementSibling;
        }
        while (
          last.classList.contains("md-t") &&
          last.nextElementSibling?.classList.contains("md-t")
        ) {
          last = last.nextElementSibling;
        }
        for (let el = first; el; el = el.nextElementSibling) {
          next.add(el);
          if (el === last) break;
        }
      }
    }
    for (const el of pane.activeEls) if (!next.has(el)) el.classList.remove("is-active");
    for (const el of next) el.classList.add("is-active");
    pane.activeEls = next;
  }

  document.addEventListener("selectionchange", () => {
    for (const p of allPanes) {
      if (p.activeEls.size || document.activeElement === p.editor) syncActive(p);
    }
  });

  // Keeps the caret's line in view after an edit this script made itself;
  // the browser only does that for its own.
  function reveal(pane, offset) {
    const el = pane.editor.children[lineAt(pane.lines, offset)[0]];
    if (!el) return;
    const box = pane.editor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.bottom > box.bottom) pane.editor.scrollTop += r.bottom - box.bottom;
    else if (r.top < box.top) pane.editor.scrollTop -= box.top - r.top;
  }

  // --------------------------------------------------------------- history

  // Every repaint rewrites DOM the browser's own undo stack was tracking, so
  // undo is kept here as snapshots of the source instead. A run of typing
  // folds into one step.
  const TYPING = new Set(["insertText", "deleteContentBackward", "deleteContentForward"]);

  function record(pane, text, kind) {
    const h = pane.hist;
    if (h.stack[h.index] === text) return;
    const now = Date.now();
    h.stack.length = h.index + 1;
    if (
      kind === "type" && h.kind === "type" && h.index > 0 &&
      now - h.at < 1000 && now - h.start < 5000
    ) {
      h.stack[h.index] = text;
    } else {
      h.stack.push(text);
      if (h.stack.length > HISTORY) h.stack.shift();
      else h.index++;
      h.start = now;
    }
    h.kind = kind;
    h.at = now;
  }

  // The caret goes to the end of whatever the step changed.
  function diffCaret(from, to) {
    const max = Math.min(from.length, to.length);
    let p = 0;
    while (p < max && from[p] === to[p]) p++;
    let q = 0;
    while (q < max - p && from[from.length - 1 - q] === to[to.length - 1 - q]) q++;
    return to.length - q;
  }

  function stepHistory(pane, dir) {
    const h = pane.hist;
    const next = h.stack[h.index + dir];
    if (next === undefined) return;
    const caret = diffCaret(serialize(pane.editor, []).text, next);
    h.index += dir;
    h.kind = "";
    paint(pane, next, { start: caret, end: caret }, true);
    reveal(pane, caret);
    scheduleSave();
  }

  // ----------------------------------------------------------------- edits

  const lineStart = (t, i) => (i ? t.lastIndexOf("\n", i - 1) + 1 : 0);
  const lineEnd = (t, i) => {
    const n = t.indexOf("\n", i);
    return n < 0 ? t.length : n;
  };
  const splice = (t, s, e, ins) => ({
    text: t.slice(0, s) + ins + t.slice(e),
    start: s + ins.length,
    end: s + ins.length,
  });

  // Rewrites every line the selection touches with fn, keeping the caret
  // on the same text.
  function mapLines(t, s, e, fn) {
    const ls = lineStart(t, s);
    const le = lineEnd(t, e);
    const olds = t.slice(ls, le).split("\n");
    const news = olds.map((line, i) => fn(line, i, olds));
    const joined = news.join("\n");
    const start = Math.max(ls, s + news[0].length - olds[0].length);
    const end = s === e ? start : Math.max(start, e + joined.length - (le - ls));
    return { text: t.slice(0, ls) + joined + t.slice(le), start, end };
  }

  function refresh(pane, kind) {
    claim(pane);
    const { text, sel } = readEditor(pane);
    paint(pane, text, sel);
    record(pane, text, kind);
    scheduleSave();
  }

  function commit(pane, text, sel, kind) {
    paint(pane, text, sel, Boolean(sel));
    if (sel) reveal(pane, sel.end);
    record(pane, text, kind);
    scheduleSave();
  }

  // Runs fn(text, selStart, selEnd) -> { text, start, end } | null against
  // the editor's current contents.
  function edit(pane, fn, kind = "edit") {
    claim(pane);
    const { text, sel } = readEditor(pane);
    const at = sel || { start: text.length, end: text.length };
    const res = fn(text, at.start, at.end);
    if (res) commit(pane, res.text, { start: res.start, end: res.end }, kind);
  }

  function wrap(pane, open, close = open) {
    edit(pane, (t, s0, e0) => {
      // A double-click selection often carries a trailing space, and
      // "**word **" is not bold.
      let s = s0;
      let e = e0;
      while (s < e && SPACE_RE.test(t[s])) s++;
      while (e > s && SPACE_RE.test(t[e - 1])) e--;
      const inner = t.slice(s, e);

      if (s >= open.length && t.slice(s - open.length, s) === open && t.startsWith(close, e)) {
        return {
          text: t.slice(0, s - open.length) + inner + t.slice(e + close.length),
          start: s - open.length,
          end: e - open.length,
        };
      }
      if (
        inner.length > open.length + close.length &&
        inner.startsWith(open) && inner.endsWith(close)
      ) {
        const bare = inner.slice(open.length, inner.length - close.length);
        return { text: t.slice(0, s) + bare + t.slice(e), start: s, end: s + bare.length };
      }
      return {
        text: t.slice(0, s) + open + inner + close + t.slice(e),
        start: s + open.length,
        end: e + open.length,
      };
    });
  }

  function insertLink(pane) {
    edit(pane, (t, s, e) => {
      const inner = t.slice(s, e);
      const isUrl = /^https?:\/\/\S+$/.test(inner);
      const ins = isUrl ? `[](${inner})` : `[${inner}]()`;
      // Land where the missing half goes: the label for a pasted URL, the
      // address otherwise.
      const caret = isUrl || !inner ? s + 1 : s + inner.length + 3;
      return { text: t.slice(0, s) + ins + t.slice(e), start: caret, end: caret };
    });
  }

  function cycleHeading(pane) {
    edit(pane, (t, s, e) => {
      const m = HEAD_RE.exec(t.slice(lineStart(t, s)));
      const level = m ? m[1].length : 0;
      const next = level >= 3 ? 0 : level + 1;
      return mapLines(t, s, e, (line) => {
        const bare = line.replace(HEAD_RE, "");
        return next ? `${"#".repeat(next)} ${bare}` : bare;
      });
    });
  }

  const LIST_RE =
    /^([ \t]*)(?:([-*+])[ \t]+\[[ xX]\](?:[ \t]+|$)|([-*+])[ \t]+|(\d{1,9})[.)][ \t]+)/;

  function listInfo(line) {
    const m = LIST_RE.exec(line);
    if (!m) {
      const indent = /^[ \t]*/.exec(line)[0];
      return { indent, body: line.slice(indent.length), kind: "" };
    }
    return {
      indent: m[1],
      body: line.slice(m[0].length),
      kind: m[2] ? "task" : m[3] ? "bullet" : "number",
    };
  }

  // Turns the selected lines into one kind of list, or back into plain
  // lines when they already are that kind.
  function toggleList(pane, kind) {
    edit(pane, (t, s, e) => {
      const infos = t.slice(lineStart(t, s), lineEnd(t, e)).split("\n").map(listInfo);
      const used = infos.filter((x) => x.kind || x.body.trim());
      const off = used.length > 0 && used.every((x) => x.kind === kind);
      let n = 0;
      return mapLines(t, s, e, (line, _i, all) => {
        const x = listInfo(line);
        if (off) return x.indent + x.body;
        if (all.length > 1 && !x.kind && !x.body.trim()) return line;
        const marker = kind === "number" ? `${++n}. ` : kind === "task" ? "- [ ] " : "- ";
        return x.indent + marker + x.body;
      });
    });
  }

  const TICK_RE = /^([ \t]*(?:>[ \t]?)*[ \t]*[-*+][ \t]+\[)([ xX])\]/;
  const flipTask = (line) =>
    line.replace(TICK_RE, (_, head, c) => `${head}${c === " " ? "x" : " "}]`);

  function toggleTasks(pane) {
    edit(pane, (t, s, e) => mapLines(t, s, e, flipTask));
  }

  // Ticking a box by clicking it must not move the caret or pull focus.
  function toggleTaskAt(pane, index) {
    const { text, sel } = readEditor(pane);
    const lines = text.split("\n");
    if (index < 0 || index >= lines.length) return;
    const next = flipTask(lines[index]);
    if (next === lines[index]) return;
    lines[index] = next;
    commit(pane, lines.join("\n"), sel, "edit");
  }

  const OUTDENT_RE = /^(?:\t| {1,4})/;

  function indent(pane, out) {
    edit(pane, (t, s, e) => {
      const line = t.slice(lineStart(t, s), lineEnd(t, s));
      if (!out && !t.slice(s, e).includes("\n") && !LIST_RE.test(line)) {
        return splice(t, s, e, "\t");
      }
      return mapLines(t, s, e, (l) => (out ? l.replace(OUTDENT_RE, "") : `\t${l}`));
    });
  }

  function inFence(t, end) {
    let fence = null;
    for (const line of t.slice(0, end).split("\n")) {
      const m = FENCE_RE.exec(line);
      if (!m) continue;
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
    }
    return Boolean(fence);
  }

  // What Enter should carry onto the next line: the quote and list markers,
  // with the number bumped and a ticked box cleared. `drop` is what the line
  // becomes when Enter lands on an item with nothing in it: a nested item
  // steps out a level, a top-level one ends the list.
  function carry(line) {
    const q = QUOTE_RE.exec(line);
    const quote = q ? q[0] : "";
    const rest = line.slice(quote.length);
    const item = (m, marker) => ({
      len: quote.length + m[0].length,
      next: quote + marker,
      drop: m[1] ? quote + m[1].replace(OUTDENT_RE, "") + m[0].slice(m[1].length) : quote,
    });
    let m;
    if ((m = /^([ \t]*)([-*+])[ \t]+\[[ xX]\](?:[ \t]+|$)/.exec(rest))) {
      return item(m, `${m[1]}${m[2]} [ ] `);
    }
    if ((m = /^([ \t]*)([-*+])[ \t]+/.exec(rest))) return item(m, `${m[1]}${m[2]} `);
    if ((m = /^([ \t]*)(\d{1,9})([.)])[ \t]+/.exec(rest))) {
      return item(m, `${m[1]}${Number(m[2]) + 1}${m[3]} `);
    }
    if (quote) return { len: quote.length, next: quote, drop: "" };
    return null;
  }

  function newline(pane, smart) {
    edit(pane, (t, s, e) => {
      if (!smart || s !== e) return splice(t, s, e, "\n");
      const ls = lineStart(t, s);
      const le = lineEnd(t, s);
      const line = t.slice(ls, le);
      // Counting the caret's own line means Enter on a closing fence has
      // already left the block.
      if (inFence(t, le)) return splice(t, s, e, `\n${/^[ \t]*/.exec(line)[0]}`);

      const c = carry(line);
      if (!c || s - ls < c.len) return splice(t, s, e, "\n");
      if (!line.slice(c.len).trim()) {
        return {
          text: t.slice(0, ls) + c.drop + t.slice(le),
          start: ls + c.drop.length,
          end: ls + c.drop.length,
        };
      }
      return splice(t, s, e, `\n${c.next}`);
    });
  }

  // --------------------------------------------------------- editor events

  function onBeforeInput(pane, e) {
    if (e.isComposing) return;
    const t = e.inputType;
    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      newline(pane, t === "insertParagraph");
    } else if (t === "historyUndo" || t === "historyRedo") {
      e.preventDefault();
      stepHistory(pane, t === "historyUndo" ? -1 : 1);
    } else if (t.startsWith("format")) {
      // Rich formatting would only be flattened away on the next repaint.
      e.preventDefault();
    }
  }

  let plainPaste = false;

  function onEditorKey(pane, e) {
    if (e.isComposing) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    plainPaste = mod && e.shiftKey && key === "v";
    if (mod) {
      const act =
        key === "z" ? () => stepHistory(pane, e.shiftKey ? 1 : -1)
        : key === "y" ? () => stepHistory(pane, 1)
        : key === "b" ? () => wrap(pane, "**")
        : key === "i" ? () => wrap(pane, "*")
        : key === "u" ? () => wrap(pane, "<u>", "</u>")
        : key === "k" ? () => insertLink(pane)
        : key === "Enter" ? () => toggleTasks(pane)
        : null;
      if (act) {
        e.preventDefault();
        act();
      }
      return;
    }
    if (key === "Tab" && !e.altKey) {
      e.preventDefault();
      indent(pane, e.shiftKey);
    }
  }

  // On a line showing its rendered form, a checkbox ticks and a link opens.
  // With the syntax showing, a click edits, unless Ctrl or Cmd is held.
  function onEditorPointer(pane, e) {
    if (e.button !== 0) return;
    const line = e.target.closest(".md-line");
    if (!line || line.parentNode !== pane.editor) return;
    const rendered = !line.classList.contains("is-active");

    if (rendered && e.target.closest(".md-check")) {
      e.preventDefault();
      toggleTaskAt(pane, Array.prototype.indexOf.call(pane.editor.children, line));
      return;
    }
    const link = e.target.closest(".md-link, .md-wikilink");
    if (link && (rendered || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      follow(pane, link);
    }
  }

  function follow(pane, el) {
    if (el.dataset.target !== undefined) {
      openWikilink(pane, el.dataset.target);
      return;
    }
    let href = el.dataset.href || "";
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(href)) href = `https://${href}`;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return;
    }
    if (!/^(https?|mailto):$/.test(url.protocol)) return;
    window.open(url.href, "_blank", "noopener,noreferrer");
  }

  // [[Name]] jumps to the section with that name, making it if need be.
  function openWikilink(pane, raw) {
    if (!doc) return;
    const name = raw.split("#")[0].trim().slice(0, 60);
    if (!name) return;
    const want = name.toLowerCase();
    const hit = doc.sections.find((s) => s.name.trim().toLowerCase() === want);
    if (!hit) {
      addSection(pane, name);
      return;
    }
    // A note already open in the visible other pane is shown there rather
    // than pulled across; a closed one reopens here.
    const twin = other(pane);
    const there = splitOn && doc.tabs[twin.key].includes(hit.id);
    flushAll();
    openHere(there ? twin : pane, hit.id);
  }

  // Copy the source, not the rendered DOM, so the markers come along.
  function onCopy(pane, e, cut) {
    const { text, sel } = readEditor(pane);
    if (!sel || sel.start === sel.end) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text.slice(sel.start, sel.end));
    if (cut) {
      const res = splice(text, sel.start, sel.end, "");
      commit(pane, res.text, { start: res.start, end: res.end }, "edit");
    }
  }

  // Formatted web content comes in as Markdown. Anything without real
  // formatting (a code editor's styled spans, say) pastes as its plain text,
  // and Ctrl+Shift+V always does.
  function onPaste(pane, e) {
    e.preventDefault();
    const data = e.clipboardData;
    const html = plainPaste ? "" : data.getData("text/html");
    plainPaste = false;
    const md = (html && RICH.test(html) && htmlToMd(html)) || data.getData("text/plain");
    const clean = md.replace(/\r\n?/g, "\n").replace(/ /g, " ");
    if (clean) edit(pane, (t, s, en) => splice(t, s, en, clean));
  }

  // ------------------------------------------------------- focused editor

  // The toolbar is shared, so it acts on whichever editor was last in use.
  let lastFocused = paneA;

  function markFocus(pane) {
    lastFocused = pane;
    paneA.el.classList.toggle("is-focus", pane === paneA);
    paneB.el.classList.toggle("is-focus", pane === paneB);
  }

  function focusPane(pane, move = true) {
    const target = splitOn || pane !== paneB ? pane : paneA;
    markFocus(target);
    if (move) target.editor.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- toolbar

  const MD_ACTIONS = {
    bold: (p) => wrap(p, "**"),
    italic: (p) => wrap(p, "*"),
    strike: (p) => wrap(p, "~~"),
    heading: cycleHeading,
    bullet: (p) => toggleList(p, "bullet"),
    number: (p) => toggleList(p, "number"),
    task: (p) => toggleList(p, "task"),
  };

  toolbar.addEventListener("mousedown", (e) => {
    // Keep the caret in the editor when a toolbar button is pressed.
    if (e.target.closest("button[data-md]")) e.preventDefault();
  });

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-md]");
    const act = btn && MD_ACTIONS[btn.dataset.md];
    if (!act) return;
    lastFocused.editor.focus({ preventScroll: true });
    act(lastFocused);
  });

  // ------------------------------------------------------------------ save

  let saveTimer = 0;
  let statusText = "";
  let statusTone = "";

  function setStatus(text, tone = "") {
    if (text === statusText && tone === statusTone) return;
    statusText = text;
    statusTone = tone;
    status.textContent = text;
    status.className = tone ? `ddbn-status ${tone}` : "ddbn-status";
  }

  function scheduleSave() {
    if (!currentId) return;
    setStatus("Editing");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    if (!currentId || !doc) return;
    flushAll();
    if (!dirty) return;

    // Cleared up front so a save racing in behind this one does not write
    // the same document twice; restored if the write actually failed.
    dirty = false;
    doc.updated = Date.now();
    const stamp = doc.updated;
    // doc already has the stored shape, and chrome.storage clones it on the
    // way out, so there is nothing to copy here.
    const ok = await store.set(notesKey(currentId), doc);
    if (ok) {
      setStatus(`Saved ${new Date(stamp).toLocaleTimeString()}`, "is-ok");
    } else {
      dirty = true;
      setStatus("Could not save. Check that the extension is still enabled.", "is-bad");
    }
  }

  function flushNow() {
    clearTimeout(saveTimer);
    save();
  }

  // pagehide rather than beforeunload: beforeunload disqualifies the whole
  // page from the back/forward cache, and visibilitychange is the handler
  // that actually runs when a tab is closed on mobile or backgrounded.
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });

  // ------------------------------------------------------------------ load

  // The sheet is a React app, so the name is usually not in the DOM or the
  // title yet at document_idle. Whichever source has filled in first wins,
  // and the poll below re-reads this until the sheet's own element appears.
  const NAME_SEL = ".ddbc-character-name, .ddbc-character-summary__name";
  const TITLE_TAIL = /\s*[|–—-]\s*(d\s*&\s*d|dnd|dungeons)\b.*$/i;
  const TITLE_HEAD = /^(d\s*&\s*d|dnd|dungeons)\b/i;

  let labelSettled = false;

  function characterLabel(id) {
    const el = document.querySelector(NAME_SEL);
    const name = el ? el.textContent.trim() : "";
    if (name) {
      labelSettled = true;
      return name;
    }

    const t = (document.title || "").replace(TITLE_TAIL, "").trim();
    if (t && !TITLE_HEAD.test(t)) return t;

    return `Character ${id}`;
  }

  async function loadFor(id) {
    currentId = id;
    labelSettled = false;
    title.textContent = characterLabel(id);

    const key = notesKey(id);
    closeShelf();
    doc = migrate((await store.get([key]))[key], splitOn);
    dirty = false;
    for (const p of allPanes) showActive(p);
    // The split setting is shared by every sheet, but this one may have no
    // bottom tab to fill it, or bottom tabs saved without a split.
    settle();
    renderTabs();

    const n = doc.sections.length;
    setStatus(
      doc.updated
        ? `${n} note${n === 1 ? "" : "s"} · saved ${new Date(doc.updated).toLocaleString()}`
        : "No notes yet"
    );
  }

  // D&D Beyond routes between characters client-side, and a content script
  // cannot see the page's own history calls, so the URL has to be watched.
  // The path compare is the whole cost of a tick once the name has landed.
  let lastPath = location.pathname;

  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      labelSettled = false;
      flushNow();
      const id = characterId();
      if (id) {
        root.hidden = false;
        loadFor(id);
      } else {
        root.hidden = true;
        currentId = null;
        doc = null;
      }
      syncPush();
      return;
    }

    if (currentId && !labelSettled) {
      const label = characterLabel(currentId);
      if (label !== title.textContent) title.textContent = label;
    }
  }, POLL);

  // ------------------------------------------------------------------ boot

  (async () => {
    // Settings load even off a sheet, because the URL watcher can route onto
    // one without a reload and would otherwise show an uninitialised drawer.
    const id = characterId();
    root.hidden = !id;

    const cfg = await store.get({
      [UI_WIDTH]: DEF_WIDTH,
      [UI_RATIO]: DEF_RATIO,
      [UI_THEME]: "auto",
      [UI_PUSH]: true,
      [UI_SPLIT]: false,
      [UI_OPEN]: false,
    });

    applyWidth(Number(cfg[UI_WIDTH]) || DEF_WIDTH);
    applyRatio(Number(cfg[UI_RATIO]) || DEF_RATIO);
    theme = THEMES.includes(cfg[UI_THEME]) ? cfg[UI_THEME] : "auto";
    syncTheme();
    pushEnabled = cfg[UI_PUSH] !== false;
    splitOn = cfg[UI_SPLIT] === true;

    if (id) await loadFor(id);
    setSplit(splitOn, false);
    markFocus(paneA);
    setOpen(cfg[UI_OPEN] === true, false);
  })();
})();
