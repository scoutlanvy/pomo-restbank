import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { View } from "../ipc-types";
import { pendingFeedbackMarkup, type Commands } from "./commands";
import type { Dialog } from "./dialog";
import { escape } from "./markup";

type SettingsOptions = {
  dialog: Dialog;
  commands: Commands;
  getView: () => View;
  showError: (error: string) => void;
};

export function createSettings({ dialog, commands, getView, showError }: SettingsOptions) {
  const { content, element } = dialog;
  let pendingSave: { form: HTMLFormElement; revision: number } | null = null;
  const applicationVersion = getVersion().catch((error) => {
    console.error("Unable to read application version", error);
    return null;
  });

  function quit() {
    void invoke("quit_application").catch((error) => showError(String(error)));
  }

  element.addEventListener("close", () => {
    if (getView().initializing && content.querySelector("#local-setup")) quit();
  });

  function canEdit() {
    return commands.usable() && getView().snapshot?.state.status === "idle";
  }

  function render() {
    const preferences = content.querySelector<HTMLFormElement>("#preferences");
    if (!preferences) return;

    const view = getView();
    const idle = view.snapshot?.state.status === "idle";
    const mode = content.querySelector<HTMLSelectElement>("#backend-mode")!;
    mode.disabled = commands.pending() || (commands.connected() && !idle);
    content.querySelector("#mode-status")!.textContent = modeStatus(view);

    const unavailable = !commands.available() || !idle;
    commands.lockControl(preferences.querySelector("fieldset")!, unavailable);
    commands.lockControl(
      preferences.querySelector<HTMLButtonElement>('[type="submit"]')!,
      unavailable,
    );
    content.querySelector<HTMLElement>("#preferences-hint")!.hidden = !unavailable;
    commands.lockControl(
      content.querySelector<HTMLButtonElement>('#connection-form [type="submit"]')!,
      false,
    );
  }

  function syncView() {
    const view = getView();
    if (view.initializing && !element.open) openLocalSetup();
    if (!view.initializing && content.querySelector("#local-setup")) dialog.close();

    if (
      element.open &&
      pendingSave &&
      pendingSave.form === content.querySelector("#preferences") &&
      !view.pending &&
      view.snapshot &&
      view.snapshot.state.revision > pendingSave.revision
    ) {
      if (!view.error) dialog.close();
      pendingSave = null;
    }
  }

  function open(connectionOnly = false) {
    pendingSave = null;
    const view = getView();
    dialog.open("Make it your space", settingsMarkup(view, canEdit()));

    const versionLabel = content.querySelector("#application-version")!;
    void applicationVersion.then((version) => {
      versionLabel.textContent = version ? `Version ${version}` : "Version unavailable";
    });
    const preferences = content.querySelector<HTMLFormElement>("#preferences")!;
    const volume = preferences.querySelector<HTMLInputElement>("#tick-volume")!;
    const volumeOutput = preferences.querySelector("#volume-output")!;
    volume.addEventListener("input", () => {
      volumeOutput.textContent = `${volume.value}%`;
    });
    preferences.querySelector("#cancel-preferences")!.addEventListener("click", dialog.close);
    preferences.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!canEdit()) {
        render();
        return;
      }
      dialog.setError("");
      const save = {
        form: preferences,
        revision: getView().snapshot!.state.revision,
      };
      const alarmDuration = preferences.querySelector<HTMLSelectElement>("#alarm-duration")!;
      const scope = preferences.querySelector<HTMLSelectElement>("#scope")!;
      const tickSound = preferences.querySelector<HTMLInputElement>("#tick-sound")!;
      pendingSave = save;
      const sent = await commands.send({
        type: "save_settings",
        alarm_sound_seconds: Number(alarmDuration.value),
        focus_scope: scope.value,
        tick_sound: tickSound.checked,
        tick_volume: Number(volume.value),
      });
      if (!sent && pendingSave === save) pendingSave = null;
    });

    const connection = content.querySelector<HTMLFormElement>("#connection-form")!;
    const endpoint = connection.querySelector<HTMLInputElement>("#endpoint")!;
    const token = connection.querySelector<HTMLInputElement>("#token")!;
    connection.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await invoke("connect_server", { endpoint: endpoint.value.trim(), token: token.value });
        dialog.close();
      } catch (error) {
        showError(String(error));
      }
    });

    content.querySelector("#retry-settings-pending")!.addEventListener("click", commands.retry);
    render();
    commands.renderFeedback();
    bindApplicationPreferences();
    if (connectionOnly && view.backend !== "local") endpoint.focus();
  }

  function bindApplicationPreferences() {
    const form = content.querySelector<HTMLFormElement>("#application-preferences")!;
    form.querySelector("#quit-application")!.addEventListener("click", quit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await invoke("save_application_preferences", {
          backend: form.querySelector<HTMLSelectElement>("#backend-mode")!.value,
          closeBehavior: form.querySelector<HTMLSelectElement>("#close-behavior")!.value,
        });
        form.querySelector("#application-saved")!.textContent =
          "Saved. A mode change applies after Quit and reopen.";
      } catch (error) {
        showError(String(error));
      }
    });
  }

  function openLocalSetup() {
    pendingSave = null;
    dialog.open("Start your Local timer", `
      <div id="local-setup">
        <p>
          Keep your subject, history, break balance, and progress by importing
          the Pomo Restbank server data on this laptop.
        </p>
        <p class="hint">
          Stop the source server first. A backup is created; server data is never deleted.
          The copied timer opens paused. Local and Server data stay separate.
        </p>
        <div class="dialog-actions">
          <button class="secondary" id="cancel-local-setup">Cancel and quit</button>
          <button class="secondary" id="fresh-local">Start fresh</button>
          <button class="primary" id="import-local">Import existing data</button>
        </div>
        <p id="import-status" role="status"></p>
      </div>
    `);
    const setup = content.querySelector("#local-setup")!;
    const buttons = setup.querySelectorAll<HTMLButtonElement>("button");
    const status = setup.querySelector("#import-status")!;
    const importButton = setup.querySelector("#import-local")!;
    let busy = false;

    async function initialize(importData: boolean) {
      if (busy) return;
      busy = true;
      buttons.forEach((button) => {
        button.disabled = true;
      });
      status.textContent = importData
        ? "Creating backup and importing..."
        : "Creating Local data...";
      try {
        await invoke("initialize_local", { import: importData });
      } catch (error) {
        showError(String(error));
        status.textContent = "No existing data was replaced. Fix the issue and Retry.";
        importButton.textContent = "Retry import";
      } finally {
        busy = false;
        buttons.forEach((button) => {
          button.disabled = false;
        });
      }
    }

    setup.querySelector("#cancel-local-setup")!.addEventListener("click", quit);
    setup.querySelector("#fresh-local")!.addEventListener("click", () => void initialize(false));
    importButton.addEventListener("click", () => void initialize(true));
  }

  return { open, openLocalSetup, render, syncView };
}

