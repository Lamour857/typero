import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import welcomeMarkdown from "./welcome.md";

/* ---------------------------------------------------------
   Constants & helpers
   --------------------------------------------------------- */

const MD_EXTENSION = /\.(md|markdown|mdown|mkd|txt)$/i;
const MD_TYPES = [
  {
    description: "Markdown 文稿",
    accept: {
      "text/markdown": [".md", ".markdown", ".mdown", ".mkd"],
      "text/plain": [".txt"]
    }
  }
];
const STORAGE = {
  theme: "typero.theme",
  mode: "typero.mode",
  sidebar: "typero.sidebar",
  split: "typero.split",
  draft: "typero.draft",
  serverSession: "typero.serverSession"
};
const DOMPURIFY_OPTIONS = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_ATTR: ["target", "rel", "align", "disabled", "checked"],
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"]
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
};

const session = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
};

const els = {
  app: $("#app"),
  sidebar: $("#sidebar"),
  sidebarBackdrop: $("#sidebarBackdrop"),
  collapseSidebar: $("#collapseSidebar"),
  openSidebar: $("#openSidebar"),
  fileCard: $("#fileCard"),
  fileName: $("#fileName"),
  fileMeta: $("#fileMeta"),
  docTitle: $("#docTitle"),
  docSubtitle: $("#docSubtitle"),
  sidebarTabs: $$(".sidebar-tab"),
  outlinePanel: $("#outlinePanel"),
  infoPanel: $("#infoPanel"),
  outline: $("#outline"),
  outlineEmpty: $("#outlineEmpty"),
  statWords: $("#statWords"),
  statChars: $("#statChars"),
  statParagraphs: $("#statParagraphs"),
  statTime: $("#statTime"),
  infoFile: $("#infoFile"),
  infoHeadings: $("#infoHeadings"),
  infoUpdated: $("#infoUpdated"),
  saveIndicator: $("#saveIndicator"),
  saveStatus: $("#saveStatus"),
  modeButtons: $$(".mode-btn"),
  openBtn: $("#openBtn"),
  saveBtn: $("#saveBtn"),
  themeToggle: $("#themeToggle"),
  moreBtn: $("#moreBtn"),
  moreMenu: $("#moreMenu"),
  workspace: $("#workspace"),
  sourcePane: $("#sourcePane"),
  previewPane: $("#previewPane"),
  previewScroll: $("#previewScroll"),
  preview: $("#preview"),
  previewEmpty: $("#previewEmpty"),
  editor: $("#editor"),
  divider: $("#divider"),
  cursorPos: $("#cursorPos"),
  sourceStats: $("#sourceStats"),
  readingProgress: $("#readingProgress"),
  readingPill: $("#readingPill"),
  readingPct: $("#readingPct"),
  focusExit: $("#focusExit"),
  dropOverlay: $("#dropOverlay"),
  toast: $("#toast"),
  shortcutsDialog: $("#shortcutsDialog"),
  closeShortcuts: $("#closeShortcuts"),
  fileInput: $("#fileInput"),
  metaThemeColor: document.querySelector('meta[name="theme-color"]')
};

const state = {
  content: "",
  fileName: "未命名.md",
  fileHandle: null,
  serverToken: null,
  serverPath: null,
  draftRestored: false,
  sourceKind: "welcome",
  mode: "split",
  theme: document.documentElement.dataset.theme || "dark",
  sidebarCollapsed: false,
  focus: false,
  preFocusMode: "split",
  dirty: false,
  baseline: null,
  draftSavedAt: null,
  draftError: false,
  updatedAt: Date.now(),
  eol: "\n",
  headings: [],
  outlineItems: new Map(),
  activeHeadingId: null
};

let renderTimer = null;
let statsTimer = null;
let draftTimer = null;
let toastTimer = null;
let scrollRaf = 0;
let suppressSyncUntil = 0;
let dragDepth = 0;
let splitDrag = null;
let lastDraftErrorNotice = 0;

const sluggers = () => {
  const used = new Map();
  return (text) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/<[^>]*>/g, "")
        .replace(/[`*_~]/g, "")
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "section";
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeLoadedText(text) {
  const hasCRLF = /\r\n/.test(text);
  return {
    text: text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"),
    eol: hasCRLF ? "\r\n" : "\n"
  };
}

function toDiskText(text) {
  return state.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function activeDraftKey() {
  return state.serverToken ? `${STORAGE.draft}.session.${state.serverToken}` : STORAGE.draft;
}

function activeDraftStore() {
  return state.serverToken ? session : storage;
}

function clearDraftForToken(token) {
  if (token) session.remove(`${STORAGE.draft}.session.${token}`);
}

function detachServerBinding() {
  if (!state.serverToken) return;
  clearDraftForToken(state.serverToken);
  session.remove(STORAGE.serverSession);
  state.serverToken = null;
  state.serverPath = null;
}

function stripOpenParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("open")) return;
    url.searchParams.delete("open");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* URL cleanup is optional. */
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return "—";
  }
}

function formatNumber(value) {
  try {
    return Number(value).toLocaleString("zh-CN");
  } catch {
    return String(value);
  }
}

function getScrollRatio(element) {
  const max = element.scrollHeight - element.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, element.scrollTop / max)) : 0;
}

function isAtBottom(element) {
  const max = element.scrollHeight - element.clientHeight;
  return max <= 0 || max - element.scrollTop < 6;
}

function closeMenu() {
  els.moreMenu.hidden = true;
  els.moreBtn.setAttribute("aria-expanded", "false");
}

/* ---------------------------------------------------------
   Configure Markdown
   --------------------------------------------------------- */

marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.setOptions({ gfm: true, breaks: false });

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

async function init() {
  applyPreferences();
  bindEvents();
  applyTheme(state.theme, { persist: false });
  applySidebarState({ persist: false });
  applyMode(state.mode, { persist: false, sync: false });
  applySplitRatio(state.splitRatio, { persist: false });

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("open");
  if (urlParams.has("open")) stripOpenParam();
  if (urlToken) session.set(STORAGE.serverSession, urlToken);

  const openToken = urlToken || session.get(STORAGE.serverSession);
  let bootNotice = "";
  let serverLoaded = false;

  if (openToken) {
    serverLoaded = await loadServerDocument(openToken);
    if (serverLoaded) {
      if (state.draftRestored) bootNotice = "已恢复本次未保存的修改";
    } else {
      session.remove(STORAGE.serverSession);
      bootNotice = "无法连接 Typero 本地服务，已打开备用文稿";
      stripOpenParam();
    }
  }

  if (!serverLoaded) {
    loadInitialDocument();
    if (state.sourceKind === "draft") bootNotice = "已恢复上次未保存的草稿";
  }

  setEditorContent(state.content);
  renderNow({ preserveScroll: false });
  updateStats();
  updateCursor();
  updateSaveUi();
  updateReadingProgress();
  updateActiveHeading();

  if (bootNotice) {
    window.setTimeout(() => showToast(bootNotice), 260);
  }
}

async function loadServerDocument(token) {
  try {
    const response = await fetch(`/api/document?token=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data.content !== "string") {
      throw new Error("Invalid document response");
    }

    const normalized = normalizeLoadedText(data.content);
    state.serverToken = token;
    state.serverPath = typeof data.path === "string" ? data.path : null;
    state.fileHandle = null;
    state.sourceKind = "file";
    state.fileName =
      typeof data.name === "string" && data.name ? data.name : "未命名.md";
    state.content = normalized.text;
    state.eol = normalized.eol;
    state.baseline = normalized.text;
    state.dirty = false;
    state.draftSavedAt = null;
    state.draftError = false;
    state.draftRestored = false;
    state.updatedAt = Number(data.mtime) || Date.now();

    const rawDraft = session.get(activeDraftKey());
    if (rawDraft) {
      try {
        const draft = JSON.parse(rawDraft);
        if (draft && typeof draft.content === "string" && draft.content !== state.baseline) {
          state.content = draft.content.replace(/\r\n?/g, "\n");
          if (draft.eol === "\r\n") state.eol = "\r\n";
          state.dirty = true;
          state.draftRestored = true;
          state.draftSavedAt = Number(draft.updatedAt) || Date.now();
          state.updatedAt = state.draftSavedAt;
        } else {
          session.remove(activeDraftKey());
        }
      } catch {
        session.remove(activeDraftKey());
      }
    }

    return true;
  } catch (error) {
    console.error("Failed to load document from Typero service", error);
    state.serverToken = null;
    state.serverPath = null;
    return false;
  }
}

