import StrShuffler from "./lib/StrShuffler.js";
import Api from "./lib/api.js";

/*
  Horizon UI (static client)
  - Tabs (max 9)
  - Bookmarks & History stored in localStorage
  - Automatic rammerhead session created on first run and reused
  - Special internal URIs: horizon://settings, horizon://chat, horizon://history, horizon://time
  - Keyboard shortcuts, fullscreen behavior, animations
*/

const STORAGE_KEYS = {
  TABS: "horizon_tabs",
  ACTIVE_TAB: "horizon_activeTab",
  BOOKMARKS: "horizon_bookmarks",
  HISTORY: "horizon_history",
  SETTINGS: "horizon_settings",
  SESSION: "horizon_session",
  SHUFFLE_DICT: "horizon_shuffle_dict"
};

const MAX_TABS = 9;
const DEFAULT_HOME_TITLE = "Horizon Home";
const INTERNAL_PREFIX = "horizon://";

const api = new Api();

function nowISO() { return (new Date()).toISOString(); }

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text || "Ready";
}

function loadStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function saveStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ---------- State management ---------- */

let state = {
  tabs: loadStorage(STORAGE_KEYS.TABS, []),
  activeTab: loadStorage(STORAGE_KEYS.ACTIVE_TAB, 0),
  bookmarks: loadStorage(STORAGE_KEYS.BOOKMARKS, []),
  history: loadStorage(STORAGE_KEYS.HISTORY, []),
  settings: loadStorage(STORAGE_KEYS.SETTINGS, { showBookmarkBar: true }),
  session: loadStorage(STORAGE_KEYS.SESSION, null),
  shuffleDict: loadStorage(STORAGE_KEYS.SHUFFLE_DICT, null),
  shuffler: null,
  interceptKeys: true // toggled when fullscreen to allow page to receive keys
};

/* ---------- Utility ---------- */

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function normalizeUrlOrSearch(input) {
  input = (input || "").trim();
  if (!input) return "about:blank";
  // If internal "horizon://" usage
  if (input.startsWith(INTERNAL_PREFIX)) return input;
  // If it looks like a URL (contains protocol or a dot), treat as URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) || input.includes(".") ) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) input = "https://" + input;
    return input;
  }
  // else perform a google search
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function createTabObject(url = "", title = DEFAULT_HOME_TITLE) {
  return {
    id: "t" + Math.random().toString(36).slice(2, 10),
    url,
    title,
    createdOn: nowISO()
  };
}

/* ---------- Session (rammerhead) ---------- */

async function ensureSession() {
  if (state.session) return state.session;
  setStatus("Creating session...");
  const id = await api.newsession();
  state.session = id;
  saveStorage(STORAGE_KEYS.SESSION, id);

  // Try to fetch shuffle dict for session (mirrors original behavior)
  try {
    const dict = await api.shuffleDict(id);
    if (dict) {
      state.shuffleDict = dict;
      saveStorage(STORAGE_KEYS.SHUFFLE_DICT, dict);
      state.shuffler = new StrShuffler(dict);
    }
  } catch (e) {
    // ignore; no shuffling
  }

  setStatus("Session ready");
  return id;
}

function buildProxyUrlFor(url) {
  // If internal horizon, return as is
  if (url.startsWith(INTERNAL_PREFIX)) return url;
  const id = state.session;
  if (!id) return url;
  // Use shuffling if available (match original behavior)
  if (state.shuffler) {
    return `/${id}/${state.shuffler.shuffle(url)}`;
  } else {
    return `/${id}/${url}`;
  }
}

/* ---------- Rendering ---------- */

const dom = {
  addressInput: () => document.getElementById("address-input"),
  backBtn: () => document.getElementById("back-btn"),
  forwardBtn: () => document.getElementById("forward-btn"),
  refreshBtn: () => document.getElementById("refresh-btn"),
  bookmarkToggle: () => document.getElementById("bookmark-toggle"),
  bookmarkBar: () => document.getElementById("bookmark-bar"),
  bookmarksContainer: () => document.getElementById("bookmarks"),
  tabsBar: () => document.getElementById("tabs-bar"),
  contentArea: () => document.getElementById("content-area"),
  homeView: () => document.getElementById("home-view"),
  homeAddress: () => document.getElementById("home-address"),
  homeGo: () => document.getElementById("home-go"),
  fullScreenBtn: () => document.getElementById("fullscreen-btn"),
  newTabBtn: () => document.getElementById("new-tab-btn"),
  historyBtn: () => document.getElementById("history-btn"),
  manageBookmarksBtn: () => document.getElementById("manage-bookmarks-btn")
};