function modeStatus(view: View) {
  return view.next_backend && view.next_backend !== view.backend
    ? "Mode saved. Choose Quit application, then reopen to apply it."
    : `Active mode: ${view.backend === "local" ? "Local" : "Server"}`;
}

function applicationSettingsMarkup(view: View) {
  const next = view.next_backend ?? view.backend ?? "server";
  const backup = view.backup_path ? `
    <details>
      <summary>Import backup</summary>
      <p class="hint">${escape(view.backup_path)}</p>
    </details>
  ` : "";
  return `
    <div class="settings-section">
      <h3>Application</h3>
      <p id="mode-status" class="muted">${modeStatus(view)}</p>
      <form id="application-preferences">
        <label>
          Connection mode
          <select id="backend-mode">
            <option value="local" ${next === "local" ? "selected" : ""}>Local - this laptop only</option>
            <option value="server" ${next === "server" ? "selected" : ""}>Server - sync across devices</option>
          </select>
        </label>
        <p class="hint">
          Local needs no separate server. Data stays separate. Changing mode
          applies after Quit and reopen; it does not stop a remote timer.
        </p>
        <label>
          When closing the window
          <select id="close-behavior">
            <option value="tray" ${view.close_behavior !== "quit" ? "selected" : ""}>
              Minimize to tray - timer and alarm stay active
            </option>
            <option value="quit" ${view.close_behavior === "quit" ? "selected" : ""}>Quit application</option>
          </select>
        </label>
        <div class="dialog-actions">
          <button class="secondary" type="button" id="quit-application">Quit application</button>
          <button class="primary" type="submit">Save application settings</button>
        </div>
        <p id="application-saved" role="status" class="hint"></p>
        ${backup}
      </form>
    </div>
  `;
}