function applyPreferences() {
  const narrow = window.innerWidth <= 1000;
  const savedMode = storage.get(STORAGE.mode);
  if (["read", "split", "source"].includes(savedMode)) {
    state.mode = savedMode;
  } else if (window.innerWidth <= 820) {
    state.mode = "read";
  }

  const savedSidebar = storage.get(STORAGE.sidebar);
  if (!narrow && (savedSidebar === "collapsed" || savedSidebar === "open")) {
    state.sidebarCollapsed = savedSidebar === "collapsed";
  } else {
    state.sidebarCollapsed = narrow;
  }

  const savedSplit = Number.parseFloat(storage.get(STORAGE.split) || "");
  if (Number.isFinite(savedSplit) && savedSplit >= 0.28 && savedSplit <= 0.72) {
    state.splitRatio = savedSplit;
  }
}

function loadInitialDocument() {
  const rawDraft = storage.get(STORAGE.draft);
  let draft = null;

  if (rawDraft) {
    try {
      draft = JSON.parse(rawDraft);
    } catch {
      draft = null;
    }
  }

  if (draft && typeof draft.content === "string") {
    state.content = draft.content.replace(/\r\n?/g, "\n");
    state.fileName = typeof draft.fileName === "string" && draft.fileName ? draft.fileName : "恢复的草稿.md";
    state.sourceKind = "draft";
    state.eol = draft.eol === "\r\n" ? "\r\n" : "\n";
    state.baseline = null;
    state.dirty = true;
    state.draftSavedAt = Number(draft.updatedAt) || Date.now();
    state.updatedAt = Number(draft.updatedAt) || Date.now();
    return;
  }

  state.content = welcomeMarkdown;
  state.fileName = "欢迎使用 Typero.md";
  state.sourceKind = "welcome";
  state.eol = "\n";
  state.baseline = welcomeMarkdown;
  state.dirty = false;
  state.draftSavedAt = null;
  state.updatedAt = Date.now();
}

/* ---------------------------------------------------------
   Event wiring
   --------------------------------------------------------- */

function bindEvents() {
  els.editor.addEventListener("input", onEditorInput);
  els.editor.addEventListener("scroll", onEditorScroll, { passive: true });
  els.editor.addEventListener("keydown", onEditorKeydown);
  els.editor.addEventListener("keyup", scheduleCursorUpdate);
  els.editor.addEventListener("click", scheduleCursorUpdate);
  els.editor.addEventListener("select", scheduleCursorUpdate);
  els.editor.addEventListener("focus", scheduleCursorUpdate);

  els.previewScroll.addEventListener("scroll", onPreviewScroll, { passive: true });
  els.preview.addEventListener("click", onPreviewClick);

  els.openBtn.addEventListener("click", openFile);
  els.fileCard.addEventListener("click", openFile);
  els.saveBtn.addEventListener("click", () => saveFile(false));
  els.themeToggle.addEventListener("click", () => {
    const next = state.theme === "dark" ? "light" : "dark";
    applyTheme(next, { persist: true, animate: true });
  });

  els.collapseSidebar.addEventListener("click", () => applySidebarState({ collapsed: true }));
  els.openSidebar.addEventListener("click", () => applySidebarState({ collapsed: false }));
  els.sidebarBackdrop.addEventListener("click", () => applySidebarState({ collapsed: true }));

  els.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (state.focus) exitFocus();
      applyMode(button.dataset.mode);
    });
  });

  els.sidebarTabs.forEach((tab) => {
    tab.addEventListener("click", () => selectSidebarTab(tab.dataset.tab));
  });

  els.moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = els.moreMenu.hidden;
    els.moreMenu.hidden = !willOpen;
    els.moreBtn.setAttribute("aria-expanded", String(willOpen));
  });

  els.moreMenu.addEventListener("click", (event) => {
    const item = event.target.closest(".menu-item");
    if (!item) return;
    handleMenuAction(item.dataset.action);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) closeMenu();
  });

  els.focusExit.addEventListener("click", exitFocus);

  els.divider.addEventListener("pointerdown", startSplitDrag);
  els.divider.addEventListener("pointermove", moveSplitDrag);
  els.divider.addEventListener("pointerup", endSplitDrag);
  els.divider.addEventListener("pointercancel", endSplitDrag);
  els.divider.addEventListener("dblclick", () => applySplitRatio(0.5));
  els.divider.tabIndex = 0;
  els.divider.addEventListener("keydown", onDividerKeydown);

  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files?.[0];
    els.fileInput.value = "";
    if (file) await loadFile(file, null);
  });

  els.closeShortcuts.addEventListener("click", () => els.shortcutsDialog.close());
  els.shortcutsDialog.addEventListener("click", (event) => {
    if (event.target !== els.shortcutsDialog) return;
    const rect = els.shortcutsDialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) els.shortcutsDialog.close();
  });

  document.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("resize", onWindowResize);

  const narrowQuery = window.matchMedia("(max-width: 1000px)");
  narrowQuery.addEventListener("change", (event) => {
    if (event.matches && !window.matchMedia("print").matches && !state.sidebarCollapsed) {
      applySidebarState({ collapsed: true, persist: false });
    }
  });

  window.addEventListener("storage", (event) => {
    if (
      event.key === STORAGE.theme &&
      (event.newValue === "dark" || event.newValue === "light") &&
      event.newValue !== state.theme
    ) {
      applyTheme(event.newValue, { persist: false });
    }
  });

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    clearTimeout(draftTimer);
    persistDraft({ silent: true });

    if (state.serverToken) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) {
      clearTimeout(draftTimer);
      persistDraft({ silent: true });
    }
  });
}

/* ---------------------------------------------------------
   Editor
   --------------------------------------------------------- */

function setEditorContent(value) {
  els.editor.value = value;
  els.editor.scrollTop = 0;
  els.editor.setSelectionRange(0, 0);
}

function onEditorInput() {
  state.content = els.editor.value;
  refreshDirtyState();
  scheduleCursorUpdate();
  scheduleStats();
  scheduleRender();
  updateReadingProgress();
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderNow({ preserveScroll: true });
  }, 70);
}

function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    statsTimer = null;
    updateStats();
    updateSaveUi();
  }, 160);
}

function scheduleCursorUpdate() {
  window.requestAnimationFrame(updateCursor);
}

function updateCursor() {
  const value = els.editor.value;
  const position = els.editor.selectionStart;
  const before = value.slice(0, position);
  const line = (before.match(/\n/g) || []).length + 1;
  const column = position - before.lastIndexOf("\n");
  els.cursorPos.textContent = `第 ${line} 行，第 ${column} 列`;

  if (state.mode === "source") {
    updateActiveFromCursor(line);
  }
}

function onEditorKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;

  if (event.key === "Tab") {
    handleEditorTab(event);
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    handleListContinuation(event);
    return;
  }

  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.altKey) return;

  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    wrapSelection("**", "**");
  } else if (key === "i") {
    event.preventDefault();
    wrapSelection("*", "*");
  } else if (key === "k") {
    event.preventDefault();
    insertLink();
  } else if (event.key === "`") {
    event.preventDefault();
    wrapSelection("`", "`");
  }
}

function editRange(start, end, text, selectionStart, selectionEnd) {
  els.editor.focus();
  els.editor.setSelectionRange(start, end);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    els.editor.setRangeText(text, start, end, "end");
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (typeof selectionStart === "number") {
    els.editor.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
  }
  scheduleCursorUpdate();
}

function wrapSelection(prefix, suffix) {
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  const selected = els.editor.value.slice(start, end);

  if (start !== end) {
    const replacement = prefix + selected + suffix;
    editRange(start, end, replacement, start + prefix.length, end + prefix.length);
    return;
  }

  const inserted = prefix + suffix;
  editRange(start, end, inserted, start + prefix.length, start + prefix.length);
}

function insertLink() {
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  const selected = els.editor.value.slice(start, end);

  if (selected) {
    const replacement = `[${selected}](https://)`;
    const urlStart = start + selected.length + 3;
    editRange(start, end, replacement, urlStart, urlStart + 8);
    return;
  }

  const label = "链接文字";
  const replacement = `[${label}](https://)`;
  editRange(start, end, replacement, start + 1, start + 1 + label.length);
}

function handleEditorTab(event) {
  event.preventDefault();
  const value = els.editor.value;
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;

  if (start === end) {
    if (!event.shiftKey) {
      editRange(start, end, "  ", start + 2, start + 2);
      return;
    }

    const leading = (value.slice(lineStart).match(/^ {1,2}/) || [""])[0].length;
    if (leading > 0) {
      editRange(lineStart, lineStart + leading, "", Math.max(lineStart, start - leading), Math.max(lineStart, end - leading));
    }
    return;
  }

  // Indent or outdent every line touched by the selection. The selection is
  // kept over the whole block so no selected text is ever discarded.
  const nextBreak = value.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(lineStart, lineEnd);
  const updated = event.shiftKey
    ? block.replace(/^ {1,2}/gm, "")
    : block.replace(/^/gm, "  ");

  editRange(lineStart, lineEnd, updated, lineStart, lineStart + updated.length);
}

function handleListContinuation(event) {
  const position = els.editor.selectionStart;
  if (position !== els.editor.selectionEnd) return;
  if (isInsideFence(els.editor.value, position)) return;

  const before = els.editor.value.slice(0, position);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const match = line.match(/^(\s*)(?:([-*+])|(\d+)\.)(\s+)(\[[ xX]\]\s+)?(.*)$/);
  if (!match) return;

  const [, indent, bullet, number, , task, content] = match;
  event.preventDefault();

  if (!content.trim()) {
    editRange(lineStart, position, "\n", lineStart + 1, lineStart + 1);
    return;
  }

  const marker = bullet ? `${bullet} ` : `${Number(number) + 1}. `;
  const taskMarker = task ? "[ ] " : "";
  const inserted = `\n${indent}${marker}${taskMarker}`;
  editRange(position, position, inserted, position + inserted.length, position + inserted.length);
}

function isInsideFence(text, position) {
  const lines = text.slice(0, position).split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!match) continue;

    if (!inFence) {
      inFence = true;
      fenceChar = match[1][0];
      fenceLength = match[1].length;
    } else if (match[1][0] === fenceChar && match[1].length >= fenceLength) {
      inFence = false;
    }
  }

  return inFence;
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */

function renderNow({ preserveScroll = true } = {}) {
  const ratio = getScrollRatio(els.previewScroll);
  const wasAtBottom = isAtBottom(els.previewScroll);
  const outlineScroll = els.outline.scrollTop;

  state.headings = extractHeadings(state.content);

  let html = "";
  try {
    html = marked.parse(state.content, { async: false });
  } catch (error) {
    console.error("Markdown render failed", error);
    html = "";
  }

  let safeHtml = "";
  try {
    safeHtml = DOMPurify.sanitize(html, DOMPURIFY_OPTIONS);
  } catch (error) {
    console.error("Markdown sanitize failed", error);
    safeHtml = "";
  }

  els.preview.innerHTML = safeHtml;
  decoratePreview();
  els.previewEmpty.hidden = state.content.trim().length > 0;

  if (preserveScroll) {
    const max = els.previewScroll.scrollHeight - els.previewScroll.clientHeight;
    els.previewScroll.scrollTop = wasAtBottom ? max : ratio * Math.max(0, max);
  }

  renderOutline();
  els.outline.scrollTop = outlineScroll;
  updateStats();
  updateReadingProgress();
  updateActiveHeading();
}

function extractHeadings(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  const slug = sluggers();
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let inFrontmatter = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (index === 0 && /^---[ \t]*$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)[ \t]*$/.test(line)) inFrontmatter = false;
      continue;
    }

    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
        fenceLength = fence[1].length;
      } else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;

    const atx = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
    if (atx) {
      const text = cleanInlineText(atx[2]);
      if (text) {
        result.push({
          id: slug(text),
          level: atx[1].length,
          text,
          line: index,
          index: result.length
        });
      }
      continue;
    }

    const setext = line.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (setext) {
      const previous = lines[index - 1];
      const previousIsHeadingText =
        previous &&
        previous.trim() &&
        !/^ {4,}/.test(previous) &&
        !/^\s*(?:>|[-*+]\s|\d+\.\s|\||<|`{3,}|~{3,})/.test(previous) &&
        !/^ {0,3}#{1,6}[ \t]+/.test(previous) &&
        !/^\[[^\]]+\]:/.test(previous.trim());

      if (previousIsHeadingText) {
        const text = cleanInlineText(previous);
        if (text) {
          result.push({
            id: slug(text),
            level: setext[1][0] === "=" ? 1 : 2,
            text,
            line: index - 1,
            index: result.length
          });
        }
      }
    }
  }

  return result;
}

function cleanInlineText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decoratePreview() {
  assignHeadingAnchors();
  decorateLinks();
  wrapTables();
  decorateCodeBlocks();
  decorateTaskLists();
  decorateImages();
}

function assignHeadingAnchors() {
  const slug = sluggers();
  const headings = Array.from(els.preview.querySelectorAll("h1, h2, h3, h4, h5, h6"));

  headings.forEach((heading, index) => {
    const text = heading.textContent.replace(/\s+/g, " ").trim();
    const id = slug(text);
    heading.id = id;

    const sourceHeading = state.headings[index];
    if (sourceHeading) {
      sourceHeading.id = id;
      sourceHeading.text = text;
      sourceHeading.level = Number(heading.tagName.slice(1));
    } else {
      const previous = state.headings[index - 1];
      state.headings.push({
        id,
        text,
        level: Number(heading.tagName.slice(1)),
        line: previous?.line ?? 0,
        index
      });
    }

    const anchor = document.createElement("a");
    anchor.className = "heading-anchor";
    anchor.href = `#${id}`;
    anchor.textContent = "#";
    anchor.title = `跳转到「${text}」`;
    anchor.setAttribute("aria-label", `跳转到 ${text}`);
    anchor.tabIndex = -1;
    heading.appendChild(anchor);
  });

  // The outline should mirror what is actually rendered, not raw regex matches.
  state.headings.length = Math.min(state.headings.length, headings.length);
  state.headings.forEach((heading, index) => {
    heading.index = index;
  });
}

