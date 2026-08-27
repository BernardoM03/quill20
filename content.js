(() => {
  "use strict";

  const ROOT_ID = "r20-notes-root";
  if (document.getElementById(ROOT_ID)) return;

  const SAVE_DELAY = 600;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 640;

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

  const characterId = () => {
    const m = location.pathname.match(/\/characters\/sheet\/(\d+)/);
    return m ? m[1] : null;
  };

  const notesKey = (id) => `notes:${id}`;
  const UI_OPEN = "ui:open";
  const UI_WIDTH = "ui:width";

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

  // ------------------------------------------------------------------- ui

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <button class="r20n-tab" type="button" aria-expanded="false"
            aria-controls="r20n-drawer" title="Open notes">
      <span class="r20n-tab-label">Notes</span>
    </button>

    <aside class="r20n-drawer" id="r20n-drawer" role="complementary"
           aria-label="Character notes" hidden>
      <div class="r20n-grip" role="separator" aria-orientation="vertical"
           aria-label="Resize notes drawer" tabindex="0"></div>

      <header class="r20n-head">
        <div class="r20n-titles">
          <p class="r20n-eyebrow">Notes for</p>
          <h2 class="r20n-title"></h2>
        </div>
        <button class="r20n-close" type="button" title="Close notes"
                aria-label="Close notes">&times;</button>
      </header>

      <div class="r20n-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"
                aria-label="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"
                aria-label="Italic"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"
                aria-label="Underline"><u>U</u></button>
        <span class="r20n-sep" aria-hidden="true"></span>
        <button type="button" data-cmd="insertUnorderedList" title="Bulleted list"
                aria-label="Bulleted list">&bull;&nbsp;&mdash;</button>
        <button type="button" data-cmd="insertOrderedList" title="Numbered list"
                aria-label="Numbered list">1.&nbsp;&mdash;</button>
        <span class="r20n-sep" aria-hidden="true"></span>
        <button type="button" data-cmd="removeFormat" title="Clear formatting"
                aria-label="Clear formatting">&#10005;</button>
      </div>

      <div class="r20n-editor" contenteditable="true" role="textbox"
           aria-multiline="true" aria-label="Notes"
           data-placeholder="Session notes, loot, NPC names, plans."></div>

      <footer class="r20n-foot">
        <span class="r20n-status" role="status" aria-live="polite"></span>
      </footer>
    </aside>
  `;
  document.documentElement.appendChild(root);

  const tab = root.querySelector(".r20n-tab");
  const drawer = root.querySelector(".r20n-drawer");
  const grip = root.querySelector(".r20n-grip");
  const title = root.querySelector(".r20n-title");
  const closeBtn = root.querySelector(".r20n-close");
  const toolbar = root.querySelector(".r20n-toolbar");
  const editor = root.querySelector(".r20n-editor");
  const status = root.querySelector(".r20n-status");

  // ------------------------------------------------------------- open state

  let isOpen = false;

  function setOpen(open, persist = true) {
    isOpen = open;
    root.classList.toggle("is-open", open);
    drawer.hidden = !open;
    tab.setAttribute("aria-expanded", String(open));
    tab.title = open ? "Close notes" : "Open notes";
    if (persist) store.set(UI_OPEN, open);
    if (open) editor.focus({ preventScroll: true });
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

  // ---------------------------------------------------------------- resize

  function applyWidth(px) {
    const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
    root.style.setProperty("--r20n-width", `${w}px`);
    return w;
  }

  let dragging = false;

  grip.addEventListener("pointerdown", (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
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
    const w = parseInt(root.style.getPropertyValue("--r20n-width"), 10);
    if (w) store.set(UI_WIDTH, w);
  });

  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 12;
    let w = parseInt(root.style.getPropertyValue("--r20n-width"), 10) || 340;
    if (e.key === "ArrowLeft") w += step;
    else if (e.key === "ArrowRight") w -= step;
    else return;
    e.preventDefault();
    store.set(UI_WIDTH, applyWidth(w));
  });

  // ------------------------------------------------------------- formatting

  toolbar.addEventListener("mousedown", (e) => {
    // Keep the caret in the editor when a toolbar button is pressed.
    if (e.target.closest("button")) e.preventDefault();
  });

  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    editor.focus({ preventScroll: true });
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
    if (document.activeElement === editor) refreshToolbar();
  });

  // Paste as sanitized markup rather than whatever the source page carried.
  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (html) {
      document.execCommand("insertHTML", false, sanitize(html));
    } else {
      document.execCommand("insertText", false, text);
    }
  });

  // ------------------------------------------------------------------ save

  let saveTimer = null;
  let currentId = null;

  function setStatus(text, tone = "") {
    status.textContent = text;
    status.className = `r20n-status ${tone}`;
  }

  function scheduleSave() {
    if (!currentId) return;
    setStatus("Editing");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    if (!currentId) return;
    const payload = {
      html: sanitize(editor.innerHTML),
      updated: Date.now(),
    };
    const ok = await store.set(notesKey(currentId), payload);
    if (ok) {
      setStatus(`Saved ${new Date(payload.updated).toLocaleTimeString()}`, "is-ok");
    } else {
      setStatus("Could not save. Check that the extension is still enabled.", "is-bad");
    }
  }

  editor.addEventListener("input", scheduleSave);
  editor.addEventListener("blur", () => {
    clearTimeout(saveTimer);
    save();
  });
  window.addEventListener("beforeunload", () => {
    clearTimeout(saveTimer);
    save();
  });

  // ------------------------------------------------------------------ load

  function characterLabel(id) {
    const t = (document.title || "").replace(/\s*\|\s*Roll20.*$/i, "").trim();
    return t || `Character ${id}`;
  }

  async function loadFor(id) {
    currentId = id;
    title.textContent = characterLabel(id);
    const saved = await store.get(notesKey(id), null);
    editor.innerHTML = saved && saved.html ? sanitize(saved.html) : "";
    setStatus(
      saved && saved.updated
        ? `Last saved ${new Date(saved.updated).toLocaleString()}`
        : "No notes yet"
    );
  }

  // Roll20 swaps characters without a full reload, so watch the URL.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    clearTimeout(saveTimer);
    save();
    const id = characterId();
    if (id) {
      loadFor(id);
      root.hidden = false;
    } else {
      root.hidden = true;
      currentId = null;
    }
  }, 800);

  // ------------------------------------------------------------------ boot

  (async () => {
    const id = characterId();
    if (!id) {
      root.hidden = true;
      return;
    }
    applyWidth(await store.get(UI_WIDTH, 340));
    await loadFor(id);
    setOpen(await store.get(UI_OPEN, false), false);
  })();
})();
