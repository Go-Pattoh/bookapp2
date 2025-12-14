// googleapi_mod.js
// Client fetch preferences: when true the client will fetch Google Books directly (if online)
const ALLOW_CLIENT_GOOGLE_FETCH = true;
// Server proxy path (server will fetch + cache) - used when client cannot/should not fetch directly
const PROXY_SEARCH_PATH = "/api/search?q=";

// State for saved books
let savedBookIds = new Set();
let currentCategory = "all";
let isDownloadableFilter = false;

// Track current query for pagination and UI
let currentQuery = "";
let isLoggedIn = false;
// visitedPages stores pages we've already fetched and cached on the server for a query: { [query]: Set<page> }
const visitedPages = {};

// DOM elements - will be set in init()
let main, form, search;
let resultsContainer;

// Check auth on load to update UI
async function checkAuthAndUpdateUI() {
  try {
    const res = await fetch("/api/me");
    const user = await res.json();

    // track login state for fetch decisions
    isLoggedIn = !!(user && user.userId);

    // Update user avatar and name
    const avatarImg = document.querySelector(".avatar");
    const userNameSpan = document.querySelector(".user-name");
    const navLogin = document.getElementById("nav-login");
    const navRegister = document.getElementById("nav-register");
    const navLogout = document.getElementById("nav-logout");
    const logoutLink = document.getElementById("logoutLink");

    if (user.userId) {
      // User is logged in
      const displayName = user.username || user.email?.split("@")[0] || "User";
      const email = user.email || user.username || "User";

      // Update avatar with email-based initials
      if (avatarImg) {
        const initials = email
          .split("@")[0]
          .substring(0, 2)
          .toUpperCase()
          .padEnd(2, "U");
        avatarImg.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(
          initials
        )}&background=random&color=fff&size=128`;
        avatarImg.alt = displayName;
      }

      // Update user name
      if (userNameSpan) {
        userNameSpan.textContent = displayName;
      }

      // Hide login/register, show logout
      if (navLogin) {
        navLogin.style.display = "none";
        console.log("Hiding login link");
      }
      if (navRegister) {
        navRegister.style.display = "none";
        console.log("Hiding register link");
      }
      if (navLogout) {
        navLogout.style.display = "block";
        console.log("Showing logout link");
      }
      if (logoutLink) {
        // Remove existing listeners to avoid duplicates
        const newLogoutLink = logoutLink.cloneNode(true);
        logoutLink.parentNode.replaceChild(newLogoutLink, logoutLink);
        newLogoutLink.addEventListener("click", handleLogout);
      }
    } else {
      // User is not logged in
      if (avatarImg) {
        avatarImg.src =
          "https://ui-avatars.com/api/?name=Guest&background=random&color=fff&size=128";
        avatarImg.alt = "Guest";
      }
      if (userNameSpan) {
        userNameSpan.textContent = "Guest";
      }

      // Show login/register, hide logout
      if (navLogin) navLogin.style.display = "block";
      if (navRegister) navRegister.style.display = "block";
      if (navLogout) navLogout.style.display = "none";
    }
  } catch (err) {
    console.error("Auth check failed", err);
  }
}

function showRateLimitWarning(msg) {
  try {
    const el = document.getElementById("searchError");
    if (!el) return;
    el.textContent = msg || "Rate limit reached — showing cached results.";
    el.style.display = "block";
    setTimeout(() => {
      el.style.display = "none";
    }, 7000);
  } catch (e) {}
}

// Debounced live search (search-as-you-type)
const debouncedLiveSearch = debounce(() => {
  const val = (search && search.value && search.value.trim()) || "";
  if (val.length < 3) return; // wait for at least 3 chars
  // Reset filters when user types
  const filterChips = document.querySelectorAll(".filter-chip");
  filterChips.forEach((c) => c.classList.remove("active"));
  const allChip = document.querySelector('.filter-chip[data-category="all"]');
  if (allChip) allChip.classList.add("active");
  currentCategory = "all";
  loadBooks(val);
}, 600);

// Initialize function
async function init() {
  // Get DOM elements
  main = document.getElementById("featured-section");
  form = document.getElementById("form");
  search = document.getElementById("query");
  resultsContainer =
    document.getElementById("results-container") ||
    (main && main.querySelector(".books"));

  // Safety check
  if (!main) {
    console.error("Featured section not found!");
    return;
  }
  if (!form) {
    console.warn("Search form not found!");
  }
  if (!search) {
    console.warn("Search input not found!");
  }

  // Setup spinner and suggestion box for search
  if (search) {
    setupSearchUI();
  }

  // Check auth on load to update UI
  await checkAuthAndUpdateUI();

  // Fetch saved books for logged in users
  await fetchSavedBooks();

  // Load default results (Local first, then API)
  // randomize the topics from programming to get a variety of books
  const topics = ["python", "java", "cooking", "history", "art"];
  // removed "javascript" from the list

  // pick 10 random topics and call returnBooks
  let pickedTopics = [];
  for (let i = 0; i < 10; i++) {
    const topic = topics[Math.floor(Math.random() * topics.length)];
    pickedTopics.push(topic);
    await returnBooks({ q: topic, type: "local", page: 1 });
  }

  // pick 1 random topic for loadBooks()
  const loadTopic =
    pickedTopics[Math.floor(Math.random() * pickedTopics.length)];

  loadBooks(loadTopic);

  // Setup filter event listeners
  setupFilters();

  // Setup search form
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = search.value.trim();
      if (val) {
        // Reset filters
        const filterChips = document.querySelectorAll(".filter-chip");
        filterChips.forEach((c) => c.classList.remove("active"));
        const allChip = document.querySelector(
          '.filter-chip[data-category="all"]'
        );
        if (allChip) allChip.classList.add("active");
        currentCategory = "all";
        loadBooks(val);
      }
    });
  }

  // Setup sidebar & panel logic
  setupSidebar();
}

// Setup sidebar and user panel
function setupSidebar() {
  const menuToggle = document.querySelector(".menu-toggle");
  const sidebar = document.querySelector(".sidebar");
  const kaToggle = document.getElementById("ka-toggle");
  const kaPanel = document.getElementById("ka-panel");
  const kaClose = document.getElementById("ka-close");

  if (menuToggle && sidebar) {
    menuToggle.addEventListener("click", () => {
      sidebar.classList.toggle("active");
    });
  }

  if (kaToggle && kaPanel) {
    kaToggle.addEventListener("click", () => {
      kaPanel.classList.add("active");
      kaPanel.setAttribute("aria-hidden", "false");
      renderUserPanel();
    });
  }

  if (kaClose && kaPanel) {
    kaClose.addEventListener("click", () => {
      kaPanel.classList.remove("active");
      kaPanel.setAttribute("aria-hidden", "true");
    });
  }
}

// Setup search UI elements
function setupSearchUI() {
  const spinner = document.createElement("div");
  spinner.className = "spinner search-spinner";
  const parent = search.closest(".search-container") || search.parentElement;
  if (parent) {
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(spinner);

    const suggestionBox = document.createElement("div");
    suggestionBox.className = "typeahead-box";
    suggestionBox.style.display = "none";
    suggestionBox.style.position = "absolute";
    suggestionBox.style.zIndex = "1200";
    parent.appendChild(suggestionBox);

    // Create debounced fetch function
    const debouncedFetchFn = debounce(async () => {
      const val = search.value.trim();
      if (val.length < 2) {
        suggestionBox.style.display = "none";
        spinner.style.display = "none";
        return;
      }

      try {
        spinner.style.display = "block";
        // Use proxy for suggestions so server can cache and control quota
        const suggestionUrl = `${PROXY_SEARCH_PATH}${encodeURIComponent(
          val
        )}&page=1&per_page=5`;
        const resp = await fetch(suggestionUrl);
        const data = await resp.json();
        const items = data.items || [];

        if (!items.length) {
          suggestionBox.style.display = "none";
          return;
        }

        suggestionBox.innerHTML = "";
        items.forEach((it) => {
          const row = document.createElement("div");
          row.className = "typeahead-row";
          row.textContent = it.volumeInfo.title;
          row.addEventListener("click", () => {
            search.value = it.volumeInfo.title;
            suggestionBox.style.display = "none";
            // Reset filters
            const filterChips = document.querySelectorAll(".filter-chip");
            filterChips.forEach((c) => c.classList.remove("active"));
            const allChip = document.querySelector(
              '.filter-chip[data-category="all"]'
            );
            if (allChip) allChip.classList.add("active");
            currentCategory = "all";
            loadBooks(search.value);
          });
          suggestionBox.appendChild(row);
        });

        suggestionBox.style.display = "block";
        // position via CSS (top:100%) so it sits directly under the input inside the relative parent
        suggestionBox.style.top = "100%";
        suggestionBox.style.left = "0";
        suggestionBox.style.width = "100%";
      } catch (e) {
        console.warn(e);
      } finally {
        spinner.style.display = "none";
      }
    }, 500);

    // Setup search input listener
    search.addEventListener("input", () => {
      const val = search.value.trim();
      if (val.length >= 2) {
        debouncedFetchFn();
      } else {
        spinner.style.display = "none";
        suggestionBox.style.display = "none";
      }
      // Trigger live search debounce (search-as-you-type)
      debouncedLiveSearch();
    });

    document.addEventListener("click", (e) => {
      if (!suggestionBox.contains(e.target) && e.target !== search) {
        suggestionBox.style.display = "none";
      }
    });
  }
}

// Setup filter event listeners
function setupFilters() {
  const filterChips = document.querySelectorAll(".filter-chip");
  if (filterChips.length === 0) {
    // Retry if filters aren't ready yet
    setTimeout(setupFilters, 100);
    return;
  }

  filterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      // Update UI
      filterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");

      // Update State
      const cat = chip.dataset.category;
      currentCategory = cat;

      // Search
      const query = cat === "all" ? "javascript" : cat; // Default to javascript for 'all' for now
      search.value = ""; // Clear search bar if using filter
      loadBooks(query);
    });
  });
}

// Wait for DOM to be ready before initializing
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Filter Event Listeners are now handled in setupFilters() function

const downloadableCheckbox = document.getElementById("downloadable-only");
if (downloadableCheckbox) {
  downloadableCheckbox.addEventListener("change", (e) => {
    isDownloadableFilter = e.target.checked;
    const query =
      search.value.trim() ||
      (currentCategory === "all" ? "javascript" : currentCategory);
    loadBooks(query);
  });
}

async function fetchSavedBooks() {
  try {
    const res = await fetch("/api/downloads");
    if (res.ok) {
      const data = await res.json();
      if (data.downloads) {
        savedBookIds = new Set(data.downloads.map((b) => b.googleId));
      }
    }
  } catch (e) {
    console.warn("Failed to fetch saved books", e);
  }
}

// Combined Remote + Local Load (prefer Google Books API, cache as fallback)
async function loadBooks(query) {
  // 1. Try Google Books API first (primary source)
  try {
    await returnBooks({ q: query, type: "remote", page: 1 });
  } catch (err) {
    console.warn("Remote fetch failed, trying local cache:", err);
    // 2. Fallback to local cache if API fails or slow network
    await returnBooks({ q: query, type: "local", page: 1 });
  }
}

function returnBooks(spec) {
  if (!main) {
    console.error("Cannot return books: featured-section element not found");
    return Promise.reject(new Error("Main element not found"));
  }

  let fetchUrl;
  const q = spec.q || "";
  const page = spec.page || 1;
  const per_page = spec.per_page || 30;
  const type = spec.type || "remote"; // 'local' or 'remote'
  const prefetch = spec.prefetch === true;

  // allow using local DB for revisits: if we've already fetched this page for this query,
  // prefer local DB so we don't call Google again when user returns.
  let forcedLocal = false;
  if (type === "local") {
    fetchUrl = `/api/local-search?q=${encodeURIComponent(
      q
    )}&page=${page}&per_page=${per_page}`;
  } else {
    // Check connection speed - bypass cache on fast connections
    let isFastConnection = false;
    if (navigator.connection) {
      const conn = navigator.connection;
      // Check if using 4g, 5g or effectiveType is 4g
      isFastConnection =
        conn.effectiveType === "4g" ||
        conn.type === "4g" ||
        conn.type === "5g" ||
        conn.type === "wifi";
    }

    // Prefer server proxy for cache-first behavior. Use local DB if we've visited this page before.
    if (visitedPages[q] && visitedPages[q].has(page) && !isFastConnection) {
      // We've already visited this page - read from DB instead of hitting Google again
      // (unless we have fast internet)
      fetchUrl = `/api/local-search?q=${encodeURIComponent(
        q
      )}&page=${page}&per_page=${per_page}`;
      forcedLocal = true;
    } else {
      // Use server proxy which will serve cached results first and background-refresh when needed.
      // On fast connection, add a header to prefer fresh data
      fetchUrl = `${PROXY_SEARCH_PATH}${encodeURIComponent(
        q
      )}&page=${page}&per_page=${per_page}${
        isFastConnection ? "&preferFresh=1" : ""
      }`;
    }
  }

  const effectiveType = forcedLocal ? "local" : type;

  console.log(
    `Fetching books from: ${fetchUrl} (requested type: ${type}, effective: ${effectiveType})`
  ); // Debug log

  // If this is a prefetch request (background cache population), don't modify UI
  if (effectiveType === "remote" && !prefetch) {
    const hasBooks = resultsContainer && resultsContainer.children.length > 0;
    if (!hasBooks && !document.getElementById("pager")) {
      renderSkeleton(per_page);
    } else {
      // We have content, show a small loader in header
      const header = document.getElementById("resultsHeader");
      if (header && !header.querySelector(".fa-spin")) {
        header.innerHTML +=
          ' <span style="font-size:0.8em; color:var(--text-muted)"><i class="fa-solid fa-circle-notch fa-spin"></i> Updating...</span>';
      }
    }
  }

  // If prefetch, just trigger the fetch so server upserts/caches data, but don't render UI
  if (prefetch) {
    // If this is a direct Google fetch, also send the items to our server cache endpoint
    if (
      typeof fetchUrl === "string" &&
      fetchUrl.startsWith("https://www.googleapis.com")
    ) {
      return fetch(fetchUrl)
        .then((r) => (r.ok ? r.json().catch(() => null) : null))
        .then((data) => {
          if (data && Array.isArray(data.items)) {
            fetch("/api/cache", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: data.items }),
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return fetch(fetchUrl).catch(() => {});
  }

  return fetch(fetchUrl)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      return res.json();
    })
    .then(function (data) {
      console.log("API Response:", data); // Debug log
      if (data && data.rateLimited) {
        showRateLimitWarning(
          data.message ||
            "Anonymous rate limit reached — showing cached results."
        );
      }
      const payloadItems = data.items
        ? data.items
        : Array.isArray(data)
        ? data
        : data.items || [];
      const totalItems = data.totalItems || data.total_items || 0;

      // If local search returned nothing and we're using it as fallback, show message
      if (
        effectiveType === "local" &&
        (!payloadItems || !payloadItems.length)
      ) {
        // Only skip if we already have content from remote
        if (main.querySelector(".books") || main.querySelector("#pager")) {
          // We already have content, don't clear it
          return;
        }
        // No content at all, this is a fallback - show message
        const msgTarget = resultsContainer || main;
        msgTarget.innerHTML =
          "<p style='text-align:center; padding:2rem; color:var(--text-muted)'>No cached results found. Please check your connection.</p>";
        return;
      }

      if (!payloadItems || !payloadItems.length) {
        if (effectiveType === "remote") {
          const msgTarget = resultsContainer || main;
          msgTarget.innerHTML =
            "<p style='text-align:center; padding:2rem; color:var(--muted)'>No results found.</p>";
        }
        return;
      }

      // Filter client-side for "Downloadable Only" if requested
      let displayItems = payloadItems;
      if (isDownloadableFilter) {
        displayItems = payloadItems.filter((item) => {
          const access = item.accessInfo || {};
          return (
            (access.pdf && access.pdf.isAvailable) ||
            (access.epub && access.epub.isAvailable)
          );
        });
        if (!displayItems.length) {
          // Show friendly message in results container rather than manipulating header variable
          if (resultsContainer) {
            resultsContainer.innerHTML =
              '<p style="text-align:center; padding:2rem; color:var(--text-muted)">No downloadable results found for this query.</p>';
          }
          return;
        }
      }

      // Clear only the results area so section header and other UI remain stable
      if (resultsContainer) {
        resultsContainer.innerHTML = "";
      }

      // Header
      let header = document.getElementById("resultsHeader");
      if (!header) {
        header = document.createElement("div");
        header.id = "resultsHeader";
        header.className = "results-header";
        header.style.textAlign = "center";
        header.style.marginBottom = "20px";
        header.style.color = "var(--text-muted)";
      }
      const startIndex = (page - 1) * per_page + 1;
      const endIndex = Math.min(totalItems, page * per_page);

      const sourceLabel =
        effectiveType === "local"
          ? '<span style="color:var(--primary); font-size:0.8em; margin-left:10px"><i class="fa-solid fa-database"></i> Local Cache</span>'
          : '<span style="color:var(--accent); font-size:0.8em; margin-left:10px"><i class="fa-solid fa-cloud"></i> Google Books</span>';

      header.innerHTML = `Showing ${startIndex}-${endIndex} of ${totalItems} results ${sourceLabel}`;
      main.appendChild(header);

      const div_bookrow = document.createElement("div");
      div_bookrow.setAttribute("class", "books");

      displayItems.forEach((item) => {
        const volume = item.volumeInfo || {};
        const div_bookcard = document.createElement("div");
        div_bookcard.setAttribute("class", "book-card");

        // Check for direct download links (PDF/EPUB)
        const access = item.accessInfo || {};
        let realDownloadUrl = null;
        let realDownloadLabel = "View";
        let realDownloadIcon = "fa-eye";
        let isDownloadable = false;

        if (access.pdf && access.pdf.isAvailable && access.pdf.downloadLink) {
          realDownloadUrl = access.pdf.downloadLink;
          realDownloadLabel = "PDF";
          realDownloadIcon = "fa-file-pdf";
          isDownloadable = true;
        } else if (
          access.epub &&
          access.epub.isAvailable &&
          access.epub.downloadLink
        ) {
          realDownloadUrl = access.epub.downloadLink;
          realDownloadLabel = "EPUB";
          realDownloadIcon = "fa-book";
          isDownloadable = true;
        }

        // Add Red Badge if downloadable
        if (isDownloadable) {
          const badge = document.createElement("div");
          badge.className = "download-badge";
          badge.innerHTML = '<i class="fa-solid fa-download"></i> Available';
          div_bookcard.appendChild(badge);
        }

        // Cover
        const image = document.createElement("img");
        image.setAttribute("class", "book-cover");
        image.loading = "lazy";
        image.alt = volume.title || "Book cover";
        // Get thumbnail URL - use HTTPS and don't modify Google's URLs
        let thumb = null;
        if (volume.imageLinks) {
          thumb =
            volume.imageLinks.thumbnail || volume.imageLinks.smallThumbnail;
          // Ensure HTTPS
          if (thumb && thumb.startsWith("http:")) {
            thumb = thumb.replace("http:", "https:");
          }
        }
        image.src =
          thumb || "https://via.placeholder.com/150x220?text=No+Cover";
        // Fallback if image fails to load
        image.onerror = () => {
          console.log("Image failed to load:", thumb);
          image.src = "https://via.placeholder.com/150x220?text=No+Cover";
        };

        // Title
        const title = document.createElement("h4");
        title.setAttribute("class", "book-title");
        title.textContent = volume.title || "No Title";

        // Authors
        const authors = document.createElement("p");
        authors.setAttribute("class", "book-authors");
        authors.textContent = volume.authors
          ? volume.authors.join(", ")
          : "Unknown Author";

        // Year
        const year = document.createElement("p");
        year.setAttribute("class", "book-year");
        year.textContent = volume.publishedDate
          ? volume.publishedDate.substring(0, 4)
          : "";

        // Card Footer
        const footer = document.createElement("div");
        footer.className = "card-footer";

        // Save Button (Now "Download")
        const downloadBtn = document.createElement("button");
        const isSaved = savedBookIds.has(item.id);

        if (isSaved) {
          downloadBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
          downloadBtn.classList.add("btn-action", "btn-save");
          downloadBtn.style.background = "var(--success)";
          downloadBtn.style.borderColor = "var(--success)";
          downloadBtn.disabled = true;
        } else {
          downloadBtn.innerHTML =
            '<i class="fa-solid fa-download"></i> Download';
          downloadBtn.classList.add("btn-action", "btn-save");
          downloadBtn.title = "Download to My Library";
          downloadBtn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            // Visual Feedback
            const originalText = downloadBtn.innerHTML;
            downloadBtn.innerHTML =
              '<i class="fa-solid fa-circle-notch fa-spin"></i> Downloading...';
            downloadBtn.innerHTML =
              '<i class="fa-solid fa-circle-notch fa-spin"></i> Downloading...';
            downloadBtn.disabled = true;

            await handleSave(item, downloadBtn, originalText);
          });
        }

        // Real Download / View Button
        const viewBtn = document.createElement("button");
        viewBtn.innerHTML = `<i class="fa-solid ${realDownloadIcon}"></i> ${realDownloadLabel}`;
        viewBtn.classList.add("btn-action", "btn-download");
        viewBtn.title = realDownloadUrl ? "Download File" : "View Book Details";

        viewBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (realDownloadUrl) {
            // Use proxy for direct download
            const proxyUrl = `/api/proxy-download?url=${encodeURIComponent(
              realDownloadUrl
            )}`;
            window.location.href = proxyUrl;
          } else {
            handleView(item);
          }
        });

        // Link wrapper for the card content (except footer)
        const contentWrapper = document.createElement("a");
        contentWrapper.href = volume.infoLink || "#";
        contentWrapper.target = "_blank";
        contentWrapper.style.textDecoration = "none";
        contentWrapper.style.color = "inherit";
        contentWrapper.style.flex = "1";

        contentWrapper.appendChild(image);
        contentWrapper.appendChild(title);
        contentWrapper.appendChild(authors);
        contentWrapper.appendChild(year);

        div_bookcard.appendChild(contentWrapper);

        footer.appendChild(downloadBtn);
        footer.appendChild(viewBtn);
        div_bookcard.appendChild(footer);

        div_bookrow.appendChild(div_bookcard);
      });

      // Append to the dedicated results container (falls back to main if not present)
      const target = resultsContainer || main;
      target.appendChild(div_bookrow);
      // mark this page as visited (so revisits prefer DB)
      try {
        visitedPages[q] = visitedPages[q] || new Set();
        visitedPages[q].add(page);
      } catch (e) {}

      renderPaginationContainer(q, page, per_page, totalItems, effectiveType);

      // If we fetched directly from Google (not via proxy), send the current page items to server to cache
      try {
        if (
          typeof fetchUrl === "string" &&
          fetchUrl.startsWith("https://www.googleapis.com")
        ) {
          if (Array.isArray(payloadItems) && payloadItems.length) {
            fetch("/api/cache", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: payloadItems }),
            }).catch(() => {});
          }
        }
      } catch (e) {}

      // Prefetch next page in background so server caches results for faster navigation
      try {
        // only prefetch remote pages (we want server/cache to hold next page)
        if (type === "remote" && page && totalItems > page * per_page) {
          // don't await — fire and forget
          returnBooks({
            q,
            type: "remote",
            page: page + 1,
            per_page,
            prefetch: true,
          });
        }
      } catch (e) {}
    })
    .catch((err) => {
      console.error("Error fetching books:", err);
      if (type === "remote") {
        const errorMsg = document.createElement("div");
        errorMsg.style.textAlign = "center";
        errorMsg.style.padding = "2rem";
        errorMsg.style.color = "var(--text-muted)";
        errorMsg.innerHTML = `<p>Error loading books: ${err.message}</p><p style="font-size:0.9rem; margin-top:0.5rem">Please check your connection and try again.</p>`;
        if (resultsContainer) {
          resultsContainer.innerHTML = "";
          resultsContainer.appendChild(errorMsg);
        } else {
          main.innerHTML = "";
          main.appendChild(errorMsg);
        }
      }
    });
}

async function handleSave(item, btn, originalText) {
  const volume = item.volumeInfo || {};
  const bookData = {
    googleId: item.id,
    title: volume.title || "",
    authors: volume.authors || [],
    publishedDate: volume.publishedDate || "",
    cover: (volume.imageLinks && volume.imageLinks.thumbnail) || "",
    infoLink: volume.infoLink || "",
    accessInfo: item.accessInfo || {},
  };

  try {
    // Simulate a short delay for the "downloading" effect
    await new Promise((r) => setTimeout(r, 800));

    const resp = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book: bookData }),
    });

    if (resp.status === 401) {
      window.location.href = "login.html";
      return;
    }

    const result = await resp.json();
    if (!resp.ok) {
      alert("Failed to save: " + (result.message || resp.statusText));
      btn.innerHTML = originalText;
      btn.disabled = false;
      return;
    }

    // Success feedback
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
    btn.style.background = "var(--success)"; // Green
    btn.style.borderColor = "var(--success)";

    // Update local state
    savedBookIds.add(item.id);
  } catch (err) {
    console.error("Error saving:", err);
    alert("Error saving book. Check server.");
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function handleView(item) {
  // Open info link
  if (item.volumeInfo.infoLink) {
    window.open(item.volumeInfo.infoLink, "_blank");
  } else {
    alert("No details available for this book.");
  }
}

function renderSkeleton(count) {
  if (resultsContainer) {
    resultsContainer.style.opacity = "0";
    setTimeout(() => {
      resultsContainer.innerHTML = "";
      resultsContainer.style.opacity = "1";
    }, 200);
  }
  const row = document.createElement("div");
  row.className = "books";
  const n = Math.max(6, Math.min(20, count || 12));

  for (let i = 0; i < n; i++) {
    const card = document.createElement("div");
    card.className = "book-card";
    card.style.height = "380px";

    const img = document.createElement("div");
    img.style.width = "100%";
    img.style.height = "220px";
    img.style.background = "var(--edge)";
    img.style.borderRadius = "8px";
    img.style.marginBottom = "12px";

    const t = document.createElement("div");
    t.style.height = "20px";
    t.style.width = "80%";
    t.style.background = "var(--edge)";
    t.style.marginBottom = "8px";

    const a = document.createElement("div");
    a.style.height = "16px";
    a.style.width = "60%";
    a.style.background = "var(--edge)";

    card.appendChild(img);
    card.appendChild(t);
    card.appendChild(a);
    row.appendChild(card);
  }
  const target = resultsContainer || main;
  target.appendChild(row);
}

function renderPaginationContainer(q, page, per_page, totalItems, type) {
  let pager = document.getElementById("pager");
  if (pager) pager.remove();

  if (!totalItems || totalItems <= per_page) {
    return; // No pagination needed
  }
  const totalPages = Math.ceil(totalItems / per_page);

  pager = document.createElement("div");
  pager.id = "pager";
  pager.style.display = "flex";
  pager.style.justifyContent = "center";
  pager.style.gap = "10px";
  pager.style.marginTop = "30px";

  const createBtn = (text, disabled, onClick) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.disabled = disabled;
    b.style.padding = "8px 16px";
    b.style.border = "1px solid var(--edge)";
    b.style.background = "var(--surface)";
    b.style.color = "var(--text)";
    b.style.borderRadius = "6px";
    b.style.cursor = disabled ? "default" : "pointer";
    b.style.transition =
      "transform 180ms cubic-bezier(.2,.9,.2,1), background-color 200ms";
    if (!disabled) b.addEventListener("click", onClick);
    return b;
  };

  // Previous button
  const prevBtn = createBtn("Previous", page <= 1, () => {
    if (page > 1) {
      returnBooks({ q, page: page - 1, per_page, type });
    }
  });
  pager.appendChild(prevBtn);

  // Numbered pages (center current page, show up to 7 pages)
  let start = Math.max(1, page - 3);
  let end = Math.min(totalPages, start + 6);
  if (end - start < 6) start = Math.max(1, end - 6);

  for (let p = start; p <= end; p++) {
    const isActive = p === page;
    const btn = document.createElement("button");
    btn.textContent = String(p);
    btn.disabled = isActive;
    btn.style.padding = "8px 12px";
    btn.style.border = "1px solid var(--edge)";
    btn.style.background = isActive ? "var(--primary)" : "var(--surface)";
    btn.style.color = isActive ? "var(--primary-fg)" : "var(--text)";
    btn.style.borderRadius = "6px";
    btn.style.cursor = isActive ? "default" : "pointer";
    btn.addEventListener("click", () => {
      returnBooks({ q, page: p, per_page, type });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    pager.appendChild(btn);
  }

  // Next button
  const nextBtn = createBtn("Next", page >= totalPages, () => {
    if (page < totalPages) {
      returnBooks({ q, page: page + 1, per_page, type });
    }
  });
  pager.appendChild(nextBtn);

  main.appendChild(pager);
}

// Debounce helper function
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Sidebar & Panel Logic is now handled in setupSidebar() function

async function renderUserPanel() {
  const kaContent = document.getElementById("ka-content");
  if (!kaContent) return;

  try {
    const res = await fetch("/api/me");
    const user = await res.json();

    if (user.userId) {
      // User is logged in - show profile
      const displayName = user.username || user.email?.split("@")[0] || "User";
      const email = user.email || "No email";
      const initials = email
        .split("@")[0]
        .substring(0, 2)
        .toUpperCase()
        .padEnd(2, "U");

      // Fetch user's saved books count
      let savedCount = 0;
      try {
        const downloadsRes = await fetch("/api/downloads");
        if (downloadsRes.ok) {
          const downloadsData = await downloadsRes.json();
          savedCount = downloadsData.downloads
            ? downloadsData.downloads.length
            : 0;
        }
      } catch (e) {
        console.warn("Failed to fetch downloads count", e);
      }

      kaContent.innerHTML = `
        <div style="text-align: center; margin-bottom: 2rem;">
          <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(
            initials
          )}&background=random&color=fff&size=128" 
               alt="${displayName}" 
               style="width: 80px; height: 80px; border-radius: 50%; margin-bottom: 1rem; border: 3px solid var(--primary);">
          <h3 style="margin: 0.5rem 0; color: var(--text);">${displayName}</h3>
          <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">${email}</p>
        </div>
        
        <div style="border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 1rem 0; margin: 1.5rem 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <span style="color: var(--text-muted);">Saved Books</span>
            <strong style="color: var(--text);">${savedCount}</strong>
          </div>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          <a href="account.html" style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-radius: 8px; text-decoration: none; color: var(--text); background: var(--surface-hover); transition: background 0.2s;">
            <i class="fa-solid fa-book-open"></i>
            <span>My Library</span>
          </a>
          <a href="#" style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-radius: 8px; text-decoration: none; color: var(--text); background: var(--surface-hover); transition: background 0.2s;">
            <i class="fa-solid fa-gear"></i>
            <span>Settings</span>
          </a>
          <button id="panel-logout" style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-radius: 8px; border: none; background: var(--danger); color: white; cursor: pointer; font-size: 1rem; transition: opacity 0.2s;">
            <i class="fa-solid fa-sign-out-alt"></i>
            <span>Logout</span>
          </button>
        </div>
      `;

      // Add logout handler
      const panelLogout = document.getElementById("panel-logout");
      if (panelLogout) {
        panelLogout.addEventListener("click", handleLogout);
      }
    } else {
      // User is not logged in
      kaContent.innerHTML = `
        <div style="text-align: center; padding: 2rem 0;">
          <i class="fa-solid fa-user-circle" style="font-size: 4rem; color: var(--text-muted); margin-bottom: 1rem;"></i>
          <p style="color: var(--text-muted); margin-bottom: 1.5rem;">Please log in to view your profile</p>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            <a href="login.html" style="padding: 0.75rem; border-radius: 8px; text-decoration: none; background: var(--primary); color: white; text-align: center; font-weight: 600;">
              Login
            </a>
            <a href="register.html" style="padding: 0.75rem; border-radius: 8px; text-decoration: none; background: var(--surface); color: var(--text); text-align: center; border: 1px solid var(--border);">
              Register
            </a>
          </div>
        </div>
      `;
    }
  } catch (err) {
    console.error("Error rendering user panel:", err);
    kaContent.innerHTML = `<p style="color: var(--text-muted);">Error loading profile</p>`;
  }
}

async function handleLogout(e) {
  e.preventDefault();
  try {
    await fetch("/api/logout", { method: "POST" });
    window.location.reload();
  } catch (err) {
    console.error("Logout failed", err);
  }
}