function decorateLinks() {
  for (const link of els.preview.querySelectorAll("a[href]")) {
    const href = (link.getAttribute("href") || "").trim();
    if (/^(https?:)?\/\//i.test(href)) {
      link.classList.add("external-link");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}

function wrapTables() {
  for (const table of els.preview.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("table-wrap")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrap";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}

function normalizeLanguage(language) {
  const aliases = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    rs: "rust",
    yml: "yaml",
    html: "xml",
    svg: "xml",
    md: "markdown",
    csharp: "csharp",
    "c#": "csharp",
    "c++": "cpp",
    cs: "csharp"
  };
  return aliases[language] || language;
}

function decorateCodeBlocks() {
  const blocks = Array.from(els.preview.querySelectorAll("pre > code"));

  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains("code-block")) continue;

    const classMatch = (code.className || "").match(/language-([\w+#.-]+)/i);
    const rawLanguage = classMatch ? classMatch[1].toLowerCase() : "";
    const language = rawLanguage ? normalizeLanguage(rawLanguage) : "";

    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(code.textContent, {
          language,
          ignoreIllegals: true
        });
        code.innerHTML = highlighted.value;
        code.classList.add("hljs");
      } catch {
        /* Keep plain text when highlighting fails. */
      }
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";

    const bar = document.createElement("div");
    bar.className = "code-bar";

    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = rawLanguage || "text";

    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.type = "button";
    copy.setAttribute("aria-label", "复制代码");
    copy.innerHTML = '<svg aria-hidden="true"><use href="#i-copy"></use></svg><span>复制</span>';
    copy.addEventListener("click", async () => {
      const copied = await copyText(code.textContent);
      if (!copied) {
        showToast("复制失败，请手动选择代码", "error");
        return;
      }
      copy.classList.add("is-copied");
      copy.innerHTML = '<svg aria-hidden="true"><use href="#i-check"></use></svg><span>已复制</span>';
      window.setTimeout(() => {
        copy.classList.remove("is-copied");
        copy.innerHTML = '<svg aria-hidden="true"><use href="#i-copy"></use></svg><span>复制</span>';
      }, 1600);
    });

    bar.append(label, copy);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(bar, pre);
  }
}

function getTaskLines(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  const pattern = /^((?:\s*>\s*)*\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
        fenceLength = fence[1].length;
      } else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;
    if (pattern.test(line)) result.push({ line: index });
  }

  return result;
}

function decorateTaskLists() {
  const checkboxes = Array.from(els.preview.querySelectorAll('input[type="checkbox"]'));
  if (!checkboxes.length) return;

  const taskLines = getTaskLines(state.content);

  checkboxes.forEach((checkbox, index) => {
    const listItem = checkbox.closest("li");
    if (listItem) listItem.classList.add("task-list-item");

    if (index >= taskLines.length) {
      checkbox.disabled = true;
      return;
    }

    checkbox.disabled = false;
    checkbox.removeAttribute("disabled");
    checkbox.setAttribute("aria-label", "切换任务完成状态");
    checkbox.addEventListener("change", () => toggleTask(index, checkbox.checked));
  });
}

function toggleTask(index, checked) {
  const taskLines = getTaskLines(state.content);
  if (!taskLines[index]) return;

  const lines = state.content.split("\n");
  const lineIndex = taskLines[index].line;
  const pattern = /^((?:\s*>\s*)*\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
  lines[lineIndex] = lines[lineIndex].replace(pattern, (_, opening, __, closing) => {
    return `${opening}${checked ? "x" : " "}${closing}`;
  });

  replaceEditorContent(lines.join("\n"));
  showToast(checked ? "任务已完成" : "任务已重新打开");
}

function decorateImages() {
  for (const image of els.preview.querySelectorAll("img")) {
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    const reportBroken = () => showBrokenImage(image);
    image.addEventListener("error", reportBroken, { once: true });
    if (image.complete && image.naturalWidth === 0) {
      reportBroken();
    }
  }
}

function showBrokenImage(image) {
  if (image.dataset.fallbackShown === "true") return;
  image.dataset.fallbackShown = "true";
  image.classList.add("is-broken");

  const fallback = document.createElement("div");
  fallback.className = "image-fallback";
  fallback.innerHTML =
    '<svg aria-hidden="true"><use href="#i-image"></use></svg><span></span>';
  fallback.querySelector("span").textContent = image.getAttribute("alt") || "图片无法显示";
  image.after(fallback);
}

function renderOutline() {
  const headings = state.headings;
  els.outline.innerHTML = "";
  state.outlineItems.clear();
  els.outlineEmpty.hidden = headings.length > 0;

  for (const heading of headings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-item";
    button.dataset.id = heading.id;
    button.dataset.level = String(heading.level);
    button.style.setProperty("--indent", `${Math.max(0, Math.min(heading.level - 1, 3)) * 12}px`);
    button.textContent = heading.text;
    button.title = heading.text;
    button.addEventListener("click", () => navigateToHeading(heading));
    els.outline.appendChild(button);
    state.outlineItems.set(heading.id, button);
  }

  if (state.activeHeadingId && !state.outlineItems.has(state.activeHeadingId)) {
    state.activeHeadingId = null;
  }
  setActiveHeading(state.activeHeadingId, { force: true });
}

/* ---------------------------------------------------------
   Preview interactions
   --------------------------------------------------------- */

function onPreviewClick(event) {
  const link = event.target.closest("a");
  if (!link) return;

  const href = (link.getAttribute("href") || "").trim();
  if (!href) return;

  if (href.startsWith("#")) {
    event.preventDefault();
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* Keep the raw fragment when it is not valid percent-encoding. */
    }
    const target = document.getElementById(id);
    if (target) {
      const top =
        target.getBoundingClientRect().top -
        els.previewScroll.getBoundingClientRect().top +
        els.previewScroll.scrollTop -
        22;
      els.previewScroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      suppressSyncUntil = performance.now() + 500;

      if (state.mode === "split") {
        const heading = state.headings.find((item) => item.id === id);
        if (heading) scrollEditorToLine(heading.line, { focus: false });
      }
    }
    return;
  }

  if (/^(https?:|mailto:)/i.test(href)) {
    return;
  }

  event.preventDefault();
  showToast("相对路径链接需要在本地文件系统中打开", "error");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/* ---------------------------------------------------------
   Outline & navigation
   --------------------------------------------------------- */

function navigateToHeading(heading) {
  setActiveHeading(heading.id, { force: true });

  if (state.mode !== "source") {
    const target = document.getElementById(heading.id);
    if (target) {
      const top =
        target.getBoundingClientRect().top -
        els.previewScroll.getBoundingClientRect().top +
        els.previewScroll.scrollTop -
        22;
      els.previewScroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      suppressSyncUntil = performance.now() + 520;
    }
  }

  if (state.mode !== "read") {
    scrollEditorToLine(heading.line, { focus: state.mode === "source" });
  }

  if (window.innerWidth <= 1000) {
    applySidebarState({ collapsed: true });
  }
}

function scrollEditorToLine(lineIndex, { focus = false } = {}) {
  if (lineIndex == null) return;

  const style = window.getComputedStyle(els.editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const target = Math.max(0, paddingTop + lineIndex * lineHeight - els.editor.clientHeight * 0.18);

  if (focus) els.editor.focus();

  const offset = getLineOffset(state.content, lineIndex);
  if (focus) els.editor.setSelectionRange(offset, offset);

  els.editor.scrollTo({ top: target, behavior: "smooth" });
  if (focus) scheduleCursorUpdate();
}

function getLineOffset(text, lineIndex) {
  if (lineIndex <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      seen += 1;
      if (seen === lineIndex) return index + 1;
    }
  }
  return text.length;
}

function updateActiveHeading() {
  if (state.mode === "source") {
    updateActiveFromCursor();
    return;
  }

  const headings = Array.from(els.preview.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  if (!headings.length) {
    setActiveHeading(null);
    return;
  }

  const paneRect = els.previewScroll.getBoundingClientRect();
  const threshold = paneRect.top + Math.min(140, els.previewScroll.clientHeight * 0.22);
  let active = headings[0];

  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= threshold) {
      active = heading;
    } else {
      break;
    }
  }

  setActiveHeading(active.id || null);
}

function updateActiveFromCursor(line) {
  if (!state.headings.length) {
    setActiveHeading(null);
    return;
  }

  let current = null;
  for (const heading of state.headings) {
    if (heading.line < line) current = heading;
    else break;
  }

  setActiveHeading(current?.id || null);
}

function setActiveHeading(id, { force = false } = {}) {
  if (!force && state.activeHeadingId === id) return;
  state.activeHeadingId = id;

  for (const [key, button] of state.outlineItems.entries()) {
    button.classList.toggle("is-active", key === id);
  }

  if (id && state.outlineItems.has(id)) {
    const button = state.outlineItems.get(id);
    button.scrollIntoView({ block: "nearest" });
  }
}

/* ---------------------------------------------------------
   Scroll sync & progress
   --------------------------------------------------------- */

function onEditorScroll() {
  if (state.mode === "source") updateReadingProgress();

  if (state.mode !== "split" || performance.now() < suppressSyncUntil) return;
  suppressSyncUntil = performance.now() + 60;

  const ratio = getScrollRatio(els.editor);
  const max = els.previewScroll.scrollHeight - els.previewScroll.clientHeight;
  els.previewScroll.scrollTop = ratio * Math.max(0, max);
}

function onPreviewScroll() {
  updateReadingProgress();

  if (!scrollRaf) {
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0;
      updateActiveHeading();
    });
  }

  if (state.mode !== "split" || performance.now() < suppressSyncUntil) return;
  suppressSyncUntil = performance.now() + 60;

  const ratio = getScrollRatio(els.previewScroll);
  const max = els.editor.scrollHeight - els.editor.clientHeight;
  els.editor.scrollTop = ratio * Math.max(0, max);
}