function renderBookmarks() {
  const container = dom.bookmarksContainer();
  container.innerHTML = "";
  if (!state.settings.showBookmarkBar) {
    dom.bookmarkBar().style.display = "none";
    return;
  } else dom.bookmarkBar().style.display = "";

  state.bookmarks.forEach((bm) => {
    const b = document.createElement("button");
    b.className = "bookmark";
    b.textContent = bm.title || bm.url;
    b.title = bm.url;
    b.onclick = (e) => {
      // open in current tab
      navigateTo(bm.url);
    };
    container.appendChild(b);
  });
}

function clampTabs() {
  if (state.tabs.length > MAX_TABS) {
    state.tabs = state.tabs.slice(0, MAX_TABS);
  }
}

function persistTabs() {
  saveStorage(STORAGE_KEYS.TABS, state.tabs);
  saveStorage(STORAGE_KEYS.ACTIVE_TAB, state.activeTab);
}

function renderTabs() {
  const bar = dom.tabsBar();
  bar.innerHTML = "";
  clampTabs();
  state.tabs.forEach((tab, idx) => {
    const el = document.createElement("div");
    el.className = "tab";
    if (idx === state.activeTab) el.classList.add("active");
    el.dataset.idx = idx;

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || "New Tab";
    el.appendChild(title);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close";
    close.textContent = "✕";
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(idx);
    };
    el.appendChild(close);

    el.onclick = () => activateTab(idx);

    bar.appendChild(el);
  });
}

function createIframeFor(tab) {
  const wrapper = document.createElement("div");
  wrapper.className = "iframe-wrapper";
  wrapper.dataset.tabId = tab.id;

  // internal horizon pages will be handled without iframe
  if (tab.url.startsWith(INTERNAL_PREFIX)) {
    const page = renderInternalPage(tab.url);
    wrapper.appendChild(page);
    return wrapper;
  }

  const iframe = document.createElement("iframe");
  iframe.className = "h-iframe";
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-modals"); // keep reasonable isolation but allow functioning pages
  iframe.src = buildProxyUrlFor(tab.url);
  iframe.onload = () => {
    // try to update title (should be same-origin because proxied)
    try {
      const title = iframe.contentDocument && iframe.contentDocument.title;
      if (title) {
        tab.title = title;
        renderTabs();
      }
    } catch (e) {
      // ignore cross-origin-like issues
    }
    // push to history
    pushHistoryEntry(tab.url, tab.title || "");
    setStatus(`Loaded: ${tab.url}`);
  };

  wrapper.appendChild(iframe);
  return wrapper;
}

function renderActiveContent() {
  const area = dom.contentArea();
  area.innerHTML = "";

  if (!state.tabs.length) {
    // show home view
    area.appendChild(dom.homeView());
    return;
  }

  // ensure activeTab index valid
  state.activeTab = clamp(state.activeTab, 0, Math.max(0, state.tabs.length - 1));
  const active = state.tabs[state.activeTab];

  // Build tabs iframes, but keep only active iframe in DOM to save resources
  const contentWrapper = document.createElement("div");
  contentWrapper.className = "content-wrapper";
  const iframeEl = createIframeFor(active);
  iframeEl.classList.add("enter");
  contentWrapper.appendChild(iframeEl);
  area.appendChild(contentWrapper);

  // update address input
  dom.addressInput().value = active.url || "";
  dom.bookmarkToggle().textContent = isBookmarked(active.url) ? "★" : "☆";
}

function renderEverything() {
  renderBookmarks();
  renderTabs();
  renderActiveContent();
}

/* ---------- Tabs operations ---------- */

