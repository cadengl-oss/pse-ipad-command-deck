(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const input = $("missionInput");
  const toast = $("toast");
  const SURFACE_API = "https://omarchy.tail7ba003.ts.net:10443/api/surface";
  const LIBRARY_FALLBACK = "https://omarchy.tail7ba003.ts.net:10443/";
  const PRIVATE_DECK = "https://omarchy.tail7ba003.ts.net:9443/deck/";
  let deferredInstall = null;
  let libraryProducts = [];
  let libraryPayload = null;

  const presets = {
    mac: "Give me the current evidence-backed status of my PSE MacBook environment and the best next action.",
    omarchy: "Give me the current evidence-backed status of my PSE Omarchy machine and the best next action.",
    vps: "Give me the current evidence-backed status of my PSE VPS services and storage, then the best next action.",
    sns: "S and S Go: summarize current state and scope, then continue with the highest-value safe next step and verify it.",
    sales: "Open the current Website Sales OS context, summarize its latest status, and continue the highest-priority unfinished item safely.",
    control: "Open PSE Mission Control context and give me the most useful current control summary from connected PSE tools.",
    ai: "Review the PSE AI pool, Herdr path, and shared NVIDIA NIM rate-limit budget. Report readiness and the main bottleneck.",
    jobs: "Review the centralized PSE job opportunity workflow and give me the current actionable queue and next step."
  };

  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function packagedMission() {
    const mission = input.value.trim();
    if (!mission) return "";
    return `PSE COMMAND DECK MISSION\n\nObjective:\n${mission}\n\nRules:\n- Preserve relevant PSE context.\n- Be precise and evidence-backed.\n- No OpenAI API key is available or required for this workflow.`;
  }

  async function copyMission() {
    const mission = packagedMission();
    if (!mission) return "";
    await navigator.clipboard.writeText(mission);
    notify("Mission copied for ChatGPT.");
    return mission;
  }

  async function openChatGPT() {
    const mission = await copyMission();
    if (!mission) { notify("Enter a mission first."); input.focus(); return; }
    location.href = `https://chatgpt.com/?prompt=${encodeURIComponent(mission)}`;
  }

  function updateNetwork() {
    const online = navigator.onLine;
    $("networkText").textContent = online ? "Network online" : "Offline";
    $("networkBadge").style.color = online ? "var(--green)" : "#ff7d8b";
  }

  function safeHttpUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function libraryCard(item) {
    const link = document.createElement("a");
    link.className = "mission app-link library-card";
    link.href = safeHttpUrl(item.launchUrl) || safeHttpUrl(item.detailUrl) || LIBRARY_FALLBACK;
    link.target = "_blank";
    link.rel = "noopener";
    link.dataset.health = String(item.health || "UNKNOWN");

    const title = document.createElement("b");
    title.textContent = String(item.name || item.id || "PSE product");
    const meta = document.createElement("span");
    meta.textContent = [item.category, item.lifecycle].filter(Boolean).join(" · ");
    const state = document.createElement("em");
    state.textContent = item.launchUrl ? String(item.health || "UNKNOWN") + " · OPEN" : String(item.health || "UNKNOWN") + " · DETAIL";
    link.append(title, meta, state);
    return link;
  }

  function renderLibrary() {
    const grid = $("libraryGrid");
    grid.replaceChildren();
    const query = $("librarySearch").value.trim().toLowerCase();
    const lifecycleRank = { ACTIVE: 0, BUILDING: 1, CANDIDATE: 2, PROTOTYPE: 3, DESIGN: 4, MAINTENANCE: 5, SUPERSEDED: 6 };
    const healthRank = { HEALTHY: 0, NOT_APPLICABLE: 1, UNKNOWN: 2, BLOCKED: 3, DEGRADED: 4, OFFLINE: 5 };

    let rows = libraryProducts.filter((item) => {
      if (!query) return item.lifecycle === "ACTIVE";
      const text = [item.name, item.category, ...(item.aliases || [])].join(" ").toLowerCase();
      return text.includes(query);
    });
    rows.sort((a, b) => {
      const launchDelta = Number(Boolean(b.launchUrl)) - Number(Boolean(a.launchUrl));
      if (launchDelta) return launchDelta;
      const lifecycleDelta = (lifecycleRank[a.lifecycle] ?? 9) - (lifecycleRank[b.lifecycle] ?? 9);
      if (lifecycleDelta) return lifecycleDelta;
      const healthDelta = (healthRank[a.health] ?? 9) - (healthRank[b.health] ?? 9);
      if (healthDelta) return healthDelta;
      return String(a.name).localeCompare(String(b.name));
    });
    rows = rows.slice(0, query ? 30 : 12);

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = libraryProducts.length ? "No canonical products match that search." : "Live App Library is unavailable.";
      grid.appendChild(empty);
      return;
    }
    rows.forEach((item) => grid.appendChild(libraryCard(item)));
  }

  async function loadLibrary() {
    $("libraryState").textContent = "Connecting…";
    $("libraryState").dataset.state = "loading";
    $("gridState").textContent = "CHECKING";
    try {
      const response = await fetch(SURFACE_API, {
        cache: "no-store",
        mode: "cors",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("surface " + response.status);
      const data = await response.json();
      if (data?.schemaVersion !== 1 || !Array.isArray(data.products)) throw new Error("invalid surface contract");

      libraryPayload = data;
      libraryProducts = data.products;
      $("libraryOpen").href = safeHttpUrl(data.libraryUrl) || LIBRARY_FALLBACK;
      $("libraryOpen").textContent = "Open full Library ↗";
      const active = libraryProducts.filter((item) => item.lifecycle === "ACTIVE");
      const healthy = active.filter((item) => item.health === "HEALTHY").length;
      const attention = active.filter((item) => ["UNKNOWN", "BLOCKED", "DEGRADED", "OFFLINE"].includes(item.health)).length;
      $("libraryMeta").textContent = active.length + " active · " + healthy + " healthy · " + attention + " attention · " + String(data.authority || "PSE App Library + Pulse");
      $("libraryState").textContent = "Live";
      $("libraryState").dataset.state = "live";
      $("gridState").textContent = "LIVE";
      renderLibrary();
    } catch {
      libraryPayload = null;
      libraryProducts = [];
      const publicBootstrap = location.hostname === "cadengl-oss.github.io";
      $("libraryOpen").href = publicBootstrap ? PRIVATE_DECK : LIBRARY_FALLBACK;
      $("libraryOpen").textContent = publicBootstrap ? "Open Private Deck ↗" : "Open full Library ↗";
      $("libraryState").textContent = publicBootstrap ? "Private Deck required" : "Private link unavailable";
      $("libraryState").dataset.state = "offline";
      $("gridState").textContent = "PRIVATE";
      $("libraryMeta").textContent = publicBootstrap
        ? "This public bootstrap cannot read private Grid data in every browser. Open the Private Deck on the PSE tailnet for live products and health."
        : "Private Grid link unavailable. Verify tailnet connectivity, then refresh. Cached Command Deck missions remain available.";
      renderLibrary();
    }
  }

  document.querySelectorAll(".mission[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = presets[button.dataset.preset] || "";
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  $("copyButton").addEventListener("click", () => copyMission().catch(() => notify("Copy failed. Select the text manually.")));
  $("openButton").addEventListener("click", () => openChatGPT().catch(() => notify("Open failed. Mission is still in the composer.")));
  $("librarySearch").addEventListener("input", renderLibrary);
  $("libraryRefresh").addEventListener("click", () => loadLibrary());
  window.addEventListener("online", () => { updateNetwork(); loadLibrary(); });
  window.addEventListener("offline", updateNetwork);
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; });

  $("installButton").addEventListener("click", async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; return; }
    notify("On iPad Safari: Share → Add to Home Screen.");
  });

  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("./sw.js").catch(() => {});
  updateNetwork();
  loadLibrary();
  const updateClock = () => { $("clock").textContent = new Date().toLocaleString([], { weekday:"short", hour:"2-digit", minute:"2-digit" }); };
  updateClock(); setInterval(updateClock, 30000);
})();