function updateReadingProgress() {
  const element = state.mode === "source" ? els.editor : els.previewScroll;
  const ratio = getScrollRatio(element);
  const percentage = Math.round(ratio * 100);

  els.readingProgress.style.transform = `scaleX(${ratio})`;
  els.readingPct.textContent = `${percentage}%`;
}

/* ---------------------------------------------------------
   Stats
   --------------------------------------------------------- */

function computeStats(text) {
  const cjkPattern = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;
  const cjkCount = (text.match(cjkPattern) || []).length;
  const withoutCjk = text.replace(cjkPattern, " ");
  const latinWords = (withoutCjk.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []).length;
  const words = cjkCount + latinWords;
  const chars = text.replace(/\s/g, "").length;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean).length;
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(cjkCount / 350 + latinWords / 220));

  return { words, chars, paragraphs, minutes };
}

function updateStats() {
  const stats = computeStats(state.content);

  els.statWords.textContent = formatNumber(stats.words);
  els.statChars.textContent = formatNumber(stats.chars);
  els.statParagraphs.textContent = formatNumber(stats.paragraphs);
  els.statTime.textContent = formatNumber(stats.minutes);
  els.sourceStats.textContent = `${formatNumber(stats.words)} 字`;
  els.infoFile.textContent = state.fileName;
  els.infoHeadings.textContent = `${formatNumber(state.headings.length)} 个`;
  els.infoUpdated.textContent = formatTime(state.updatedAt);
}

/* ---------------------------------------------------------
   Dirty state & drafts
   --------------------------------------------------------- */

function refreshDirtyState() {
  state.dirty = state.baseline === null ? true : state.content !== state.baseline;

  if (state.dirty) {
    state.updatedAt = Date.now();
    scheduleDraft();
  } else {
    clearTimeout(draftTimer);
    draftTimer = null;
    state.draftSavedAt = null;
    activeDraftStore().remove(activeDraftKey());
  }

  updateSaveUi();
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = null;
    persistDraft();
  }, 850);
}

function persistDraft({ silent = false } = {}) {
  if (!state.dirty) return;

  const payload = {
    v: 1,
    content: state.content,
    fileName: state.fileName,
    eol: state.eol,
    updatedAt: state.updatedAt || Date.now()
  };

  const saved = activeDraftStore().set(activeDraftKey(), JSON.stringify(payload));
  if (saved) {
    state.draftSavedAt = Date.now();
    state.draftError = false;
  } else {
    state.draftError = true;
    if (!silent && Date.now() - lastDraftErrorNotice > 8000) {
      lastDraftErrorNotice = Date.now();
      showToast("无法写入本地草稿，请及时保存文件", "error");
    }
  }

  updateSaveUi();
}

function updateSaveUi() {
  const indicator = els.saveIndicator;
  indicator.classList.remove("is-saved", "is-dirty", "is-error");

  const isFile =
    state.sourceKind === "file" && Boolean(state.fileHandle || state.serverToken);
  let status;
  let meta;
  let subtitle;

  if (state.draftError) {
    indicator.classList.add("is-error");
    status = "本地草稿保存失败";
  } else if (state.dirty) {
    indicator.classList.add("is-dirty");
    if (state.serverToken) {
      status = state.draftSavedAt ? "未保存 · 关闭前请保存" : "有未保存的更改";
    } else {
      status = state.draftSavedAt ? "未保存 · 草稿已备份" : "有未保存的更改";
    }
  } else if (state.sourceKind === "welcome") {
    status = "示例文稿";
  } else if (isFile) {
    indicator.classList.add("is-saved");
    status = "已保存到文件";
  } else if (state.sourceKind === "download") {
    indicator.classList.add("is-saved");
    status = "已下载副本";
  } else if (state.sourceKind === "opened") {
    status = "已打开 · 请另存";
  } else if (state.sourceKind === "new") {
    status = "尚未保存";
  } else {
    status = "未保存";
  }

  if (state.dirty) {
    meta = isFile || state.sourceKind === "file" ? "本地文件 · 未保存" : "本地草稿 · 未保存";
    subtitle = meta;
  } else if (state.sourceKind === "welcome") {
    meta = "示例文稿 · 可另存";
    subtitle = "示例文稿 · 本地 Markdown";
  } else if (isFile) {
    meta = "本地文件 · 已保存";
    subtitle = "本地文件 · Markdown";
  } else if (state.sourceKind === "download") {
    meta = "已下载副本";
    subtitle = "Markdown · 已下载";
  } else if (state.sourceKind === "opened") {
    meta = "已打开 · 未关联文件";
    subtitle = "本地 Markdown · 请另存";
  } else if (state.sourceKind === "new") {
    meta = "尚未保存";
    subtitle = "新建的 Markdown 文稿";
  } else {
    meta = "本地草稿";
    subtitle = "本地草稿";
  }

  els.saveStatus.textContent = status;
  els.fileMeta.textContent = meta;
  els.fileName.textContent = state.fileName;
  els.docTitle.textContent = state.fileName;
  els.docSubtitle.textContent = subtitle;
  els.infoFile.textContent = state.fileName;
  els.infoFile.title = state.serverPath || state.fileName;
  els.fileCard.title = state.serverPath || "打开一个 Markdown 文件";
  els.infoUpdated.textContent = formatTime(state.updatedAt);
  els.saveBtn.classList.toggle("has-changes", state.dirty);
  document.title = `${state.dirty ? "● " : ""}${state.fileName} — Typero`;
}

