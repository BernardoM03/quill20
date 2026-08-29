(() => {
  "use strict";

  const ROOT_ID = "ddb-notes-root";
  if (document.getElementById(ROOT_ID)) return;

  const SAVE_DELAY = 600;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 720;
  const SCHEMA = 3;
  const THEMES = ["auto", "light", "dark"];

  // ---------------------------------------------------------------- storage

  const store = {
    async get(key, fallback) {
      try {
        const res = await chrome.storage.local.get(key);
        return key in res ? res[key] : fallback;
      } catch {
        return fallback;
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
  const characterId = () => {
    const m = location.pathname.match(/\/characters\/(\d+)(?:\/|$)/);
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

  // -------------------------------------------------------------- sanitizer

  // Notes are the user's own input, but they get written back into a live
  // page, so everything is rebuilt from an allowlist and all attributes
  // are dropped.
  const ALLOWED = new Set([
    "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
    "UL", "OL", "LI", "P", "DIV", "BR",
  ]);

  function sanitize(html) {
    const dirty = document.implementation.createHTMLDocument("").body;
    dirty.innerHTML = String(html || "");
    const clean = document.createElement("div");
    walk(dirty, clean);
    return clean.innerHTML;
  }

  function walk(from, to) {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      if (ALLOWED.has(node.tagName)) {
        const el = document.createElement(node.tagName.toLowerCase());
        to.appendChild(el);
        walk(node, el);
      } else {
        // Unwrap unknown elements, keep their text.
        walk(node, to);
      }
    }
  }

  // "Empty" for the delete prompt: no text once tags and entities resolve.
  function isBlank(html) {
    const probe = document.implementation.createHTMLDocument("").body;
    probe.innerHTML = sanitize(html);
    return !probe.textContent.replace(/\s| /g, "");
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

      <div class="ddbn-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"
                aria-label="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"
                aria-label="Italic"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"
                aria-label="Underline"><u>U</u></button>
        <span class="ddbn-sep" aria-hidden="true"></span>
        <button type="button" data-cmd="insertUnorderedList" title="Bulleted list"
                aria-label="Bulleted list">&bull;&nbsp;&mdash;</button>
        <button type="button" data-cmd="insertOrderedList" title="Numbered list"
                aria-label="Numbered list">1.&nbsp;&mdash;</button>
        <span class="ddbn-sep" aria-hidden="true"></span>
        <button type="button" data-cmd="removeFormat" title="Clear formatting"
                aria-label="Clear formatting">&#10005;</button>
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

  // ------------------------------------------------------------------ panes

  // Two identical stacked editors. Each one points at its own section, so
  // the drawer's height can carry a reference note above working notes.
  function buildPane(key, label) {
    const el = document.createElement("div");
    el.className = "ddbn-pane";
    el.dataset.pane = key;
    el.innerHTML = `
      <div class="ddbn-sectionbar">
        <div class="ddbn-sections" role="tablist"
             aria-label="${label} sections"></div>
        <button class="ddbn-add" type="button" title="New section"
                aria-label="New section">+</button>
      </div>
      <div class="ddbn-editor" contenteditable="true" role="textbox"
           aria-multiline="true" aria-label="${label} notes"
           data-placeholder="Session notes, loot, NPC names, plans."></div>
    `;
    return {
      key,
      el,
      list: el.querySelector(".ddbn-sections"),
      addBtn: el.querySelector(".ddbn-add"),
      editor: el.querySelector(".ddbn-editor"),
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
  const paneOf = (key) => (key === "b" ? paneB : paneA);
  const other = (pane) => (pane === paneA ? paneB : paneA);

  // -------------------------------------------------------- document model

  // { v, sections: [{ id, name, html, updated }], active: { a, b }, updated }
  let currentId = null;
  let doc = null;

  const newSection = (name = "Section") => ({
    id: uid(),
    name,
    html: "",
    updated: Date.now(),
  });

  function emptyDoc() {
    const s = newSection("General");
    return { v: SCHEMA, sections: [s], active: { a: s.id, b: s.id }, updated: 0 };
  }

  // v1 was one { html, updated }; v2 added sections with a single activeId.
  // Both fold forward so nothing written before an upgrade is stranded.
  function migrate(saved) {
    if (!saved || typeof saved !== "object") return emptyDoc();

    let sections = null;

    if (Array.isArray(saved.sections) && saved.sections.length) {
      sections = saved.sections
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          id: typeof s.id === "string" && s.id ? s.id : uid(),
          name: String(s.name || "Section").slice(0, 60),
          html: typeof s.html === "string" ? s.html : "",
          updated: Number(s.updated) || Date.now(),
        }));
    } else if (typeof saved.html === "string") {
      const s = newSection("General");
      s.html = saved.html;
      s.updated = Number(saved.updated) || Date.now();
      sections = [s];
    }

    if (!sections || !sections.length) return emptyDoc();

    const has = (id) => sections.some((s) => s.id === id);
    const legacy = saved.active ? null : saved.activeId;
    const a = has(saved.active?.a) ? saved.active.a
      : has(legacy) ? legacy
      : sections[0].id;
    const b = has(saved.active?.b) ? saved.active.b : a;

    return {
      v: SCHEMA,
      sections,
      active: { a, b },
      updated: Number(saved.updated) || Date.now(),
    };
  }

  const sectionById = (id) =>
    doc ? doc.sections.find((s) => s.id === id) || null : null;

  const activeSection = (pane) => (doc ? sectionById(doc.active[pane.key]) : null);

  // ------------------------------------------------------------- open state

  let isOpen = false;

  function setOpen(open, persist = true) {
    isOpen = open;
    root.classList.toggle("is-open", open);
    drawer.hidden = !open;
    tab.setAttribute("aria-expanded", String(open));
    tab.title = open ? "Close notes" : "Open notes";
    if (persist) store.set(UI_OPEN, open);
    syncPush();
    if (open) focusPane(lastFocused);
  }

  tab.addEventListener("click", () => setOpen(!isOpen));
  closeBtn.addEventListener("click", () => {
    setOpen(false);
    tab.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen && drawer.contains(document.activeElement)) {
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
    const html = document.documentElement;

    // Containment pulls the page's own position:fixed chrome in with the
    // push, but it would collapse a body that does not stand on its own
    // height. Measure before the push so the reading is unaffected.
    if (on && !html.classList.contains("ddbn-contain")) {
      const h = document.body ? document.body.getBoundingClientRect().height : 0;
      html.classList.toggle("ddbn-contain", h >= window.innerHeight * 0.9);
    } else if (!on) {
      html.classList.remove("ddbn-contain");
    }

    html.classList.toggle("ddbn-pushed", on);
    pushBtn.setAttribute("aria-pressed", String(pushEnabled));
    pushBtn.classList.toggle("is-active", pushEnabled);
    pushBtn.title = pushEnabled
      ? "Push mode on: the page reflows beside the drawer"
      : "Overlay mode: the drawer floats over the page";
    notifyResize();
  }

  // Layouts driven by JS rather than CSS only recompute on a resize event.
  let resizeTimer = null;
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

  function applyWidth(px) {
    const cap = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.7))
    );
    const w = Math.min(cap, Math.max(MIN_WIDTH, Math.round(px)));
    document.documentElement.style.setProperty("--ddbn-width", `${w}px`);
    return w;
  }

  const currentWidth = () =>
    parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--ddbn-width"),
      10
    ) || 340;

  let dragging = false;

  grip.addEventListener("pointerdown", (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.documentElement.classList.add("ddbn-dragging");
  });

  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    applyWidth(window.innerWidth - e.clientX);
  });

  grip.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    grip.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.documentElement.classList.remove("ddbn-dragging");
    store.set(UI_WIDTH, currentWidth());
    notifyResize();
  });

  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 12;
    let w = currentWidth();
    if (e.key === "ArrowLeft") w += step;
    else if (e.key === "ArrowRight") w -= step;
    else return;
    e.preventDefault();
    store.set(UI_WIDTH, applyWidth(w));
    notifyResize();
  });

  window.addEventListener("resize", () => {
    // Re-clamp against the new viewport, but never fight an active drag.
    if (!dragging) applyWidth(currentWidth());
  });

  // ------------------------------------------------------------ split view

  let splitOn = false;
  let ratio = 0.5;

  function applyRatio(r) {
    ratio = Math.min(0.85, Math.max(0.15, r));
    root.style.setProperty("--ddbn-split", `${(ratio * 100).toFixed(2)}%`);
    return ratio;
  }

  // Both panes showing one section would mean two editors over the same
  // text, so the bottom pane always lands on something of its own.
  function ensureSplitTargets() {
    if (!doc || !splitOn) return;
    if (doc.sections.length < 2) {
      doc.sections.push(newSection(`Section ${doc.sections.length + 1}`));
    }
    if (!sectionById(doc.active.b) || doc.active.b === doc.active.a) {
      const pick =
        doc.sections.find((s) => s.id !== doc.active.a) || doc.sections[0];
      doc.active.b = pick.id;
    }
  }

  function setSplit(on, persist = true) {
    // Flush while the old state still stands: once splitOn flips, the
    // bottom pane counts as hidden and its edits stop being collected.
    if (doc) flushAll();
    splitOn = on;
    root.classList.toggle("is-split", on);
    splitBtn.setAttribute("aria-pressed", String(on));
    splitBtn.classList.toggle("is-active", on);
    splitBtn.title = on
      ? "Back to a single note area"
      : "Split the drawer into two sections";
    if (persist) store.set(UI_SPLIT, on);

    if (doc) {
      ensureSplitTargets();
      showActive(paneB);
      renderSections(paneA);
      renderSections(paneB);
      if (persist) save();
    }
    if (!on && lastFocused === paneB) focusPane(paneA, false);
  }

  splitBtn.addEventListener("click", () => setSplit(!splitOn));

  let dividerDrag = false;

  divider.addEventListener("pointerdown", (e) => {
    dividerDrag = true;
    divider.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    root.classList.add("is-hdragging");
  });

  divider.addEventListener("pointermove", (e) => {
    if (!dividerDrag) return;
    const box = panes.getBoundingClientRect();
    if (box.height > 0) applyRatio((e.clientY - box.top) / box.height);
  });

  divider.addEventListener("pointerup", (e) => {
    if (!dividerDrag) return;
    dividerDrag = false;
    divider.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    root.classList.remove("is-hdragging");
    store.set(UI_RATIO, ratio);
  });

  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    if (e.key === "ArrowUp") applyRatio(ratio - step);
    else if (e.key === "ArrowDown") applyRatio(ratio + step);
    else return;
    e.preventDefault();
    store.set(UI_RATIO, ratio);
  });

  // -------------------------------------------------------------- sections

  function renderSections(pane) {
    pane.list.textContent = "";
    if (!doc) return;

    const mine = doc.active[pane.key];
    const taken = splitOn ? doc.active[other(pane).key] : null;

    for (const s of doc.sections) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddbn-sec";
      btn.dataset.id = s.id;
      btn.setAttribute("role", "tab");
      const active = s.id === mine;
      btn.setAttribute("aria-selected", String(active));
      btn.classList.toggle("is-active", active);
      btn.classList.toggle("is-elsewhere", !active && s.id === taken);
      btn.title = active
        ? `${s.name} — double-click to rename`
        : s.id === taken
        ? `${s.name} — open in the other pane; click to swap`
        : s.name;

      const name = document.createElement("span");
      name.className = "ddbn-sec-name";
      name.textContent = s.name;
      btn.appendChild(name);

      if (active && doc.sections.length > 1) {
        const del = document.createElement("span");
        del.className = "ddbn-sec-del";
        del.dataset.del = s.id;
        del.setAttribute("role", "button");
        del.setAttribute("aria-label", `Delete section ${s.name}`);
        del.title = "Delete this section";
        del.textContent = "×";
        btn.appendChild(del);
      }

      pane.list.appendChild(btn);
    }

    const el = pane.list.querySelector(".ddbn-sec.is-active");
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function flushPane(pane) {
    const s = activeSection(pane);
    if (!s) return;
    if (!splitOn && pane === paneB) return;
    const html = sanitize(pane.editor.innerHTML);
    if (html !== s.html) {
      s.html = html;
      s.updated = Date.now();
    }
  }

  function flushAll() {
    for (const p of allPanes) flushPane(p);
  }

  function updatePlaceholder(pane) {
    const s = activeSection(pane);
    pane.editor.dataset.placeholder = s
      ? `Notes for ${s.name}.`
      : "Session notes, loot, NPC names, plans.";
  }

  function showActive(pane) {
    const s = activeSection(pane);
    pane.editor.innerHTML = s ? sanitize(s.html) : "";
    updatePlaceholder(pane);
  }

  function selectSection(pane, id) {
    if (!doc || id === doc.active[pane.key]) return;
    flushAll();

    const twin = other(pane);
    // Taking the section the other pane is showing hands it ours in return,
    // which keeps one section from being open in two editors at once.
    if (splitOn && doc.active[twin.key] === id) {
      doc.active[twin.key] = doc.active[pane.key];
      doc.active[pane.key] = id;
      showActive(twin);
      renderSections(twin);
    } else {
      doc.active[pane.key] = id;
      if (splitOn) renderSections(twin);
    }

    showActive(pane);
    renderSections(pane);
    save();
    focusPane(pane);
  }

  function addSection(pane) {
    if (!doc) return;
    flushAll();
    const s = newSection(`Section ${doc.sections.length + 1}`);
    doc.sections.push(s);
    doc.active[pane.key] = s.id;
    showActive(pane);
    for (const p of allPanes) renderSections(p);
    save();
    const el = pane.list.querySelector(".ddbn-sec.is-active .ddbn-sec-name");
    if (el) beginRename(el);
  }

  function deleteSection(pane, id) {
    if (!doc || doc.sections.length < 2) return;
    flushAll();
    const s = sectionById(id);
    if (!s) return;
    if (!isBlank(s.html) && !confirm(`Delete "${s.name}" and its notes?`)) return;

    const i = doc.sections.indexOf(s);
    doc.sections.splice(i, 1);
    const fallback = doc.sections[Math.max(0, i - 1)].id;
    for (const p of allPanes) {
      if (doc.active[p.key] === id) doc.active[p.key] = fallback;
    }

    // Repoint the editors before anything else can flush them: they are
    // still holding the text of the section that just went away.
    for (const p of allPanes) showActive(p);

    // One section left cannot fill two panes, so the split folds away.
    if (splitOn && doc.sections.length < 2) setSplit(false);
    else ensureSplitTargets();

    for (const p of allPanes) {
      showActive(p);
      renderSections(p);
    }
    save();
  }

  // Rename in place: the label itself becomes editable on double-click.
  let renaming = null;

  function beginRename(nameEl) {
    if (renaming) return;
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
        save();
      }
      for (const p of allPanes) {
        renderSections(p);
        // Only the label changed, so leave the editors' contents alone.
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

  for (const pane of allPanes) {
    pane.addBtn.addEventListener("click", () => addSection(pane));

    pane.list.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        deleteSection(pane, del.dataset.del);
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

    pane.editor.addEventListener("input", scheduleSave);
    pane.editor.addEventListener("focus", () => markFocus(pane));
    pane.editor.addEventListener("blur", () => {
      clearTimeout(saveTimer);
      save();
    });
  }

  // ------------------------------------------------------- focused editor

  // The toolbar is shared, so it acts on whichever editor was last in use.
  let lastFocused = paneA;

  function markFocus(pane) {
    lastFocused = pane;
    for (const p of allPanes) p.el.classList.toggle("is-focus", p === pane);
  }

  function focusPane(pane, move = true) {
    const target = splitOn || pane !== paneB ? pane : paneA;
    markFocus(target);
    if (move) target.editor.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- formatting

  toolbar.addEventListener("mousedown", (e) => {
    // Keep the caret in the editor when a toolbar button is pressed.
    if (e.target.closest("button[data-cmd]")) e.preventDefault();
  });

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    lastFocused.editor.focus({ preventScroll: true });
    document.execCommand(btn.dataset.cmd, false, null);
    refreshToolbar();
    scheduleSave();
  });

  function refreshToolbar() {
    for (const btn of toolbar.querySelectorAll("button[data-cmd]")) {
      let active = false;
      try {
        active = document.queryCommandState(btn.dataset.cmd);
      } catch {
        active = false;
      }
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }

  document.addEventListener("selectionchange", () => {
    if (allPanes.some((p) => p.editor === document.activeElement)) {
      refreshToolbar();
    }
  });

  // Paste as sanitized markup rather than whatever the source page carried.
  for (const pane of allPanes) {
    pane.editor.addEventListener("paste", (e) => {
      e.preventDefault();
      const html = e.clipboardData.getData("text/html");
      const text = e.clipboardData.getData("text/plain");
      if (html) {
        document.execCommand("insertHTML", false, sanitize(html));
      } else {
        document.execCommand("insertText", false, text);
      }
    });
  }

  // ------------------------------------------------------------------ save

  let saveTimer = null;

  function setStatus(text, tone = "") {
    status.textContent = text;
    status.className = `ddbn-status ${tone}`;
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
    doc.updated = Date.now();
    const payload = {
      v: SCHEMA,
      active: { a: doc.active.a, b: doc.active.b },
      updated: doc.updated,
      sections: doc.sections.map((s) => ({
        id: s.id,
        name: s.name,
        html: sanitize(s.html),
        updated: s.updated,
      })),
    };
    const ok = await store.set(notesKey(currentId), payload);
    if (ok) {
      setStatus(`Saved ${new Date(payload.updated).toLocaleTimeString()}`, "is-ok");
    } else {
      setStatus("Could not save. Check that the extension is still enabled.", "is-bad");
    }
  }

  window.addEventListener("beforeunload", () => {
    clearTimeout(saveTimer);
    save();
  });

  // ------------------------------------------------------------------ load

  // The sheet is a React app, so the name is usually not in the DOM or the
  // title yet at document_idle. Whichever source has filled in first wins,
  // and the poll below re-reads this until one of them does.
  function characterLabel(id) {
    const el = document.querySelector(
      ".ddbc-character-name, .ddbc-character-summary__name"
    );
    const name = (el?.textContent || "").trim();
    if (name) return name;

    const t = (document.title || "")
      .replace(/\s*[|–—-]\s*(d\s*&\s*d|dnd|dungeons)\b.*$/i, "")
      .trim();
    if (t && !/^(d\s*&\s*d|dnd|dungeons)\b/i.test(t)) return t;

    return `Character ${id}`;
  }

  async function loadFor(id) {
    currentId = id;
    title.textContent = characterLabel(id);
    doc = migrate(await store.get(notesKey(id), null));
    ensureSplitTargets();
    for (const p of allPanes) {
      showActive(p);
      renderSections(p);
    }

    const n = doc.sections.length;
    setStatus(
      doc.updated
        ? `${n} section${n === 1 ? "" : "s"} · saved ${new Date(doc.updated).toLocaleString()}`
        : "No notes yet"
    );
  }

  // D&D Beyond routes between characters client-side, so watch the URL. The
  // same tick picks up the character name once the app has rendered it.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) {
      if (currentId) {
        const label = characterLabel(currentId);
        if (label !== title.textContent) title.textContent = label;
      }
      return;
    }
    lastPath = location.pathname;
    clearTimeout(saveTimer);
    save();
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
  }, 800);

  // ------------------------------------------------------------------ boot

  (async () => {
    // Settings load even off a sheet, because the URL watcher can route onto
    // one without a reload and would otherwise show an uninitialised drawer.
    const id = characterId();
    root.hidden = !id;

    applyWidth(await store.get(UI_WIDTH, 340));
    applyRatio(Number(await store.get(UI_RATIO, 0.5)) || 0.5);
    theme = THEMES.includes(await store.get(UI_THEME, "auto"))
      ? await store.get(UI_THEME, "auto")
      : "auto";
    syncTheme();
    pushEnabled = await store.get(UI_PUSH, true);
    splitOn = await store.get(UI_SPLIT, false);

    if (id) await loadFor(id);
    setSplit(splitOn, false);
    markFocus(paneA);
    setOpen(await store.get(UI_OPEN, false), false);
  })();
})();
