(function () {
  const storageKey = "theme";
  const docEl = document.documentElement;
  const mediaQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  let toggleButton;
  let iconEl;

  function resolvePreferredTheme() {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return mediaQuery && mediaQuery.matches ? "dark" : "light";
  }

  function applyTheme(mode) {
    const useDark = mode === "dark";
    docEl.classList.toggle("dark", useDark);
    updateIcon(useDark);
    return useDark;
  }

  function updateIcon(isDark) {
    iconEl =
      iconEl ||
      document.getElementById("theme-icon") ||
      (toggleButton && toggleButton.querySelector("i"));
    if (!iconEl) return;
    iconEl.className = isDark ? "fa-solid fa-sun" : "fa-solid fa-moon";
  }

  function ensureToggleButton() {
    let existing = document.getElementById("theme-toggle");
    if (existing) return existing;

    const btn = document.createElement("button");
    btn.id = "theme-toggle";
    btn.type = "button";
    btn.className = "icon-btn floating-theme-toggle";
    btn.title = "Toggle light/dark mode";
    btn.innerHTML = '<i id="theme-icon" class="fa-solid fa-moon"></i>';

    document.body.appendChild(btn);
    return btn;
  }

  function wireToggle() {
    toggleButton = ensureToggleButton();
    if (!toggleButton || toggleButton.dataset.themeWired === "true") return;

    toggleButton.addEventListener("click", () => {
      const isDark = !docEl.classList.contains("dark");
      applyTheme(isDark ? "dark" : "light");
      localStorage.setItem(storageKey, isDark ? "dark" : "light");
    });

    toggleButton.dataset.themeWired = "true";
  }

  function listenForSystemChanges() {
    if (!mediaQuery) return;
    const handler = (event) => {
      if (localStorage.getItem(storageKey)) return;
      applyTheme(event.matches ? "dark" : "light");
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handler);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handler);
    }
  }

  function init() {
    wireToggle();
    const preferred = resolvePreferredTheme();
    applyTheme(preferred);
    listenForSystemChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