function settingsMarkup(view: View, editable: boolean) {
  const settings = view.snapshot?.state.settings;
  const local = view.backend === "local";
  const disabled = editable ? "" : "disabled";
  const alarmDuration = settings?.alarm_sound_seconds ?? 30;
  const volume = settings?.tick_volume ?? 100;
  const description = local ? "Saved on this laptop." : "Shared with your other connected clients.";
  const tokenHint = view.has_token ? "Saved — leave blank to keep" : "Paste the token from your server";

  return `
    ${applicationSettingsMarkup(view)}
    <div class="settings-section">
      <h3>Timer preferences</h3>
      <div class="preferences-status">
        <p id="preferences-description" class="muted">${description}</p>
        ${pendingFeedbackMarkup("retry-settings-pending")}
      </div>
      <p id="preferences-hint" class="hint" ${editable ? "hidden" : ""}>
        Connect and finish or Reset the timer to edit preferences.
      </p>
      <form id="preferences">
        <fieldset ${disabled}>
          <label>
            Focus progress
            <select id="scope">
              <option value="shared" ${settings?.focus_scope !== "per_subject" ? "selected" : ""}>
                Shared across subjects
              </option>
              <option value="per_subject" ${settings?.focus_scope === "per_subject" ? "selected" : ""}>
                Per subject
              </option>
            </select>
          </label>
          <label>
            Alarm sound duration
            <select id="alarm-duration">
              <option value="30" ${alarmDuration === 30 ? "selected" : ""}>30 seconds</option>
              <option value="60" ${alarmDuration === 60 ? "selected" : ""}>1 minute</option>
              <option value="0" ${alarmDuration === 0 ? "selected" : ""}>Until stopped</option>
            </select>
          </label>
          <p class="hint">Only the sound stops. Dismiss the completed session with Stop Alarm.</p>
          <label class="check-row">
            <input id="tick-sound" type="checkbox" ${settings?.tick_sound ? "checked" : ""}>Tick every second
          </label>
          <label>
            Tick volume <output id="volume-output">${volume}%</output>
            <input id="tick-volume" type="range" min="0" max="400" step="1" value="${volume}">
          </label>
          <p class="hint">100% is the original volume. This does not change the alarm.</p>
        </fieldset>
        <div class="dialog-actions">
          <button type="button" id="cancel-preferences" class="secondary">Cancel</button>
          <button type="submit" class="primary" ${disabled}>Save preferences</button>
        </div>
      </form>
    </div>
    <div class="settings-section" ${local ? "hidden" : ""}>
      <h3>Your sync connection</h3>
      <p class="muted">One timer. Every connected window.</p>
      <form id="connection-form">
        <label>
          Server address
          <input id="endpoint" value="${escape(view.endpoint)}" spellcheck="false"
                 placeholder="ws://127.0.0.1:4317/v1/ws" required>
        </label>
        <label>
          Access token
          <input id="token" type="password" autocomplete="off" placeholder="${tokenHint}">
        </label>
        <p class="hint">Controls need a connection. Closing this window leaves the server timer running.</p>
        <button type="submit" class="secondary" ${view.pending ? "disabled" : ""}>Save and connect</button>
      </form>
    </div>
    <section class="settings-section" aria-label="About">
      <h3>About</h3>
      <p>Pomo Restbank</p>
      <p id="application-version" class="muted">Version: Loading...</p>
    </section>
  `;
}
