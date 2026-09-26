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
  const SCHEMA = 3;
  const THEMES = ["auto", "light", "dark"];

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

  // -------------------------------------------------------------- sanitizer

  // Notes are the user's own input, but they get written back into a live
  // page, so everything is rebuilt from an allowlist and all attributes
  // are dropped.
  const ALLOWED = new Set([
    "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
    "UL", "OL", "LI", "P", "DIV", "BR",
  ]);

  // Two inert documents, made once and reused. Building a fresh one per
  // call was the bulk of the cost of sanitizing on every debounced save.
  const scratch = document.implementation.createHTMLDocument("").body;
  const probe = document.implementation.createHTMLDocument("").body;

  const MARKUP = /[<>&]/;
  const SPACE = /\s/g;

  function sanitize(html) {
    const src = String(html || "");
    // Plain text survives a rebuild unchanged, and plain text is what most
    // of a note is, so skip the parse when there is no markup to strip.
    if (!MARKUP.test(src)) return src;

    scratch.innerHTML = src;
    const clean = document.createElement("div");
    walk(scratch, clean);
    scratch.textContent = "";
    return clean.innerHTML;
  }

  function walk(from, to) {
    for (let node = from.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(node.nodeValue));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
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
  }

  // "Empty" for the delete prompt: no text once tags and entities resolve.
  function isBlank(html) {
    probe.innerHTML = sanitize(html);
    const blank = !probe.textContent.replace(SPACE, "");
    probe.textContent = "";
    return blank;
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

  const htmlEl = document.documentElement;
  const rootStyle = root.style;
  const htmlStyle = htmlEl.style;

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
      activeBtn: null,
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

  // { v, sections: [{ id, name, html, updated }], active: { a, b }, updated }
  let currentId = null;
  let doc = null;
  // Set whenever the model diverges from what is in storage, so the saves
  // fired on blur, on navigation and on tab hide cost nothing when there is
  // no actual change behind them.
  let dirty = false;

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
  // This is also the one place stored markup is re-checked against the
  // allowlist, which lets everything downstream treat it as already clean.
  function migrate(saved) {
    if (!saved || typeof saved !== "object") return emptyDoc();

    let sections = null;

    if (Array.isArray(saved.sections) && saved.sections.length) {
      sections = saved.sections
        .filter((s) => s && typeof s === "object")
        .map((s) => ({
          id: typeof s.id === "string" && s.id ? s.id : uid(),
          name: String(s.name || "Section").slice(0, 60),
          html: typeof s.html === "string" ? sanitize(s.html) : "",
          updated: Number(s.updated) || Date.now(),
        }));
    } else if (typeof saved.html === "string") {
      const s = newSection("General");
      s.html = sanitize(saved.html);
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
    if (e.key === "Escape" && isOpen && drawer.contains(e.target)) {
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

  // Both panes showing one section would mean two editors over the same
  // text, so the bottom pane always lands on something of its own.
  function ensureSplitTargets() {
    if (!doc || !splitOn) return;
    if (doc.sections.length < 2) {
      doc.sections.push(newSection(`Section ${doc.sections.length + 1}`));
      dirty = true;
    }
    if (!sectionById(doc.active.b) || doc.active.b === doc.active.a) {
      const pick =
        doc.sections.find((s) => s.id !== doc.active.a) || doc.sections[0];
      doc.active.b = pick.id;
      dirty = true;
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
    if (!doc) {
      pane.list.replaceChildren();
      return;
    }

    const mine = doc.active[pane.key];
    const taken = splitOn ? doc.active[other(pane).key] : null;
    const frag = document.createDocumentFragment();

    for (const s of doc.sections) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddbn-sec";
      btn.dataset.id = s.id;
      btn.setAttribute("role", "tab");
      const active = s.id === mine;
      btn.setAttribute("aria-selected", String(active));
      if (active) {
        btn.classList.add("is-active");
        pane.activeBtn = btn;
      } else if (s.id === taken) {
        btn.classList.add("is-elsewhere");
      }
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

      frag.appendChild(btn);
    }

    pane.list.replaceChildren(frag);
    // Scrolling a closed drawer into view is a forced layout for nothing;
    // setOpen replays it.
    if (isOpen) revealActive(pane);
  }

  function flushPane(pane) {
    if (!splitOn && pane === paneB) return;
    const s = activeSection(pane);
    if (!s) return;
    const html = sanitize(pane.editor.innerHTML);
    if (html !== s.html) {
      s.html = html;
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
      ? `Notes for ${s.name}.`
      : "Session notes, loot, NPC names, plans.";
  }

  // Section markup is sanitized on load and on every flush, so what the
  // model holds is already clean by the time it comes back here.
  function showActive(pane) {
    const s = activeSection(pane);
    pane.editor.innerHTML = s ? s.html : "";
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

    dirty = true;
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
    dirty = true;
    showActive(pane);
    renderSections(paneA);
    renderSections(paneB);
    save();
    if (pane.activeBtn) beginRename(pane.activeBtn.firstElementChild);
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
    dirty = true;

    // Repoint the editors before anything else can flush them: they are
    // still holding the text of the section that just went away.
    showActive(paneA);
    showActive(paneB);

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

    // Paste as sanitized markup rather than whatever the source page carried.
    pane.editor.addEventListener("paste", (e) => {
      e.preventDefault();
      const html = e.clipboardData.getData("text/html");
      if (html) {
        document.execCommand("insertHTML", false, sanitize(html));
      } else {
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      }
    });
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

  // ------------------------------------------------------------- formatting

  // Resolved once: selectionchange fires often enough that re-querying the
  // toolbar and re-reading dataset on every event is real work.
  const cmdButtons = Array.from(
    toolbar.querySelectorAll("button[data-cmd]"),
    (el) => ({ el, cmd: el.dataset.cmd, on: false })
  );

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

  let toolbarFrame = 0;

  function refreshToolbar() {
    if (toolbarFrame) {
      cancelAnimationFrame(toolbarFrame);
      toolbarFrame = 0;
    }
    for (const b of cmdButtons) {
      let active = false;
      try {
        active = document.queryCommandState(b.cmd);
      } catch {
        active = false;
      }
      if (active === b.on) continue;
      b.on = active;
      b.el.classList.toggle("is-active", active);
      b.el.setAttribute("aria-pressed", String(active));
    }
  }

  // Caret moves come in bursts; one refresh per frame is plenty.
  document.addEventListener("selectionchange", () => {
    if (toolbarFrame) return;
    const el = document.activeElement;
    if (el !== paneA.editor && el !== paneB.editor) return;
    toolbarFrame = requestAnimationFrame(refreshToolbar);
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
    doc = migrate((await store.get([key]))[key]);
    dirty = false;
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