function addTab(url = "", makeActive = true) {
  if (state.tabs.length >= MAX_TABS) {
    // pop last tab to make room (or prevent?) We'll remove last.
    state.tabs.pop();
  }
  const tab = createTabObject(url, url === "" ? DEFAULT_HOME_TITLE : url);
  state.tabs.push(tab);
  if (makeActive) state.activeTab = state.tabs.length - 1;
  persistTabs();
  renderEverything();

  // small animation
  requestAnimationFrame(() => {
    const tabs = document.querySelectorAll(".tab");
    if (tabs.length) {
      const last = tabs[tabs.length - 1];
      last.classList.add("enter");
      setTimeout(() => last.classList.remove("enter"), 400);
    }
  });

  return tab;
}

function closeTab(idx) {
  if (idx < 0 || idx >= state.tabs.length) return;
  const removed = state.tabs.splice(idx, 1);
  // animation: mark the tab element and remove after transition
  persistTabs();

  if (state.tabs.length === 0) {
    // show home
    state.activeTab = 0;
  } else if (idx <= state.activeTab) {
    state.activeTab = Math.max(0, state.activeTab - 1);
  }
  renderEverything();
}

function closeAllTabsToHome() {
  state.tabs = [];
  state.activeTab = 0;
  persistTabs();
  renderEverything();
}

function activateTab(idx) {
  if (idx < 0 || idx >= state.tabs.length) return;
  state.activeTab = idx;
  persistTabs();
  renderEverything();
}

function navigateTo(rawInput, inNewTab = false) {
  const url = normalizeUrlOrSearch(rawInput);
  // internal pages handling
  if (url.startsWith(INTERNAL_PREFIX)) {
    if (inNewTab) addTab(url, true);
    else {
      if (!state.tabs.length) addTab(url, true); else {
        state.tabs[state.activeTab].url = url;
        state.tabs[state.activeTab].title = url;
      }
      persistTabs();
      renderEverything();
    }
    return;
  }

  // Ensure session exists before navigating to proxied sites
  ensureSession().then(() => {
    if (inNewTab || !state.tabs.length) {
      const tab = addTab(url, true);
      // Tab iframe will be created in renderActiveContent -> iframe loads -> pushHistoryEntry triggered on load
    } else {
      const active = state.tabs[state.activeTab];
      active.url = url;
      active.title = url;
      persistTabs();
      renderEverything();
      // we replaced the active iframe; renderActiveContent will set iframe src and onload will push history
    }
  }).catch(err => {
    console.error(err);
    setStatus("Session error");
  });
}

/* ---------- Bookmarks & History ---------- */

function isBookmarked(url) {
  return state.bookmarks.some(b => b.url === url);
}
function toggleBookmark(url, title) {
  if (!url) return;
  const existingIdx = state.bookmarks.findIndex(b => b.url === url);
  if (existingIdx !== -1) {
    state.bookmarks.splice(existingIdx, 1);
  } else {
    state.bookmarks.unshift({ id: "b" + Math.random().toString(36).slice(2, 8), url, title: title || url, createdOn: nowISO() });
  }
  saveStorage(STORAGE_KEYS.BOOKMARKS, state.bookmarks);
  renderBookmarks();
  dom.bookmarkToggle().textContent = isBookmarked(url) ? "★" : "☆";
}

function pushHistoryEntry(url, title) {
  if (!url || url.startsWith(INTERNAL_PREFIX)) return;
  state.history.unshift({ id: "h" + Math.random().toString(36).slice(2, 9), url, title: title || url, ts: nowISO() });
  // keep history reasonable length (say 1000) but user wanted indefinite — still cap to 5000 to avoid runaway growth
  state.history = state.history.slice(0, 5000);
  saveStorage(STORAGE_KEYS.HISTORY, state.history);
}

/* ---------- Internal pages ---------- */

