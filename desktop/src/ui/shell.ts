import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { View } from "../ipc-types";
import type { Commands } from "./commands";
import { setText } from "./dom";
import { escape, icon } from "./markup";

export function mountShell(root: HTMLElement) {
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#" aria-label="Pomo Restbank home">
        <span class="brandmark">${icon("cup")}</span><span>Pomo <strong>Restbank</strong></span>
      </a>
      <div class="header-actions">
        <button class="icon-button" id="compact-toggle" disabled
                aria-label="Enter compact mode" title="Compact mode">${icon("compact")}</button>
        <button class="icon-button" id="theme" aria-label="Toggle color theme">${icon("sun")}</button>
        <button class="icon-button" id="settings" aria-label="Open settings">${icon("settings")}</button>
      </div>
    </header>
    <main>
      <div id="banner" role="status" aria-live="polite"></div>
      <div id="workspace"></div>
    </main>
    <footer><span>Build focus. Bank your breaks.</span><span id="profile-label"></span></footer>
    <dialog id="modal"><div id="modal-content"></div></dialog>
  `;
  root.querySelector(".brand")!.addEventListener("click", (event) => {
    event.preventDefault();
  });
  setupTheme(root.querySelector("#theme")!);

  const banner = root.querySelector<HTMLDivElement>("#banner")!;
  const profile = root.querySelector("#profile-label")!;
  let renderedBanner: string | undefined;

  function renderBanner(view: View, localError: string | null, commands: Commands) {
    const error = localError ?? view.error ?? view.snapshot?.storage_error;
    const preview = view.preview
      ? '<div class="notice preview">TEST MODE · Short sessions · Separate data</div>'
      : "";
    const errorNotice = error ? `<div class="notice error">${escape(error)}</div>` : "";
    const retry = view.snapshot?.storage_error
      ? '<button id="retry-storage" class="secondary">Retry storage</button>'
      : "";
    const notices = `${preview}${errorNotice}${retry}`;
    if (renderedBanner !== notices) {
      renderedBanner = notices;
      banner.innerHTML = notices;
      banner.querySelector("#retry-storage")?.addEventListener("click", () => {
        void commands.send({ type: "retry_storage" });
      });
    }
    const retryStorage = banner.querySelector<HTMLButtonElement>("#retry-storage");
    if (retryStorage) commands.lockControl(retryStorage, !commands.connected());
  }

  return {
    workspace: root.querySelector<HTMLDivElement>("#workspace")!,
    modal: root.querySelector<HTMLDialogElement>("#modal")!,
    settingsButton: root.querySelector<HTMLButtonElement>("#settings")!,
    renderBanner,
    renderProfile(view: View) {
      setText(profile, view.backend === "local" ? "Local - This laptop" : `Profile: ${view.profile}`);
    },
  };
}

function setupTheme(button: Element) {
  const saved = localStorage.getItem("restbank:theme");
  let theme: "dark" | "light" = saved === "dark" || saved === "light"
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  let nativeThemeUpdate = Promise.resolve();

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const selected = theme;
    // Serialize native updates so rapid toggles keep the final selected theme.
    nativeThemeUpdate = nativeThemeUpdate
      .then(async () => {
        const win = getCurrentWebviewWindow();
        await win.setTheme(selected);
        await win.setBackgroundColor(selected === "dark" ? "#14151e" : "#f5f5f8");
      })
      .catch((error) => console.error("Could not update window theme:", error));
  }

  applyTheme();
  button.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme();
    localStorage.setItem("restbank:theme", theme);
  });
}
