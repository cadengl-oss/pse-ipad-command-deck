(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const input = $("missionInput");
  const toast = $("toast");
  let deferredInstall = null;
  const presets = {
    mac: "Give me the current evidence-backed status of my PSE MacBook environment and the best next action.",
    omarchy: "Give me the current evidence-backed status of my PSE Omarchy machine and the best next action.",
    vps: "Give me the current evidence-backed status of my PSE VPS services and storage, then the best next action.",
    sns: "S and S Go: summarize current state and scope, then continue with the highest-value safe next step and verify it.",
    sales: "Open the current Website Sales OS context, summarize its latest status, and continue the highest-priority unfinished item safely.",
    control: "Open PSE Mission Control context and give me the most useful current control summary from connected PSE tools.",
    ai: "Review the PSE AI pool, Herdr path, and shared NVIDIA NIM 40 RPM budget. Report readiness and the main bottleneck.",
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
    $("networkText").textContent = online ? "Remote shell online" : "Offline";
    $("networkBadge").style.color = online ? "var(--green)" : "#ff7d8b";
  }
  document.querySelectorAll(".mission").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = presets[button.dataset.preset] || "";
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  $("copyButton").addEventListener("click", () => copyMission().catch(() => notify("Copy failed. Select the text manually.")));
  $("openButton").addEventListener("click", () => openChatGPT().catch(() => notify("Open failed. Mission is still in the composer.")));
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; });
  $("installButton").addEventListener("click", async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; return; }
    notify("On iPad Safari: Share → Add to Home Screen.");
  });
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("./sw.js").catch(() => {});
  updateNetwork();
  const updateClock = () => { $("clock").textContent = new Date().toLocaleString([], { weekday:"short", hour:"2-digit", minute:"2-digit" }); };
  updateClock(); setInterval(updateClock, 30000);
})();