/* ---------------------------------------------------------
   Content replacement (tasks, external edits)
   --------------------------------------------------------- */

function replaceEditorContent(next, { focusEditor = false } = {}) {
  const selectionStart = els.editor.selectionStart;
  const selectionEnd = els.editor.selectionEnd;
  const scrollTop = els.editor.scrollTop;

  state.content = next;
  els.editor.value = next;
  els.editor.scrollTop = scrollTop;

  const safeStart = Math.min(selectionStart, next.length);
  const safeEnd = Math.min(selectionEnd, next.length);
  els.editor.setSelectionRange(safeStart, safeEnd);
  if (focusEditor) els.editor.focus();

  refreshDirtyState();
  renderNow({ preserveScroll: true });
  updateCursor();
  updateReadingProgress();
}

/* ---------------------------------------------------------
   Files
   --------------------------------------------------------- */

function confirmDiscard() {
  if (!state.dirty) return true;
  return window.confirm("当前文稿还有未保存的更改。\n继续操作会丢弃这些更改，是否继续？");
}

async function openFile() {
  closeMenu();
  if (!confirmDiscard()) return;

  if (typeof window.showOpenFilePicker === "function") {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: MD_TYPES,
        multiple: false,
        excludeAcceptAllOption: false
      });
      if (!handle) return;
      const file = await handle.getFile();
      await loadFile(file, handle);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("File picker unavailable, falling back to file input.", error);
      els.fileInput.click();
      return;
    }
  }

  els.fileInput.click();
}

async function loadFile(file, handle) {
  try {
    if (file.size > 24 * 1024 * 1024) {
      showToast("文件过大（超过 24 MB），暂不打开", "error");
      return;
    }

    const raw = await file.text();
    const normalized = normalizeLoadedText(raw);

    if (state.focus) exitFocus();
    clearTimeout(draftTimer);
    draftTimer = null;
    if (state.serverToken) detachServerBinding();

    state.content = normalized.text;
    state.eol = normalized.eol;
    state.fileName = file.name || "未命名.md";
    state.fileHandle = handle || null;
    state.sourceKind = handle ? "file" : "opened";
    state.baseline = normalized.text;
    state.dirty = false;
    state.draftSavedAt = null;
    state.draftError = false;
    state.updatedAt = Number(file.lastModified) || Date.now();

    storage.remove(STORAGE.draft);
    setEditorContent(state.content);
    els.previewScroll.scrollTop = 0;
    renderNow({ preserveScroll: false });
    updateStats();
    updateCursor();
    updateSaveUi();
    updateReadingProgress();
    if (window.innerWidth <= 1000) applySidebarState({ collapsed: true });
    showToast(`已打开「${state.fileName}」`);
  } catch (error) {
    console.error("Failed to open file", error);
    showToast("无法读取这个文件", "error");
  }
}