function renderInternalPage(uri) {
  const page = document.createElement("div");
  page.className = "internal-page";
  if (uri === "horizon://history") {
    const title = document.createElement("h2");
    title.textContent = "History";
    page.appendChild(title);

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-outline-danger";
    clearBtn.textContent = "Clear history";
    clearBtn.onclick = () => {
      if (!confirm("Clear history?")) return;
      state.history = [];
      saveStorage(STORAGE_KEYS.HISTORY, state.history);
      renderInternalPage(uri); // re-render (we'll just refresh)
      renderEverything();
    };
    page.appendChild(clearBtn);

    const list = document.createElement("ul");
    list.className = "history-list";
    state.history.forEach(h => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = (h.title || h.url) + " — " + new Date(h.ts).toLocaleString();
      a.onclick = (e) => {
        e.preventDefault();
        navigateTo(h.url);
      };
      li.appendChild(a);
      list.appendChild(li);
    });
    page.appendChild(list);
    return page;
  } else if (uri === "horizon://settings") {
    const title = document.createElement("h2");
    title.textContent = "Settings";
    page.appendChild(title);

    const bookmarkToggle = document.createElement("div");
    bookmarkToggle.className = "form-check form-switch";
    bookmarkToggle.innerHTML = `<input class="form-check-input" type="checkbox" id="setting-showBookmarks">
      <label class="form-check-label" for="setting-showBookmarks">Show bookmarks bar</label>`;
    page.appendChild(bookmarkToggle);
    const cb = bookmarkToggle.querySelector("#setting-showBookmarks");
    cb.checked = state.settings.showBookmarkBar;
    cb.onchange = () => {
      state.settings.showBookmarkBar = cb.checked;
      saveStorage(STORAGE_KEYS.SETTINGS, state.settings);
      renderBookmarks();
    };

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-outline-warning mt-2";
    resetBtn.textContent = "Clear all tabs & local data (except session)";
    resetBtn.onclick = () => {
      if (!confirm("Reset tabs, bookmarks, and history? This will NOT delete the rammerhead session.")) return;
      state.tabs = [];
      state.bookmarks = [];
      state.history = [];
      state.activeTab = 0;
      saveStorage(STORAGE_KEYS.TABS, state.tabs);
      saveStorage(STORAGE_KEYS.BOOKMARKS, state.bookmarks);
      saveStorage(STORAGE_KEYS.HISTORY, state.history);
      renderEverything();
    };
    page.appendChild(resetBtn);

    return page;
  } else if (uri === "horizon://time") {
    const title = document.createElement("h2");
    title.textContent = "Time";
    page.appendChild(title);
    const clock = document.createElement("div");
    clock.className = "clock";
    page.appendChild(clock);
    function tick() {
      clock.textContent = new Date().toLocaleString();
    }
    tick();
    setInterval(tick, 1000);
    return page;
  } else if (uri === "horizon://chat") {
    const title = document.createElement("h2");
    title.textContent = "Chat (placeholder)";
    page.appendChild(title);

    const p = document.createElement("p");
    p.textContent = "This is a placeholder chat page. Replace with your chat integration later.";
    page.appendChild(p);
    return page;
  }

  // fallback
  const p = document.createElement("p");
  p.textContent = "Unknown internal page: " + uri;
  page.appendChild(p);
  return page;
}

/* ---------- UI events ---------- */

