import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowLayout } from "./window-layout";

type Mode = "manual" | "pomodoro";
type Status = "idle" | "running" | "paused" | "choice" | "alarm";
type Scope = "shared" | "per_subject";
type Timer = {
  phase: "manual" | "focus" | "break";
  total_seconds: number;
  remaining_seconds: number;
  subject: string;
  suspended_focus: Timer | null;
  return_to_choice: boolean;
};
type State = {
  revision: number;
  tick_sequence: number;
  mode: Mode;
  subject: string;
  status: Status;
  timer: Timer | null;
  balance_seconds: number;
  cycle_position: number;
  shared_progress: number;
  per_subject_progress: Record<string, number>;
  settings: { focus_scope: Scope; tick_sound: boolean; tick_volume: number };
  subjects: string[];
  focus_seconds: number;
  alarm_id: string | null;
};
type Snapshot = {
  state: State;
  server_time_ms: number;
  storage_error: string | null;
  preview: boolean;
};
type Backend = "local" | "server";
type CloseBehavior = "tray" | "quit";
type View = {
  snapshot: Snapshot | null;
  connection: string;
  endpoint: string;
  has_token: boolean;
  pending: string | null;
  error: string | null;
  profile: string;
  preview: boolean;
  backend?: Backend;
  next_backend?: Backend;
  close_behavior?: CloseBehavior;
  initializing?: boolean;
  import_available?: boolean;
  tray_available?: boolean;
  backup_path?: string | null;
};
type Session = {
  session_id: string;
  subject: string;
  duration_seconds: number;
  recorded_at: string;
  mode: Mode;
};
type Summary = { subject: string; duration_seconds: number; count: number };
type History = { type: "history"; sessions: Session[]; summary: Summary[] };
type Command = { type: string; [key: string]: string | number | boolean };
const icon = (name: string) => {
  const paths: Record<string, string> = {
    compact:
      '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9Z"/>',
    expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    settings:
      '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5"/><circle cx="15" cy="17" r="2.5"/>',
    history: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6M12 7v5l3 2"/>',
    cup: '<path d="M4 8h12v7a5 5 0 0 1-10 0V8M16 9h2a3 3 0 0 1 0 6h-2M5 21h12M8 3v2M12 3v2"/>',
    target:
      '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    reset: '<path d="M4 9a8 8 0 1 1 1 9M4 3v6h6"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-6 0"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.clock}</svg>`;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const formatTime = (n: number) => {
  n = Math.max(0, Math.floor(n));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
};
const duration = (n: number) =>
  n < 60
    ? `${n}s`
    : n < 3600
      ? `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`
      : `${Math.floor(n / 3600)}h ${Math.floor(n / 60) % 60}m`;
let view: View = {
  snapshot: null,
  connection: "disconnected",
  endpoint: "",
  has_token: false,
  pending: null,
  error: null,
  profile: "default",
  preview: false,
};
let history: History | null = null;
let historyVisible = false;
let compact = false;
let compactDetails = false;
let layoutChanging = false;
const windowLayout = new WindowLayout();
let historyTab = "recent";
let localError: string | null = null;
let manual = [0, 0, 0];
let snapshotArrived = performance.now();
let lastSnapshotKey = "";
let spaceHeld = false;
let dialogReturnFocus: HTMLElement | null = null;
let settingsSaveRevision: number | null = null;
let lastViewRevision: number | undefined;
let renderedBanner: string | undefined;
let commandSubmitting = false;
let pendingFeedbackKey: string | null = null;
let pendingFeedbackVisible = false;
let pendingFeedbackTimer: number | undefined;
const markupCache = new WeakMap<Element, string>();
let renderedSubjects = "";
let renderedHistory: History | null | undefined;
let renderedHistoryTab = "";
let renderedHistoryConnected: boolean | undefined;
const historyDateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<header class="topbar"><a class="brand" href="#" aria-label="Pomo Restbank home"><span class="brandmark">${icon("cup")}</span><span>Pomo <strong>Restbank</strong></span></a><div class="header-actions"><button class="icon-button" id="compact-toggle" disabled aria-label="Enter compact mode" title="Compact mode">${icon("compact")}</button><button class="icon-button" id="theme" aria-label="Toggle color theme">${icon("sun")}</button><button class="icon-button" id="settings" aria-label="Open settings">${icon("settings")}</button></div></header><main><div id="banner" role="status" aria-live="polite"></div><div id="workspace"></div></main><footer><span>Build focus. Bank your breaks.</span><span id="profile-label"></span></footer><dialog id="modal"><div id="modal-content"></div></dialog>`;
const workspace = document.querySelector<HTMLDivElement>("#workspace")!;
const modal = document.querySelector<HTMLDialogElement>("#modal")!;
const modalContent = document.querySelector<HTMLDivElement>("#modal-content")!;
const headerActions = document.querySelector<HTMLElement>(".header-actions")!;
document
  .querySelector("#compact-toggle")!
  .addEventListener("click", () => changeLayout(!compact));
async function changeLayout(
  nextCompact: boolean,
  details = false,
  showHistory = false,
) {
  if (layoutChanging || (nextCompact && !view.snapshot)) return;
  layoutChanging = true;
  const focused = document.activeElement as HTMLElement | null;
  syncLayoutButtons();
  if (modal.open) modal.close();
  workspace
    .querySelectorAll<HTMLElement>(":popover-open")
    .forEach((p) => p.hidePopover());
  try {
    await windowLayout.change(nextCompact, details);
    compact = nextCompact;
    compactDetails = nextCompact && details;
    document.documentElement.dataset.layout = compact ? "compact" : "full";
    document.documentElement.dataset.details = String(compactDetails);
    const destination = compact
      ? workspace.querySelector(".section-top")
      : document.querySelector(".topbar");
    destination?.append(headerActions);
    if (showHistory) {
      historyVisible = true;
      if (connected()) loadHistory();
    }
    render();
  } catch (error) {
    showError(`Could not change the window layout: ${String(error)}`);
  } finally {
    layoutChanging = false;
    syncLayoutButtons();
    if (focused?.isConnected && focused.getClientRects().length)
      focused.focus();
    else document.querySelector<HTMLButtonElement>("#compact-toggle")!.focus();
  }
}
function syncLayoutButtons() {
  const toggle = document.querySelector<HTMLButtonElement>("#compact-toggle")!;
  toggle.disabled = layoutChanging || !view.snapshot;
  toggle.setAttribute(
    "aria-label",
    compact ? "Return to full view" : "Enter compact mode",
  );
  toggle.title = compact ? "Full view" : "Compact mode";
  setMarkup(toggle, icon(compact ? "expand" : "compact"));
  document
    .querySelectorAll<HTMLButtonElement>(
      "#compact-detail-toggle, #full-view, #compact-history",
    )
    .forEach((button) => {
      button.disabled = layoutChanging;
    });
}
const savedTheme = localStorage.getItem("restbank:theme");
let theme: "dark" | "light" =
  savedTheme === "dark" || savedTheme === "light"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let nativeThemeUpdate = Promise.resolve();
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const selected = theme;
  // Serialize native updates so rapid toggles keep the final selected theme.
  nativeThemeUpdate = nativeThemeUpdate
    .then(() => getCurrentWindow().setTheme(selected))
    .catch((error) => console.error("Could not update window theme:", error));
}
applyTheme();
document.querySelector("#theme")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  applyTheme();
  localStorage.setItem("restbank:theme", theme);
});
document
  .querySelector("#settings")!
  .addEventListener("click", () => openSettings());
document
  .querySelector(".brand")!
  .addEventListener("click", (e) => e.preventDefault());
modal.addEventListener("click", (e) => {
  if (e.target !== modal) return;
  const bounds = modal.getBoundingClientRect();
  if (
    e.clientX < bounds.left ||
    e.clientX > bounds.right ||
    e.clientY < bounds.top ||
    e.clientY > bounds.bottom
  )
    modal.close();
});
modal.addEventListener("close", () => {
  dialogReturnFocus?.focus();
  if (view.initializing && modalContent.querySelector("#local-setup")) call("quit_application");
});
function openDialog(title: string, content: string) {
  dialogReturnFocus = document.activeElement as HTMLElement;
  settingsSaveRevision = null;
  modalContent.innerHTML = `<div class="dialog-heading"><h2>${title}</h2><button class="icon-button close-modal" aria-label="Close dialog">${icon("close")}</button></div>${content}<p id="dialog-error" role="alert" class="error-text"></p>`;
  modalContent
    .querySelector(".close-modal")!
    .addEventListener("click", () => modal.close());
  modalContent.querySelectorAll("input,select").forEach((input) => {
    input.addEventListener("input", clearDialogError);
  });
  if (!modal.open) modal.showModal();
}
function clearDialogError() {
  const error = document.querySelector("#dialog-error");
  if (error) error.textContent = "";
}
function setText(element: Element | null, value: string) {
  if (element && element.textContent !== value) element.textContent = value;
}
function setMarkup(element: Element, value: string) {
  if (markupCache.get(element) !== value) {
    element.innerHTML = value;
    markupCache.set(element, value);
  }
}
async function call<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T | undefined> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    showError(String(error));
    return undefined;
  }
}
function showError(error: string) {
  if (modal.open) document.querySelector("#dialog-error")!.textContent = error;
  else {
    localError = error;
    renderBanner();
  }
}
async function command(cmd: Command) {
  if (
    !connected() ||
    commandSubmitting ||
    view.pending ||
    (view.snapshot?.storage_error && cmd.type !== "retry_storage")
  )
    return false;
  localError = null;
  commandSubmitting = true;
  render();
  try {
    await invoke("send_command", { command: cmd });
    return true;
  } catch (error) {
    showError(String(error));
    return false;
  } finally {
    commandSubmitting = false;
    render();
  }
}
function connected() {
  return view.connection === "connected";
}
function available() {
  return connected() && !view.snapshot?.storage_error;
}
function commandPending() {
  return !!view.pending || commandSubmitting;
}
function usable() {
  return available() && !commandPending();
}
function lockCommandControl(
  control: HTMLButtonElement | HTMLInputElement | HTMLFieldSetElement,
  unavailable: boolean,
) {
  const pendingOnly = commandPending() && !unavailable;
  control.disabled = unavailable || commandPending();
  control.classList.toggle("pending-lock", pendingOnly);
  if (pendingOnly) control.setAttribute("aria-busy", "true");
  else control.removeAttribute("aria-busy");
}
function pendingFeedbackMarkup(retryId: string) {
  return `<div class="command-feedback" hidden><span role="status" aria-live="polite" aria-atomic="true"></span><button id="${retryId}" class="text-button">Retry same command</button></div>`;
}
function renderPendingFeedback() {
  const visible = pendingFeedbackVisible && !!view.pending;
  document
    .querySelectorAll<HTMLElement>(".command-feedback")
    .forEach((feedback) => {
      feedback.hidden = !visible;
      setText(
        feedback.querySelector('[role="status"]'),
        visible ? "Waiting\u2026" : "",
      );
      feedback.querySelector<HTMLButtonElement>("button")!.disabled =
        !connected();
    });
  const title = workspace.querySelector<HTMLElement>(".section-top .eyebrow");
  if (title) title.hidden = visible;
  const description = modalContent.querySelector<HTMLElement>(
    "#preferences-description",
  );
  if (description) description.hidden = visible;
}
function syncPendingFeedback() {
  const key = view.pending
    ? JSON.stringify([view.endpoint, view.profile, view.pending])
    : null;
  if (key === pendingFeedbackKey) return;
  if (pendingFeedbackTimer !== undefined)
    window.clearTimeout(pendingFeedbackTimer);
  pendingFeedbackTimer = undefined;
  pendingFeedbackKey = key;
  pendingFeedbackVisible = false;
  if (key) {
    pendingFeedbackTimer = window.setTimeout(() => {
      if (pendingFeedbackKey !== key || !view.pending) return;
      pendingFeedbackTimer = undefined;
      pendingFeedbackVisible = true;
      renderPendingFeedback();
    }, 300);
  }
}
function renderBanner() {
  const banner = document.querySelector<HTMLDivElement>("#banner")!;
  const error = localError ?? view.error ?? view.snapshot?.storage_error;
  const content = `${view.preview ? '<div class="notice preview">TEST MODE · Short sessions · Separate data</div>' : ""}${error ? `<div class="notice error">${escape(error)}</div>` : ""}${view.snapshot?.storage_error ? '<button id="retry-storage" class="secondary">Retry storage</button>' : ""}`;
  if (renderedBanner !== content) {
    renderedBanner = content;
    banner.innerHTML = content;
    banner
      .querySelector("#retry-storage")
      ?.addEventListener("click", () => command({ type: "retry_storage" }));
  }
  const retryStorage =
    banner.querySelector<HTMLButtonElement>("#retry-storage");
  if (retryStorage) lockCommandControl(retryStorage, !connected());
}
function progress(s: State) {
  const t = s.timer?.phase === "focus" ? s.timer : s.timer?.suspended_focus;
  if (t && t.remaining_seconds > 0)
    return s.focus_seconds - t.remaining_seconds;
  return s.settings.focus_scope === "shared"
    ? s.shared_progress
    : (s.per_subject_progress[s.subject] ?? 0);
}
function canEditSettings() {
  return usable() && view.snapshot?.state.status === "idle";
}
function syncDialogControls() {
  const preferences =
    modalContent.querySelector<HTMLFormElement>("#preferences");
  if (!preferences) return;
  const modeSelect = modalContent.querySelector<HTMLSelectElement>("#backend-mode");
  if (modeSelect) modeSelect.disabled = Boolean(view.pending || commandSubmitting || (connected() && view.snapshot?.state.status !== "idle"));
  const modeStatus = modalContent.querySelector<HTMLElement>("#mode-status");
  if (modeStatus) modeStatus.textContent = view.next_backend && view.next_backend !== view.backend ? "Mode saved. Choose Quit application, then reopen to apply it." : `Active mode: ${view.backend === "local" ? "Local" : "Server"}`;
  const unavailable = !available() || view.snapshot?.state.status !== "idle";
  lockCommandControl(
    preferences.querySelector<HTMLFieldSetElement>("fieldset")!,
    unavailable,
  );
  lockCommandControl(
    preferences.querySelector<HTMLButtonElement>('[type="submit"]')!,
    unavailable,
  );
  modalContent.querySelector<HTMLElement>("#preferences-hint")!.hidden =
    !unavailable;
  lockCommandControl(
    modalContent.querySelector<HTMLButtonElement>(
      '#connection-form [type="submit"]',
    )!,
    false,
  );
}
function buildWorkspace() {
  renderedSubjects = "";
  renderedHistory = undefined;
  workspace.innerHTML = `<section class="timer-panel panel"><div class="section-top"><span class="compact-phase compact-only"></span><div class="panel-heading"><span class="eyebrow"></span>${pendingFeedbackMarkup("retry-pending")}</div><button id="connection-status" title="Connection settings"><i></i><span></span></button></div><div class="compact-subject compact-only"><strong></strong><span></span></div><div class="mode-tabs" role="group" aria-label="Timer mode"><button data-mode="manual">Manual</button><button data-mode="pomodoro">Pomodoro</button></div><div class="subject-row"><label for="subject">I'm focusing on</label><div class="subject-controls"><button id="subject" class="subject-picker" aria-haspopup="listbox" aria-expanded="false"><span class="subject-name"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><div id="subject-popup" class="subject-popup" popover="auto" role="listbox" aria-label="Study subjects"><div id="subject-menu" class="subject-context" role="menu" hidden><button role="menuitem" id="context-delete">Remove subject</button></div></div><button id="add-subject" class="icon-button small" aria-label="Add subject">${icon("plus")}</button><button id="delete-subject" class="icon-button small" aria-label="Delete selected subject">${icon("trash")}</button></div></div><div class="timer-face"><svg class="progress-ring" viewBox="0 0 300 300" aria-hidden="true"><circle class="ring-track" cx="150" cy="150" r="137"/><circle class="ring-fill" cx="150" cy="150" r="137" style="stroke-dasharray:860.8"/></svg><div class="timer-content"><span class="phase-icon"></span><div id="countdown" class="countdown" aria-label="Time remaining"></div><span class="timer-caption"></span><span id="estimate" class="estimate"></span></div></div><div class="duration-fields" aria-label="Manual duration">${["Hours", "Minutes", "Seconds"].map((name, i) => `<label><span class="drag-label" data-index="${i}">${name}</span><input id="duration-${i}" aria-label="${name}" inputmode="numeric" maxlength="2" value="${String(manual[i]).padStart(2, "0")}"></label>`).join('<span class="colon">:</span>')}</div><div class="timer-actions"><button id="primary" class="primary"></button><button id="reset" class="secondary">${icon("reset")}Reset</button></div><button id="skip" class="text-button">Skip break</button><div class="compact-footer compact-only"><span>Break balance <strong id="compact-balance"></strong></span><button id="compact-detail-toggle" class="text-button" aria-expanded="false" aria-controls="compact-details">Details ${icon("chevron")}</button></div><div id="compact-details" class="compact-only" role="region" aria-label="Timer details"></div><div class="stat-grid"><div class="stat-card"><span class="stat-icon">${icon("cup")}</span><div><span class="stat-label">Break balance</span><strong id="balance"></strong></div></div><div class="stat-card"><span class="stat-icon">${icon("target")}</span><div><span class="stat-label">Focus target</span><strong><span id="focus-progress"></span> <small id="focus-total"></small></strong></div></div></div><progress class="compact-target-progress compact-only" aria-label="Focus target progress" max="1" value="0"></progress><p class="scope-note"></p><div class="break-actions"><button id="break-all" class="secondary">${icon("cup")}Use break balance</button><button id="break-choose" class="text-button">Choose duration</button></div><div class="panel-bottom"><button id="compact-history" class="text-button compact-only">${icon("history")}History</button><button id="full-view" class="text-button compact-only">${icon("expand")}Full view</button><button id="history-toggle" class="text-button"></button><button id="timer-settings" class="text-button">${icon("settings")}Settings</button></div></section><section id="history-panel" class="panel history-panel" hidden></section>`;
  workspace
    .querySelector("#connection-status")!
    .addEventListener("click", () => openSettings(true));
  workspace
    .querySelector("#timer-settings")!
    .addEventListener("click", () => openSettings());
  workspace
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((button) => {
      button.addEventListener("click", () =>
        command({
          type: "select",
          mode: button.dataset.mode!,
          subject: view.snapshot!.state.subject,
        }),
      );
    });
  workspace
    .querySelector("#retry-pending")!
    .addEventListener("click", () => call("retry_pending"));
  workspace
    .querySelector("#compact-detail-toggle")!
    .addEventListener("click", () => changeLayout(true, !compactDetails));
  workspace
    .querySelector("#full-view")!
    .addEventListener("click", () => changeLayout(false));
  workspace
    .querySelector("#compact-history")!
    .addEventListener("click", () => changeLayout(false, false, true));
  setupSubjects();
  setupDuration();
  workspace.querySelector("#primary")!.addEventListener("click", primary);
  workspace.querySelector("#reset")!.addEventListener("click", () => {
    manual = [0, 0, 0];
    workspace
      .querySelectorAll<HTMLInputElement>(".duration-fields input")
      .forEach((input) => (input.value = "00"));
    command({ type: "reset" });
  });
  workspace
    .querySelector("#skip")!
    .addEventListener("click", () => command({ type: "skip_break" }));
  workspace.querySelector("#break-all")!.addEventListener("click", () =>
    command({
      type: "start_break",
      seconds: Math.min(view.snapshot!.state.balance_seconds, 4294967295),
    }),
  );
  workspace
    .querySelector("#break-choose")!
    .addEventListener("click", chooseBreak);
  workspace
    .querySelector("#add-subject")!
    .addEventListener("click", addSubject);
  workspace
    .querySelector("#delete-subject")!
    .addEventListener("click", () =>
      deleteSubject(view.snapshot!.state.subject),
    );
  workspace.querySelector("#history-toggle")!.addEventListener("click", () => {
    historyVisible = !historyVisible;
    render();
    if (historyVisible) loadHistory();
  });
}
function render() {
  syncLayoutButtons();
  renderBanner();
  setText(document.querySelector("#profile-label"), view.backend === "local" ? "Local - This laptop" : `Profile: ${view.profile}`);
  const s = view.snapshot?.state;
  if (!s) {
    if (!workspace.querySelector("#setup")) {
      workspace.innerHTML = `<section class="welcome panel"><span class="eyebrow">YOUR SPACE TO FOCUS</span><div class="welcome-icon">${icon("cup")}</div><h1>A little focus.<br>A well-earned break.</h1><p>${view.backend === "local" ? "Choose how to start your Local timer. Your server data stays separate." : "Connect to your Restbank server to start a shared timer and keep your progress together."}</p><button id="setup" class="primary">${icon("link")}${view.backend === "local" ? "Set up Local mode" : "Connect your timer"}</button><span class="connection"></span></section>`;
      workspace
        .querySelector("#setup")!
        .addEventListener("click", () => view.initializing ? openLocalSetup() : openSettings(true));
    }
    const connection = workspace.querySelector(".connection")!;
    connection.className = `connection ${view.connection}`;
    setMarkup(connection, `<i></i>${connectionName()}`);
    syncDialogControls();
    renderPendingFeedback();
    return;
  }
  if (!workspace.querySelector("#primary")) buildWorkspace();
  const idle = s.status === "idle";
  const disabled = !usable();
  const settingsDisabled = disabled || !idle;
  const canBreak =
    s.mode === "pomodoro" &&
    s.balance_seconds > 0 &&
    (idle ||
      s.status === "choice" ||
      (s.status === "paused" && s.timer?.phase === "focus"));
  const title =
    s.status === "alarm"
      ? "Time to take a breath"
      : s.status === "choice"
        ? "A focus session, well spent"
        : s.timer?.phase === "break"
          ? "Make room to recharge"
          : s.status === "paused"
            ? "Ready when you are"
            : "One thing at a time";
  const label =
    s.mode === "manual" && idle
      ? "Start timer"
      : {
          idle: "Start focus",
          running: "Pause",
          paused: "Resume",
          choice: "Continue Focus",
          alarm: "Stop Alarm",
        }[s.status];
  const caption =
    s.status === "alarm"
      ? "Session complete"
      : s.status === "choice"
        ? "Choose your next step"
        : s.status === "paused"
          ? "Paused"
          : s.timer?.phase === "break"
            ? "Resting"
            : s.mode === "manual"
              ? "Manual session"
              : `Focus session ${s.cycle_position + 1} of 4`;
  setText(workspace.querySelector(".section-top .eyebrow"), title);
  setText(
    workspace.querySelector(".compact-phase"),
    s.status === "alarm"
      ? "Complete"
      : s.status === "choice"
        ? "Choose next"
        : `${s.timer?.phase === "break" ? "Break" : s.mode === "manual" ? "Manual" : "Focus"}${s.status === "paused" ? " paused" : s.status === "idle" ? " ready" : ""}`,
  );
  setText(workspace.querySelector(".compact-subject strong"), s.subject);
  workspace.querySelector<HTMLElement>(".compact-subject strong")!.title =
    s.subject;
  setText(
    workspace.querySelector(".compact-subject > span"),
    `${s.mode === "manual" ? "Manual" : `Pomodoro \u00b7 session ${s.cycle_position + 1}/4`}${s.mode === "manual" && idle ? " \u00b7 Edit duration in full view" : ""}`,
  );
  setText(
    workspace.querySelector("#compact-balance"),
    formatTime(s.balance_seconds),
  );
  workspace.querySelector<HTMLProgressElement>(
    ".compact-target-progress",
  )!.value = Math.max(0, Math.min(1, progress(s) / s.focus_seconds));
  workspace
    .querySelector("#compact-detail-toggle")!
    .setAttribute("aria-expanded", String(compactDetails));
  const detailRegion =
    workspace.querySelector<HTMLElement>("#compact-details")!;
  // Move existing controls, never duplicate command handlers or timer nodes.
  for (const selector of compact
    ? [
        ".break-actions",
        ".stat-grid",
        ".compact-target-progress",
        ".scope-note",
        ".panel-bottom",
      ]
    : [
        ".stat-grid",
        ".compact-target-progress",
        ".scope-note",
        ".break-actions",
        ".panel-bottom",
      ]) {
    const element = workspace.querySelector<HTMLElement>(selector)!;
    if (compact && element.parentElement !== detailRegion)
      detailRegion.append(element);
    else if (!compact && element.parentElement === detailRegion)
      detailRegion.before(element);
  }
  detailRegion.hidden = !compact || !compactDetails;
  const connection =
    workspace.querySelector<HTMLButtonElement>("#connection-status")!;
  connection.className = `connection ${view.connection}`;
  setText(connection.querySelector("span"), connectionName());
  workspace
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((button) => {
      const selected = button.dataset.mode === s.mode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      lockCommandControl(button, !available() || !idle);
    });
  const subject = workspace.querySelector<HTMLButtonElement>("#subject")!;
  setText(subject.querySelector(".subject-name"), s.subject);
  subject.title = s.subject;
  lockCommandControl(subject, !available() || !idle);
  lockCommandControl(
    workspace.querySelector<HTMLButtonElement>("#add-subject")!,
    !available() || !idle,
  );
  lockCommandControl(
    workspace.querySelector<HTMLButtonElement>("#delete-subject")!,
    !available() || !idle || s.subject === "Umum",
  );
  const popup = workspace.querySelector<HTMLDivElement>("#subject-popup")!;
  const subjectKey = JSON.stringify(s.subjects);
  if (subjectKey !== renderedSubjects) {
    popup.querySelectorAll(".subject-option").forEach((row) => row.remove());
    workspace.querySelector<HTMLElement>("#subject-menu")!.hidden = true;
    popup.insertAdjacentHTML(
      "afterbegin",
      s.subjects
        .map(
          (name) =>
            `<button class="subject-option" role="option" data-name="${escape(name)}">${escape(name)}</button>`,
        )
        .join(""),
    );
    renderedSubjects = subjectKey;
  }
  popup
    .querySelectorAll<HTMLButtonElement>(".subject-option")
    .forEach((row) =>
      row.setAttribute("aria-selected", String(row.dataset.name === s.subject)),
    );
  if (settingsDisabled && popup.matches(":popover-open")) popup.hidePopover();
  setMarkup(
    workspace.querySelector(".phase-icon")!,
    icon(s.timer?.phase === "break" ? "cup" : "clock"),
  );
  setText(workspace.querySelector(".timer-caption"), caption);
  workspace.querySelector<HTMLElement>(".duration-fields")!.hidden =
    s.mode !== "manual";
  workspace
    .querySelectorAll<HTMLInputElement>(".duration-fields input")
    .forEach((input) => lockCommandControl(input, !available() || !idle));
  const primaryButton = workspace.querySelector<HTMLButtonElement>("#primary")!;
  setMarkup(
    primaryButton,
    `${icon(s.status === "running" ? "pause" : s.status === "alarm" ? "clock" : "play")}${label}`,
  );
  lockCommandControl(primaryButton, !available());
  lockCommandControl(
    workspace.querySelector<HTMLButtonElement>("#reset")!,
    !available(),
  );
  const skip = workspace.querySelector<HTMLButtonElement>("#skip")!;
  skip.hidden = s.timer?.phase !== "break";
  lockCommandControl(skip, !available() || s.status !== "running");
  setText(workspace.querySelector("#balance"), formatTime(s.balance_seconds));
  setText(workspace.querySelector("#focus-progress"), formatTime(progress(s)));
  setText(
    workspace.querySelector("#focus-total"),
    `/ ${formatTime(s.focus_seconds)}`,
  );
  setText(
    workspace.querySelector(".scope-note"),
    s.settings.focus_scope === "shared"
      ? "One focus target, shared across subjects."
      : "A separate focus target for each subject.",
  );
  lockCommandControl(
    workspace.querySelector<HTMLButtonElement>("#break-all")!,
    !available() || !canBreak,
  );
  lockCommandControl(
    workspace.querySelector<HTMLButtonElement>("#break-choose")!,
    !available() || !canBreak,
  );
  setMarkup(
    workspace.querySelector("#history-toggle")!,
    `${icon("history")}${historyVisible ? "Hide History" : "Show History"}`,
  );
  workspace.querySelector<HTMLElement>("#history-panel")!.hidden =
    compact || !historyVisible;
  if (historyVisible) renderHistory();
  syncDialogControls();
  renderPendingFeedback();
  updateCountdown();
}
function connectionName() {
  if (view.backend === "local") return view.initializing ? "Local setup" : "Local";
  return view.connection === "connected"
    ? "Connected"
    : view.connection === "connecting"
      ? "Connecting"
      : "Disconnected";
}
function commitDuration(i: number) {
  const input = document.querySelector<HTMLInputElement>(`#duration-${i}`);
  if (!input) return;
  const max = i === 0 ? 99 : 59;
  if (/^\d{1,2}$/.test(input.value) && Number(input.value) <= max)
    manual[i] = Number(input.value);
  input.value = String(manual[i]).padStart(2, "0");
  updateCountdown();
}
function setupSubjects() {
  const trigger = workspace.querySelector<HTMLButtonElement>("#subject")!;
  const popup = workspace.querySelector<HTMLDivElement>("#subject-popup")!;
  const menu = workspace.querySelector<HTMLDivElement>("#subject-menu")!;
  const remove = workspace.querySelector<HTMLButtonElement>("#context-delete")!;
  let contextName = "";
  let contextRow: HTMLButtonElement | null = null;
  trigger.addEventListener("click", () => {
    if (trigger.disabled) return;
    const rect = trigger.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 240))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 230))}px`;
    popup.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    popup.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  popup.addEventListener("toggle", () => {
    const open = popup.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) menu.hidden = true;
  });
  popup.addEventListener("click", (event) => {
    const row = (event.target as Element).closest<HTMLButtonElement>(
      ".subject-option",
    );
    if (!row || trigger.disabled) return;
    popup.hidePopover();
    trigger.focus();
    command({
      type: "select",
      mode: view.snapshot!.state.mode,
      subject: row.dataset.name!,
    });
  });
  popup.addEventListener("contextmenu", (event) => {
    const row = (event.target as Element).closest<HTMLButtonElement>(
      ".subject-option",
    );
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    contextName = row.dataset.name!;
    contextRow = row;
    remove.disabled = contextName === "Umum";
    menu.hidden = false;
    menu.style.top = `${Math.max(0, row.offsetTop - popup.scrollTop)}px`;
    menu.style.left = `${Math.min(popup.getBoundingClientRect().width - 155, 45)}px`;
    remove.focus();
  });
  remove.addEventListener("click", () => {
    if (contextName === "Umum" || trigger.disabled) return;
    popup.hidePopover();
    trigger.focus();
    deleteSubject(contextName);
  });
  popup.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      menu.hidden = true;
      contextRow?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = Array.from(
        popup.querySelectorAll<HTMLButtonElement>(".subject-option"),
      );
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[
        (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) %
          rows.length
      ]?.focus();
    }
  });
}
function setupDuration() {
  for (let i = 0; i < 3; i++) {
    const input = document.querySelector<HTMLInputElement>(`#duration-${i}`);
    if (!input) continue;
    input.addEventListener("input", () => {
      const max = i === 0 ? 99 : 59;
      if (/^\d{1,2}$/.test(input.value) && Number(input.value) <= max) {
        manual[i] = Number(input.value);
        updateCountdown();
      }
    });
    input.addEventListener("blur", () => commitDuration(i));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commitDuration(i);
        input.blur();
      }
    });
    const step = (delta: number) => {
      if (input.disabled) return;
      const max = i === 0 ? 100 : 60;
      manual[i] = (manual[i] + delta + max) % max;
      input.value = String(manual[i]).padStart(2, "0");
      updateCountdown();
    };
    input.addEventListener(
      "wheel",
      (e) => {
        if (!input.disabled) {
          e.preventDefault();
          step(e.deltaY > 0 ? 1 : -1);
        }
      },
      { passive: false },
    );
    const drag = workspace.querySelector<HTMLElement>(
      `.drag-label[data-index="${i}"]`,
    )!;
    let start: number | null = null;
    drag.addEventListener("pointerdown", (e) => {
      if (!input.disabled) {
        start = e.clientY;
        drag.setPointerCapture(e.pointerId);
      }
    });
    drag.addEventListener("pointermove", (e) => {
      if (start !== null) {
        const change = Math.trunc((start - e.clientY) / 12);
        if (change) {
          step(change);
          start = e.clientY;
        }
      }
    });
    drag.addEventListener("pointerup", () => {
      start = null;
    });
    drag.addEventListener("pointercancel", () => {
      start = null;
    });
  }
}
function primary() {
  if (!usable()) return;
  const s = view.snapshot!.state;
  const action: Record<Status, string> = {
    idle: "start",
    running: "pause",
    paused: "resume",
    choice: "continue_focus",
    alarm: "stop_alarm",
  };
  for (let i = 0; i < 3; i++) commitDuration(i);
  if (
    s.status === "idle" &&
    s.mode === "manual" &&
    manual.every((value) => value === 0)
  ) {
    showError("Enter a duration from 00:00:01 to 99:59:59.");
    return;
  }
  command(
    s.status === "idle"
      ? {
          type: "start",
          seconds: manual[0] * 3600 + manual[1] * 60 + manual[2],
        }
      : { type: action[s.status] },
  );
}
function chooseBreak() {
  const balance = view.snapshot!.state.balance_seconds;
  openDialog(
    "Choose your break",
    `<p class="muted">Available balance: ${formatTime(balance)}</p><form id="break-form"><div class="form-grid"><label>Hours<input id="break-hours" inputmode="numeric" type="number" min="0" max="99" value="0" required></label><label>Minutes<input id="break-minutes" inputmode="numeric" type="number" min="0" max="59" value="${Math.min(5, Math.floor(balance / 60))}" required></label><label>Seconds<input id="break-seconds" inputmode="numeric" type="number" min="0" max="59" value="${balance < 60 ? balance : 0}" required></label></div><button class="primary" type="submit">Start break</button></form>`,
  );
  document.querySelector("#break-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const seconds =
      Number(
        (document.querySelector("#break-hours") as HTMLInputElement).value,
      ) *
        3600 +
      Number(
        (document.querySelector("#break-minutes") as HTMLInputElement).value,
      ) *
        60 +
      Number(
        (document.querySelector("#break-seconds") as HTMLInputElement).value,
      );
    if (seconds < 1 || seconds > balance) {
      showError("Choose a positive duration within your balance.");
      return;
    }
    modal.close();
    command({ type: "start_break", seconds });
  });
}
function addSubject() {
  openDialog(
    "A new subject",
    '<form id="subject-form"><label>Subject name<input id="new-subject" maxlength="100" placeholder="What are you learning?" required autofocus></label><button class="primary" type="submit">Add subject</button></form>',
  );
  document.querySelector("#subject-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = (
      document.querySelector("#new-subject") as HTMLInputElement
    ).value.trim();
    if (!name) {
      showError("Enter a subject name.");
      return;
    }
    modal.close();
    command({ type: "add_subject", name });
  });
}
function deleteSubject(name: string) {
  openDialog(
    "Remove this subject?",
    `<p>Remove <strong>${escape(name)}</strong> from the list? Its history and saved progress will be kept.</p><div class="dialog-actions"><button class="secondary" id="cancel-delete">Cancel</button><button class="primary danger" id="confirm-delete">Remove subject</button></div>`,
  );
  document
    .querySelector("#cancel-delete")!
    .addEventListener("click", () => modal.close());
  document.querySelector("#confirm-delete")!.addEventListener("click", () => {
    modal.close();
    command({ type: "delete_subject", name });
  });
}
function applicationSettingsMarkup() {
  const next = view.next_backend ?? view.backend ?? "server";
  return `<div class="settings-section"><h3>Application</h3><p id="mode-status" class="muted">Active mode: ${view.backend === "local" ? "Local" : "Server"}</p><form id="application-preferences"><label>Connection mode<select id="backend-mode"><option value="local" ${next === "local" ? "selected" : ""}>Local - this laptop only</option><option value="server" ${next === "server" ? "selected" : ""}>Server - sync across devices</option></select></label><p class="hint">Local needs no separate server. Data stays separate. Changing mode applies after Quit and reopen; it does not stop a remote timer.</p><label>When closing the window<select id="close-behavior"><option value="tray" ${view.close_behavior !== "quit" ? "selected" : ""}>Minimize to tray - timer and alarm stay active</option><option value="quit" ${view.close_behavior === "quit" ? "selected" : ""}>Quit application</option></select></label><div class="dialog-actions"><button class="secondary" type="button" id="quit-application">Quit application</button><button class="primary" type="submit">Save application settings</button></div><p id="application-saved" role="status" class="hint"></p>${view.backup_path ? `<details><summary>Import backup</summary><p class="hint">${escape(view.backup_path)}</p></details>` : ""}</form></div>`;
}
function bindApplicationSettings() {
  document.querySelector("#quit-application")!.addEventListener("click", () => call("quit_application"));
  document.querySelector("#application-preferences")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await invoke("save_application_preferences", {
        backend: (document.querySelector("#backend-mode") as HTMLSelectElement).value,
        closeBehavior: (document.querySelector("#close-behavior") as HTMLSelectElement).value,
      });
      document.querySelector("#application-saved")!.textContent = "Saved. A mode change applies after Quit and reopen.";
    } catch (error) { showError(String(error)); }
  });
}
function openLocalSetup() {
  openDialog("Start your Local timer", `<div id="local-setup"><p>Keep your subject, history, break balance, and progress by importing the Pomo Restbank server data on this laptop.</p><p class="hint">Stop the source server first. A backup is created; server data is never deleted. The copied timer opens paused. Local and Server data stay separate.</p><div class="dialog-actions"><button class="secondary" id="cancel-local-setup">Cancel and quit</button><button class="secondary" id="fresh-local">Start fresh</button><button class="primary" id="import-local">Import existing data</button></div><p id="import-status" role="status"></p></div>`);
  let busy = false;
  const initialize = async (importData: boolean) => {
    if (busy) return;
    busy = true;
    const buttons = modalContent.querySelectorAll<HTMLButtonElement>("#local-setup button");
    buttons.forEach(button => button.disabled = true);
    document.querySelector("#import-status")!.textContent = importData ? "Creating backup and importing..." : "Creating Local data...";
    try { await invoke("initialize_local", { import: importData }); }
    catch (error) { showError(String(error)); document.querySelector("#import-status")!.textContent = "No existing data was replaced. Fix the issue and Retry."; document.querySelector("#import-local")!.textContent = "Retry import"; }
    finally { busy = false; buttons.forEach(button => button.disabled = false); }
  };
  document.querySelector("#cancel-local-setup")!.addEventListener("click", () => call("quit_application"));
  document.querySelector("#fresh-local")!.addEventListener("click", () => {
    initialize(false);
  });
  document.querySelector("#import-local")!.addEventListener("click", () => initialize(true));
}
function openSettings(connectionOnly = false) {
  settingsSaveRevision = null;
  const s = view.snapshot?.state;
  const editable = canEditSettings();
  openDialog(
    "Make it your space",
    `${applicationSettingsMarkup()}<div class="settings-section"><h3>Timer preferences</h3><div class="preferences-status"><p id="preferences-description" class="muted">${view.backend === "local" ? "Saved on this laptop." : "Shared with your other connected clients."}</p>${pendingFeedbackMarkup("retry-settings-pending")}</div><p id="preferences-hint" class="hint" ${editable ? "hidden" : ""}>Connect and finish or Reset the timer to edit preferences.</p><form id="preferences"><fieldset ${editable ? "" : "disabled"}><label>Focus progress<select id="scope"><option value="shared" ${s?.settings.focus_scope !== "per_subject" ? "selected" : ""}>Shared across subjects</option><option value="per_subject" ${s?.settings.focus_scope === "per_subject" ? "selected" : ""}>Per subject</option></select></label><label class="check-row"><input id="tick-sound" type="checkbox" ${s?.settings.tick_sound ? "checked" : ""}>Tick every second</label><label>Tick volume <output id="volume-output">${s?.settings.tick_volume ?? 100}%</output><input id="tick-volume" type="range" min="0" max="400" step="1" value="${s?.settings.tick_volume ?? 100}"></label><p class="hint">100% is the original volume. This does not change the alarm.</p></fieldset><div class="dialog-actions"><button type="button" id="cancel-preferences" class="secondary">Cancel</button><button type="submit" class="primary" ${editable ? "" : "disabled"}>Save preferences</button></div></form></div><div class="settings-section" ${view.backend === "local" ? "hidden" : ""}><h3>Your sync connection</h3><p class="muted">One timer. Every connected window.</p><form id="connection-form"><label>Server address<input id="endpoint" value="${escape(view.endpoint)}" spellcheck="false" placeholder="ws://127.0.0.1:4317/v1/ws" required></label><label>Access token<input id="token" type="password" autocomplete="off" placeholder="${view.has_token ? "Saved — leave blank to keep" : "Paste the token from your server"}"></label><p class="hint">Controls need a connection. Closing this window leaves the server timer running.</p><button type="submit" class="secondary" ${view.pending ? "disabled" : ""}>Save and connect</button></form></div>`,
  );
  document
    .querySelector("#cancel-preferences")!
    .addEventListener("click", () => modal.close());
  document.querySelector("#tick-volume")!.addEventListener("input", (e) => {
    document.querySelector("#volume-output")!.textContent =
      `${(e.target as HTMLInputElement).value}%`;
  });
  document
    .querySelector("#preferences")!
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!canEditSettings()) {
        syncDialogControls();
        return;
      }
      clearDialogError();
      const scope = (document.querySelector("#scope") as HTMLSelectElement)
        .value;
      const tick = (document.querySelector("#tick-sound") as HTMLInputElement)
        .checked;
      const volume = Number(
        (document.querySelector("#tick-volume") as HTMLInputElement).value,
      );
      settingsSaveRevision = view.snapshot!.state.revision;
      if (
        !(await command({
          type: "save_settings",
          focus_scope: scope,
          tick_sound: tick,
          tick_volume: volume,
        }))
      )
        settingsSaveRevision = null;
    });
  document
    .querySelector("#connection-form")!
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await invoke("connect_server", {
          endpoint: (
            document.querySelector("#endpoint") as HTMLInputElement
          ).value.trim(),
          token: (document.querySelector("#token") as HTMLInputElement).value,
        });
        modal.close();
      } catch (error) {
        showError(String(error));
      }
    });
  modalContent
    .querySelector("#retry-settings-pending")!
    .addEventListener("click", () => call("retry_pending"));
  syncDialogControls();
  renderPendingFeedback();
  bindApplicationSettings();
  if (connectionOnly && view.backend !== "local")
    document.querySelector<HTMLInputElement>("#endpoint")!.focus();
}
async function loadHistory() {
  await call("request_history");
}
function renderHistory() {
  const panel = document.querySelector("#history-panel");
  if (!panel) return;
  if (!panel.querySelector("#history-list")) {
    panel.innerHTML = `<div class="history-heading"><div><span class="eyebrow">A LITTLE PROGRESS, EVERY DAY</span><h2>Your focus, remembered</h2></div><button id="refresh-history" class="icon-button" aria-label="Refresh history">${icon("reset")}</button></div><div class="history-tabs"><button data-tab="recent" class="${historyTab === "recent" ? "active" : ""}">Recent sessions</button><button data-tab="summary" class="${historyTab === "summary" ? "active" : ""}">By subject</button></div><div id="history-list"></div>`;
    panel
      .querySelectorAll<HTMLButtonElement>("[data-tab]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          historyTab = button.dataset.tab!;
          renderHistory();
        });
      });
    panel
      .querySelector("#refresh-history")!
      .addEventListener("click", loadHistory);
  }
  if (
    renderedHistory === history &&
    renderedHistoryTab === historyTab &&
    renderedHistoryConnected === connected()
  )
    return;
  renderedHistory = history;
  renderedHistoryTab = historyTab;
  renderedHistoryConnected = connected();
  panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === historyTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const list = panel.querySelector("#history-list")!;
  if (!connected())
    list.innerHTML =
      '<p class="empty-state">Reconnect to load your history.</p>';
  else if (!history)
    list.innerHTML = '<p class="empty-state">Loading your sessions…</p>';
  else if (historyTab === "recent")
    list.innerHTML = history.sessions.length
      ? history.sessions
          .map(
            (s) =>
              `<div class="history-row"><span class="session-icon">${icon("clock")}</span><div><strong>${escape(s.subject)}</strong><span>${escape(historyDateFormat.format(new Date(s.recorded_at)))} · ${s.mode === "manual" ? "Manual" : "Pomodoro"}</span></div><strong>${duration(s.duration_seconds)}</strong></div>`,
          )
          .join("")
      : '<p class="empty-state">Your first session starts a story.<br>Finish a timer to see it here.</p>';
  else
    list.innerHTML = history.summary.length
      ? history.summary
          .map(
            (s) =>
              `<div class="history-row"><span class="session-icon">${icon("target")}</span><div><strong>${escape(s.subject)}</strong><span>${s.count} ${s.count === 1 ? "session" : "sessions"}</span></div><strong>${duration(s.duration_seconds)}</strong></div>`,
          )
          .join("")
      : '<p class="empty-state">No sessions yet.</p>';
}
function updateCountdown() {
  const s = view.snapshot?.state;
  if (!s) return;
  const elapsed =
    s.status === "running"
      ? Math.floor((performance.now() - snapshotArrived) / 1000)
      : 0;
  const remaining = s.timer
    ? Math.max(0, s.timer.remaining_seconds - elapsed)
    : s.mode === "manual"
      ? manual[0] * 3600 + manual[1] * 60 + manual[2]
      : s.focus_seconds - progress(s);
  const countdown = document.querySelector("#countdown");
  setText(countdown, formatTime(remaining));
  const ring = workspace.querySelector<SVGCircleElement>(".ring-fill");
  if (ring) {
    const fraction = s.timer
      ? 1 - remaining / s.timer.total_seconds
      : s.mode === "pomodoro"
        ? progress(s) / s.focus_seconds
        : 0;
    const offset = String(860.8 * (1 - Math.max(0, Math.min(1, fraction))));
    if (ring.style.strokeDashoffset !== offset)
      ring.style.strokeDashoffset = offset;
  }
  const estimate = document.querySelector("#estimate");
  if (estimate)
    estimate.textContent = !connected()
      ? remaining === 0
        ? view.backend === "local" ? "Waiting for timer" : "Waiting for server"
        : "Estimated · waiting for server"
      : s.status === "running" && (remaining === 0 || elapsed > 2)
        ? view.backend === "local" ? "Waiting for timer" : "Waiting for server"
        : "\u00a0";
}
document.addEventListener("keydown", (e) => {
  if (
    e.code !== "Space" ||
    modal.open ||
    (e.target instanceof Element &&
      e.target.closest("input,textarea,select,button,a,[contenteditable]"))
  )
    return;
  e.preventDefault();
  if (spaceHeld || e.repeat) return;
  spaceHeld = true;
  if (
    usable() &&
    ["running", "paused"].includes(view.snapshot?.state.status ?? "")
  )
    primary();
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceHeld = false;
});
window.addEventListener("blur", () => {
  spaceHeld = false;
});
function applyView(next: View) {
  const key = next.snapshot
    ? `${next.snapshot.state.revision}:${next.snapshot.state.tick_sequence}:${next.snapshot.server_time_ms}`
    : "";
  if (key !== lastSnapshotKey) {
    snapshotArrived = performance.now();
    lastSnapshotKey = key;
  }
  const changed = next.snapshot?.state.revision !== lastViewRevision;
  const reconnected = next.connection === "connected" && !connected();
  const serverChanged = next.endpoint !== view.endpoint;
  const previousError = view.error;
  if (serverChanged) history = null;
  lastViewRevision = next.snapshot?.state.revision;
  view = next;
  syncPendingFeedback();
  render();
  if (view.initializing && !modal.open) openLocalSetup();
  if (!view.initializing && modalContent.querySelector("#local-setup")) modal.close();
  if (
    modal.open &&
    settingsSaveRevision !== null &&
    !view.pending &&
    view.snapshot &&
    view.snapshot.state.revision > settingsSaveRevision
  ) {
    if (!view.error) modal.close();
    settingsSaveRevision = null;
  }
  if (
    historyVisible &&
    (changed || reconnected || serverChanged) &&
    connected()
  )
    loadHistory();
  if (modal.open && view.error && view.error !== previousError)
    document.querySelector("#dialog-error")!.textContent = view.error;
}
async function boot() {
  await listen<View>("restbank:view", (event) => applyView(event.payload));
  await listen<History>("restbank:history", (event) => {
    history = event.payload;
    if (historyVisible) renderHistory();
  });
  const initial = await call<View>("get_view");
  if (initial) applyView(initial);
  else render();
}
setInterval(updateCountdown, 200);
boot();