async function saveFile(forceSaveAs = false) {
  closeMenu();
  const snapshot = state.content;

  if (!forceSaveAs && state.serverToken) {
    try {
      const response = await fetch(
        `/api/save?token=${encodeURIComponent(state.serverToken)}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: toDiskText(snapshot)
        }
      );
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json().catch(() => null);
      if (data?.mtime) state.updatedAt = data.mtime;
      completeSave(snapshot, "file");
    } catch (error) {
      console.error("Failed to save through Typero service", error);
      showToast("无法写入本地文件，Typero 本地服务可能已停止", "error");
    }
    return;
  }

  if (!forceSaveAs && state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(toDiskText(snapshot));
      await writable.close();
      completeSave(snapshot, "file");
      return;
    } catch (error) {
      console.error("Failed to write file", error);
      showToast("无法写入原文件，请使用“另存为”", "error");
      return;
    }
  }

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggestFileName(),
        types: MD_TYPES,
        excludeAcceptAllOption: false
      });
      const writable = await handle.createWritable();
      await writable.write(toDiskText(snapshot));
      await writable.close();

      detachServerBinding();
      state.fileHandle = handle;
      if (handle.name) state.fileName = handle.name;
      completeSave(snapshot, "file");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error("Failed to save file", error);
      showToast("保存失败，请重试或使用浏览器下载", "error");
      return;
    }
  }

  downloadMarkdown(snapshot);
}

function suggestFileName() {
  if (MD_EXTENSION.test(state.fileName)) return state.fileName;
  return `${state.fileName || "未命名"}.md`;
}

function completeSave(snapshot, kind) {
  const contentChanged = state.content !== snapshot;
  state.baseline = snapshot;
  state.sourceKind = kind;
  state.updatedAt = Date.now();

  if (!contentChanged) {
    state.dirty = false;
    state.draftSavedAt = null;
    state.draftError = false;
    clearTimeout(draftTimer);
    draftTimer = null;
    activeDraftStore().remove(activeDraftKey());
    updateSaveUi();
    showToast(kind === "download" ? "已下载 Markdown 副本" : `已保存「${state.fileName}」`);
    return;
  }

  state.dirty = true;
  scheduleDraft();
  updateSaveUi();
  showToast("文件已保存，但保存过程中又有新的修改");
}

function downloadMarkdown(snapshot) {
  const fileName = suggestFileName();
  const blob = new Blob([toDiskText(snapshot)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);

  state.fileName = fileName;
  state.fileHandle = null;
  detachServerBinding();
  completeSave(snapshot, "download");
}

function newDocument() {
  closeMenu();
  if (!confirmDiscard()) return;

  if (state.focus) exitFocus();
  clearTimeout(renderTimer);
  clearTimeout(draftTimer);
  clearTimeout(statsTimer);
  renderTimer = null;
  draftTimer = null;
  statsTimer = null;
  if (state.serverToken) detachServerBinding();

  state.content = "";
  state.fileName = "未命名.md";
  state.fileHandle = null;
  state.sourceKind = "new";
  state.baseline = "";
  state.dirty = false;
  state.draftSavedAt = null;
  state.draftError = false;
  state.eol = "\n";
  state.updatedAt = Date.now();
  state.headings = [];

  storage.remove(STORAGE.draft);
  setEditorContent("");
  els.previewScroll.scrollTop = 0;
  renderNow({ preserveScroll: false });
  updateStats();
  updateCursor();
  updateSaveUi();
  updateReadingProgress();

  if (state.mode === "read") applyMode("split", { persist: false, sync: false });
  els.editor.focus();
  showToast("已新建空白文稿");
}

/* ---------------------------------------------------------
   Menu, export, focus mode
   --------------------------------------------------------- */

function handleMenuAction(action) {
  closeMenu();

  if (action === "new") {
    newDocument();
  } else if (action === "save-as") {
    saveFile(true);
  } else if (action === "export") {
    exportHtml();
  } else if (action === "print") {
    printDocument();
  } else if (action === "focus") {
    toggleFocus();
  } else if (action === "shortcuts") {
    openShortcuts();
  }
}

function printDocument() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
    renderNow({ preserveScroll: true });
  }
  window.setTimeout(() => window.print(), 60);
}

function exportHtml() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
    renderNow({ preserveScroll: true });
  }

  const clone = els.preview.cloneNode(true);
  clone.querySelectorAll(".heading-anchor, .code-bar, .image-fallback").forEach((node) => node.remove());

  clone.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.disabled = true;
    input.setAttribute("disabled", "");
  });

  clone.querySelectorAll(".katex").forEach((element) => {
    const math = element.querySelector("math");
    if (math) {
      element.replaceWith(math.cloneNode(true));
    } else {
      element.remove();
    }
  });

  const firstHeading = state.headings[0]?.text;
  const baseName = state.fileName.replace(/\.[^.]+$/, "") || "Typero 文稿";
  const title = firstHeading || baseName;
  const html = buildExportHtml(title, clone.innerHTML);

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  showToast("已导出自包含 HTML 文件");
}

function buildExportHtml(title, body) {
  const css = `
    :root {
      color-scheme: light dark;
      --bg: #fbfaf7; --text: #3b3933; --strong: #1d1c19; --muted: #777269;
      --line: rgba(48,42,31,.12); --accent: #b3653b; --link: #2f66c4;
      --code-bg: #f2efe8; --inline-bg: #f0ece4; --inline-text: #9d4b27;
      --quote-bg: rgba(179,101,59,.05); --surface: #efece5;
      --mono: "Cascadia Code", Consolas, "SFMono-Regular", monospace;
      --serif: "Iowan Old Style", "Palatino Linotype", Georgia, "Songti SC", serif;
      --ui: "Segoe UI", -apple-system, BlinkMacSystemFont, "Microsoft YaHei UI", "PingFang SC", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #121317; --text: #d5d7dc; --strong: #f2f3f5; --muted: #8c9099;
        --line: rgba(255,255,255,.09); --accent: #e0a66b; --link: #84b1f7;
        --code-bg: #181a1f; --inline-bg: #1c1e24; --inline-text: #e6b585;
        --quote-bg: rgba(224,166,107,.055); --surface: #23252c;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--ui); font-size: 16.5px; line-height: 1.86; }
    .markdown-body { max-width: 780px; margin: 0 auto; padding: 64px 28px 120px; overflow-wrap: break-word; }
    h1, h2, h3, h4, h5, h6 { position: relative; margin: 2em 0 .72em; color: var(--strong); font-family: var(--serif); font-weight: 600; line-height: 1.3; letter-spacing: -.012em; }
    h1 { font-size: 2.5em; margin-bottom: 1.2em; letter-spacing: -.025em; line-height: 1.16; }
    h1::before { content: ""; display: block; width: 34px; height: 3px; margin-bottom: 22px; border-radius: 3px; background: var(--accent); }
    h2 { padding-bottom: .4em; border-bottom: 1px solid var(--line); font-size: 1.6em; }
    h3 { font-size: 1.29em; }
    h4, h5, h6 { font-family: var(--ui); font-weight: 650; }
    h6 { color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .markdown-body > :first-child { margin-top: 0; }
    p { margin: 0 0 1.22em; }
    strong { color: var(--strong); }
    a { color: var(--link); text-decoration-color: rgba(47,102,196,.3); text-underline-offset: 3px; }
    ul, ol { padding-left: 1.55em; margin: 0 0 1.25em; }
    li { margin: .32em 0; }
    li::marker { color: var(--muted); }
    .task-list-item { list-style: none; }
    .task-list-item input { margin: 0 .55em 0 -1.45em; accent-color: var(--accent); }
    blockquote { margin: 1.55em 0; padding: 1em 1.3em; border-left: 2px solid var(--accent); border-radius: 0 10px 10px 0; background: var(--quote-bg); color: var(--muted); }
    blockquote > :last-child { margin-bottom: 0; }
    hr { height: 1px; margin: 2.6em 0; border: 0; background: var(--line); }
    code { padding: .17em .42em; border: 1px solid var(--line); border-radius: 5px; background: var(--inline-bg); color: var(--inline-text); font-family: var(--mono); font-size: .855em; }
    .code-block { margin: 1.55em 0; overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--code-bg); }
    pre { margin: 0; padding: 16px 18px; overflow-x: auto; font-family: var(--mono); font-size: 13px; line-height: 1.68; }
    pre code { padding: 0; border: 0; background: transparent; color: var(--text); font-size: inherit; white-space: pre; }
    .hljs-comment, .hljs-quote { color: #8b8579; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #9a3b8c; }
    .hljs-string, .hljs-regexp { color: #3e7737; }
    .hljs-number, .hljs-symbol { color: #ac5826; }
    .hljs-title, .hljs-section { color: #79500b; }
    .hljs-function .hljs-title, .hljs-built_in { color: #2b5f9f; }
    .hljs-attr, .hljs-attribute { color: #8b5d08; }
    .hljs-tag { color: #b03a47; }
    .hljs-meta { color: #6c6a64; }
    @media (prefers-color-scheme: dark) {
      .hljs-comment, .hljs-quote { color: #6f7681; }
      .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #c79ce8; }
      .hljs-string, .hljs-regexp { color: #9ecf9a; }
      .hljs-number, .hljs-symbol { color: #e9a36c; }
      .hljs-title, .hljs-section { color: #ecc477; }
      .hljs-function .hljs-title, .hljs-built_in { color: #84b1f7; }
      .hljs-attr, .hljs-attribute { color: #e4be7c; }
      .hljs-tag { color: #ef8790; }
      .hljs-meta { color: #a4b1bd; }
    }
    .table-wrap { margin: 1.55em 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: .9em; }
    th, td { padding: .62em .9em; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: var(--surface); color: var(--strong); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    img { display: block; max-width: 100%; height: auto; margin: 1.8em auto; border: 1px solid var(--line); border-radius: 10px; }
    kbd { display: inline-flex; align-items: center; min-width: 20px; height: 22px; padding: 0 6px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; background: var(--surface); color: var(--text); font-family: var(--ui); font-size: 10.5px; }
    mark { padding: .05em .2em; border-radius: 3px; background: var(--quote-bg); color: var(--strong); }
    math { font-size: 1.1em; }
    .katex-display { margin: 1.5em 0; text-align: center; overflow-x: auto; }
    @media print { body { background: #fff; } .markdown-body { max-width: none; padding: 0; } a { color: inherit; } }
    @page { margin: 18mm 16mm; }
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="Typero">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<article class="markdown-body">
${body}
</article>
</body>
</html>`;
}

function openShortcuts() {
  closeMenu();
  if (!els.shortcutsDialog.open) els.shortcutsDialog.showModal();
}

function toggleFocus(force) {
  const turnOn = typeof force === "boolean" ? force : !state.focus;
  if (turnOn === state.focus) return;
  closeMenu();

  if (turnOn) {
    state.preFocusMode = state.mode;
    const sourceRatio = state.mode === "source" ? getScrollRatio(els.editor) : null;
    state.focus = true;
    if (state.mode !== "read") {
      applyMode("read", { persist: false, sync: false });
    }
    els.app.classList.add("is-focus");
    window.requestAnimationFrame(() => {
      if (sourceRatio !== null) {
        const max = els.previewScroll.scrollHeight - els.previewScroll.clientHeight;
        els.previewScroll.scrollTop = sourceRatio * Math.max(0, max);
      }
      updateReadingProgress();
      updateActiveHeading();
    });
  } else {
    els.app.classList.remove("is-focus");
    state.focus = false;
    applyMode(state.preFocusMode || "read", { persist: false, sync: false });
    window.requestAnimationFrame(() => {
      updateReadingProgress();
      updateActiveHeading();
    });
  }
}

function exitFocus() {
  if (state.focus) toggleFocus(false);
}

/* ---------------------------------------------------------
   Modes, theme, sidebar
   --------------------------------------------------------- */

function applyMode(mode, { persist = true, sync = true } = {}) {
  if (!["read", "split", "source"].includes(mode)) return;

  const previous = state.mode;
  state.mode = mode;
  els.workspace.dataset.mode = mode;

  for (const button of els.modeButtons) {
    const isActive = button.dataset.mode === mode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  if (persist) storage.set(STORAGE.mode, mode);

  window.requestAnimationFrame(() => {
    if (sync) {
      if (mode === "split") {
        if (previous === "source") {
          const ratio = getScrollRatio(els.editor);
          const max = els.previewScroll.scrollHeight - els.previewScroll.clientHeight;
          els.previewScroll.scrollTop = ratio * Math.max(0, max);
        } else if (previous === "read") {
          const ratio = getScrollRatio(els.previewScroll);
          const max = els.editor.scrollHeight - els.editor.clientHeight;
          els.editor.scrollTop = ratio * Math.max(0, max);
        }
      } else if (mode === "source" && previous === "read") {
        const ratio = getScrollRatio(els.previewScroll);
        const max = els.editor.scrollHeight - els.editor.clientHeight;
        els.editor.scrollTop = ratio * Math.max(0, max);
      } else if (mode === "read" && previous === "source") {
        const ratio = getScrollRatio(els.editor);
        const max = els.previewScroll.scrollHeight - els.previewScroll.clientHeight;
        els.previewScroll.scrollTop = ratio * Math.max(0, max);
      }
    }

    updateReadingProgress();
    updateActiveHeading();
    if (mode === "source") updateCursor();
  });
}

function applyTheme(theme, { persist = true, animate = false } = {}) {
  const next = theme === "light" ? "light" : "dark";
  state.theme = next;

  if (animate) {
    document.documentElement.classList.add("theme-transition");
    window.setTimeout(() => document.documentElement.classList.remove("theme-transition"), 360);
  }

  document.documentElement.dataset.theme = next;
  if (els.metaThemeColor) {
    els.metaThemeColor.setAttribute("content", next === "dark" ? "#121317" : "#fbfaf7");
  }

  const label = next === "dark" ? "切换到浅色主题" : "切换到深色主题";
  els.themeToggle.title = label;
  els.themeToggle.setAttribute("aria-label", label);

  if (persist) storage.set(STORAGE.theme, next);
}

function applySidebarState({ collapsed, persist = true } = {}) {
  if (typeof collapsed === "boolean") state.sidebarCollapsed = collapsed;
  els.app.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
  if (persist) storage.set(STORAGE.sidebar, state.sidebarCollapsed ? "collapsed" : "open");
}

function selectSidebarTab(tabName) {
  for (const tab of els.sidebarTabs) {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }

  const showOutline = tabName === "outline";
  els.outlinePanel.hidden = !showOutline;
  els.infoPanel.hidden = showOutline;
}

function applySplitRatio(ratio, { persist = true } = {}) {
  const next = Math.min(0.72, Math.max(0.28, Number(ratio) || 0.5));
  state.splitRatio = next;
  els.workspace.style.setProperty("--source-width", `${next * 100}%`);
  els.divider.setAttribute("aria-valuenow", String(Math.round(next * 100)));
  els.divider.setAttribute("aria-valuemin", "28");
  els.divider.setAttribute("aria-valuemax", "72");
  if (persist) storage.set(STORAGE.split, String(next));
}

function startSplitDrag(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  splitDrag = {
    pointerId: event.pointerId,
    rect: els.workspace.getBoundingClientRect()
  };
  els.divider.setPointerCapture(event.pointerId);
  els.divider.classList.add("is-dragging");
  document.body.classList.add("is-resizing");
}

function moveSplitDrag(event) {
  if (!splitDrag) return;
  const ratio = (event.clientX - splitDrag.rect.left) / splitDrag.rect.width;
  applySplitRatio(ratio, { persist: false });
}

function endSplitDrag(event) {
  if (!splitDrag) return;
  splitDrag = null;
  els.divider.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing");
  if (event.pointerId != null && els.divider.hasPointerCapture(event.pointerId)) {
    els.divider.releasePointerCapture(event.pointerId);
  }
  storage.set(STORAGE.split, String(state.splitRatio));
  updateReadingProgress();
}

function onDividerKeydown(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? -0.02 : 0.02;
  applySplitRatio(state.splitRatio + delta);
}

function onWindowResize() {
  window.requestAnimationFrame(() => {
    updateReadingProgress();
    updateActiveHeading();
  });
}

/* ---------------------------------------------------------
   Keyboard
   --------------------------------------------------------- */

function onGlobalKeydown(event) {
  if (els.shortcutsDialog.open || event.isComposing) return;

  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && !event.altKey) {
    if (key === "s") {
      event.preventDefault();
      saveFile(event.shiftKey);
      return;
    }
    if (key === "o") {
      event.preventDefault();
      openFile();
      return;
    }
    if (key === "n") {
      event.preventDefault();
      newDocument();
      return;
    }
    if (event.key === "\\") {
      event.preventDefault();
      applySidebarState({ collapsed: !state.sidebarCollapsed });
      return;
    }
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && ["1", "2", "3"].includes(event.key)) {
    event.preventDefault();
    if (state.focus) exitFocus();
    applyMode(event.key === "1" ? "read" : event.key === "2" ? "split" : "source");
    return;
  }

  if (event.key === "F8") {
    event.preventDefault();
    toggleFocus();
    return;
  }

  if (event.key === "Escape") {
    if (!els.moreMenu.hidden) {
      closeMenu();
      els.moreBtn.focus();
      return;
    }
    if (state.focus) {
      exitFocus();
      return;
    }
    if (window.innerWidth <= 1000 && !state.sidebarCollapsed) {
      applySidebarState({ collapsed: true });
    }
    return;
  }

  if (event.key === "?" && !mod && !event.altKey) {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable;
    if (!typing) {
      event.preventDefault();
      openShortcuts();
    }
  }
}

/* ---------------------------------------------------------
   Drag & drop
   --------------------------------------------------------- */

function hasFilePayload(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function onDragEnter(event) {
  if (!hasFilePayload(event)) return;
  event.preventDefault();
  dragDepth += 1;
  els.dropOverlay.classList.add("is-visible");
}

function onDragOver(event) {
  if (!hasFilePayload(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onDragLeave(event) {
  if (event.relatedTarget === null) {
    dragDepth = 0;
    els.dropOverlay.classList.remove("is-visible");
    return;
  }
  if (!hasFilePayload(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.classList.remove("is-visible");
}

async function onDrop(event) {
  if (!hasFilePayload(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.classList.remove("is-visible");

  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;

  const file = files.find((item) => MD_EXTENSION.test(item.name)) || files[0];
  if (!MD_EXTENSION.test(file.name) && !file.type.startsWith("text/")) {
    showToast("请拖入 Markdown 或文本文件", "error");
    return;
  }

  if (!confirmDiscard()) return;
  await loadFile(file, null);
}

/* ---------------------------------------------------------
   Toast
   --------------------------------------------------------- */

function showToast(message, kind = "info") {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("is-error", kind === "error");
  els.toast.classList.add("is-visible");

  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2800);
}

/* ---------------------------------------------------------
   Go
   --------------------------------------------------------- */

init().catch((error) => {
  console.error("Typero failed to initialize", error);
  loadInitialDocument();
  setEditorContent(state.content);
  renderNow({ preserveScroll: false });
  updateStats();
  updateCursor();
  updateSaveUi();
  updateReadingProgress();
  showToast("Typero 初始化遇到问题，已打开备用文稿", "error");
});