function wireUi() {
  // top controls
  dom.backBtn().onclick = () => {
    sendKeyToIframe("history-back");
  };
  dom.forwardBtn().onclick = () => {
    sendKeyToIframe("history-forward");
  };
  dom.refreshBtn().onclick = () => {
    sendKeyToIframe("reload");
  };
  dom.newTabBtn().onclick = () => {
    addTab("", true);
  };

  dom.fullScreenBtn().onclick = () => {
    toggleFullscreen();
  };

  dom.bookmarkToggle().onclick = () => {
    const currentUrl = (state.tabs[state.activeTab] && state.tabs[state.activeTab].url) || "";
    toggleBookmark(currentUrl, state.tabs[state.activeTab] && state.tabs[state.activeTab].title);
  };

  dom.addressInput().addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      navigateTo(dom.addressInput().value);
    }
  });

  dom.homeGo().onclick = () => {
    navigateTo(dom.homeAddress().value);
  };
  dom.homeAddress().addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") dom.homeGo().click();
  });

  dom.historyBtn().onclick = () => {
    navigateTo("horizon://history");
  };
  dom.manageBookmarksBtn().onclick = () => {
    navigateTo("horizon://settings");
  };

  document.querySelectorAll(".quick-link").forEach(btn => {
    btn.onclick = () => navigateTo(btn.dataset.href);
  });

  // keyboard shortcuts
  window.addEventListener("keydown", (ev) => {
    if (!state.interceptKeys) return; // when false, we let page handle
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const ctrl = isMac ? ev.metaKey : ev.ctrlKey;

    // Ctrl+T
    if (ctrl && ev.key.toLowerCase() === "t") {
      ev.preventDefault();
      addTab("", true);
      return;
    }

    // Ctrl+W
    if (ctrl && ev.key.toLowerCase() === "w" && !ev.shiftKey) {
      ev.preventDefault();
      closeTab(state.activeTab);
      return;
    }

    // Ctrl+Shift+W -> close all and go home
    if (ctrl && ev.key.toLowerCase() === "w" && ev.shiftKey) {
      ev.preventDefault();
      closeAllTabsToHome();
      return;
    }

    // Ctrl+1..9 to switch
    if (ctrl && /^[1-9]$/.test(ev.key)) {
      ev.preventDefault();
      const idx = parseInt(ev.key, 10) - 1;
      if (idx < state.tabs.length) activateTab(idx);
      return;
    }

    // Ctrl+D bookmark
    if (ctrl && ev.key.toLowerCase() === "d") {
      ev.preventDefault();
      const cur = state.tabs[state.activeTab];
      if (cur) toggleBookmark(cur.url, cur.title);
      return;
    }

    // Ctrl+B toggle bookmark bar
    if (ctrl && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      state.settings.showBookmarkBar = !state.settings.showBookmarkBar;
      saveStorage(STORAGE_KEYS.SETTINGS, state.settings);
      renderBookmarks();
      return;
    }

    // Ctrl+H open history
    if (ctrl && ev.key.toLowerCase() === "h") {
      ev.preventDefault();
      navigateTo("horizon://history");
      return;
    }

    // Alt+Left / Alt+Right / Alt+R for back/forward/refresh
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        sendKeyToIframe("history-back");
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        sendKeyToIframe("history-forward");
      } else if (ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        sendKeyToIframe("reload");
      }
    }
  });

  // When fullscreen changes, toggle interceptKeys
  document.addEventListener("fullscreenchange", () => {
    const fs = !!document.fullscreenElement;
    state.interceptKeys = !fs; // when fullscreen, let page handle keys
    if (fs) {
      // focus iframe
      const ifr = document.querySelector(".h-iframe");
      if (ifr) try { ifr.contentWindow.focus(); } catch (e) {}
      setStatus("Fullscreen active (page receives keys)");
    } else {
      setStatus("Ready");
    }
  });
}

/* ---------- Fullscreen & iframe commands ---------- */

function toggleFullscreen() {
  const area = document.querySelector(".content-wrapper") || dom.contentArea();
  if (!area) return;
  if (!document.fullscreenElement) {
    area.requestFullscreen().catch((e) => console.warn("FS failed", e));
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// Send simple commands to active iframe by performing actions on iframe element
function sendKeyToIframe(action) {
  const wrapper = document.querySelector(".iframe-wrapper");
  if (!wrapper) return;
  const iframe = wrapper.querySelector("iframe");
  if (!iframe) return;
  try {
    if (action === "history-back") {
      iframe.contentWindow.history.back();
    } else if (action === "history-forward") {
      iframe.contentWindow.history.forward();
    } else if (action === "reload") {
      iframe.contentWindow.location.reload();
    }
  } catch (e) {
    // fallback: reload iframe by resetting src (best-effort)
    if (action === "reload") {
      const src = iframe.src;
      iframe.src = src;
    }
  }
}

/* ---------- Initialization ---------- */

async function init() {
  // Wire events first
  wireUi();

  // Ensure session
  try {
    await ensureSession();
  } catch (e) {
    console.warn("Could not create session automatically", e);
  }

  // If there were saved shuffle dict but no shuffler, initialize
  if (state.shuffleDict && !state.shuffler) state.shuffler = new StrShuffler(state.shuffleDict);

  // Hydrate home address input
  dom.homeAddress().value = "";

  // If no tabs, create one home tab
  if (!state.tabs || state.tabs.length === 0) {
    // Keep home view shown, do not create remote iframe until navigation
    state.tabs = [];
    state.activeTab = 0;
  }

  // Render all UI
  renderEverything();
  setStatus("Ready");
}

window.addEventListener("load", init);

// Expose some utilities for debugging in console
window.Horizon = {
  state,
  addTab,
  closeTab,
  navigateTo,
  toggleBookmark,
  openInternal: (uri) => navigateTo(uri)
};
