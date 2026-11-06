import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
type View = {
  snapshot: Snapshot | null;
  connection: string;
  endpoint: string;
  has_token: boolean;
  pending: string | null;
  error: string | null;
  profile: string;
  preview: boolean;
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
let historyTab = "recent";
let localError: string | null = null;
let manual = [0, 0, 0];
let snapshotArrived = performance.now();
let lastSnapshotKey = "";
let spaceHeld = false;
let dialogReturnFocus: HTMLElement | null = null;
let settingsSaveRevision: number | null = null;
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<header class="topbar"><a class="brand" href="#" aria-label="Pomo Restbank home"><span class="brandmark">${icon("cup")}</span><span>Pomo <strong>Restbank</strong></span></a><div class="header-actions"><button class="icon-button" id="theme" aria-label="Toggle color theme">${icon("sun")}</button><button class="icon-button" id="settings" aria-label="Open settings">${icon("settings")}</button></div></header><main><div id="banner" role="status" aria-live="polite"></div><div id="workspace"></div></main><footer><span>Build focus. Bank your breaks.</span><span id="profile-label"></span></footer><dialog id="modal"><div id="modal-content"></div></dialog>`;
const workspace = document.querySelector<HTMLDivElement>("#workspace")!;
const modal = document.querySelector<HTMLDialogElement>("#modal")!;
const modalContent = document.querySelector<HTMLDivElement>("#modal-content")!;
let theme =
  localStorage.getItem("restbank:theme") ??
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = theme;
document.querySelector("#theme")!.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("restbank:theme", theme);
});
document
  .querySelector("#settings")!
  .addEventListener("click", () => openSettings());
document
  .querySelector(".brand")!
  .addEventListener("click", (e) => e.preventDefault());
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.close();
});
modal.addEventListener("close", () => dialogReturnFocus?.focus());
function openDialog(title: string, content: string) {
  dialogReturnFocus = document.activeElement as HTMLElement;
  modalContent.innerHTML = `<div class="dialog-heading"><h2>${title}</h2><button class="icon-button close-modal" aria-label="Close dialog">${icon("close")}</button></div>${content}<p id="dialog-error" role="alert" class="error-text"></p>`;
  modalContent
    .querySelector(".close-modal")!
    .addEventListener("click", () => modal.close());
  if (!modal.open) modal.showModal();
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
  localError = null;
  try {
    await invoke("send_command", { command: cmd });
    return true;
  } catch (error) {
    showError(String(error));
    return false;
  }
}
function connected() {
  return view.connection === "connected";
}
function usable() {
  return connected() && !view.pending && !view.snapshot?.storage_error;
}
function renderBanner() {
  const banner = document.querySelector<HTMLDivElement>("#banner")!;
  const error = localError ?? view.error ?? view.snapshot?.storage_error;
  banner.innerHTML = `${view.preview ? '<div class="notice preview">TEST MODE · Short sessions · Separate data</div>' : ""}${error ? `<div class="notice error">${escape(error)}</div>` : ""}${view.pending ? `<div class="notice">A command is waiting for confirmation. <button class="text-button" id="retry-pending" ${connected() ? "" : "disabled"}>Retry same command</button></div>` : ""}${view.snapshot?.storage_error ? '<button id="retry-storage" class="secondary">Retry storage</button>' : ""}`;
  banner
    .querySelector("#retry-pending")
    ?.addEventListener("click", () => call("retry_pending"));
  banner
    .querySelector("#retry-storage")
    ?.addEventListener("click", () => command({ type: "retry_storage" }));
}
function progress(s: State) {
  const t = s.timer?.phase === "focus" ? s.timer : s.timer?.suspended_focus;
  if (t && t.remaining_seconds > 0)
    return s.focus_seconds - t.remaining_seconds;
  return s.settings.focus_scope === "shared"
    ? s.shared_progress
    : (s.per_subject_progress[s.subject] ?? 0);
}
function render() {
  renderBanner();
  document.querySelector("#profile-label")!.textContent =
    `Profile: ${view.profile}`;
  const s = view.snapshot?.state;
  const idle = s?.status === "idle";
  const disabled = !usable();
  const settingsDisabled = disabled || !idle;
  const statusName =
    view.connection === "connected"
      ? "Connected"
      : view.connection === "connecting"
        ? "Connecting"
        : "Disconnected";
  if (!s) {
    workspace.innerHTML = `<section class="welcome panel"><span class="eyebrow">YOUR SPACE TO FOCUS</span><div class="welcome-icon">${icon("cup")}</div><h1>A little focus.<br>A well-earned break.</h1><p>Connect to your Restbank server to start a shared timer and keep your progress together.</p><button id="setup" class="primary">${icon("link")}Connect your timer</button><span class="connection ${view.connection}"><i></i>${statusName}</span></section>`;
    workspace
      .querySelector("#setup")!
      .addEventListener("click", () => openSettings(true));
    return;
  }
  const canBreak =
    s.mode === "pomodoro" &&
    s.balance_seconds > 0 &&
    (idle ||
      s.status === "choice" ||
      (s.status === "paused" && s.timer?.phase === "focus"));
  const remaining =
    s.timer?.remaining_seconds ??
    (s.mode === "manual"
      ? manual[0] * 3600 + manual[1] * 60 + manual[2]
      : s.focus_seconds - progress(s));
  const focusProgress = progress(s);
  const ring = s.timer
    ? 1 - remaining / s.timer.total_seconds
    : s.mode === "pomodoro"
      ? focusProgress / s.focus_seconds
      : 0;
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
    s.status === "alarm"
      ? "Stop Alarm"
      : s.status === "choice"
        ? "Continue Focus"
        : s.status === "running"
          ? "Pause"
          : s.status === "paused"
            ? "Resume"
            : "Start focus";
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
  workspace.innerHTML = `<section class="timer-panel panel"><div class="section-top"><span class="eyebrow">${escape(title)}</span><button id="connection-status" class="connection ${view.connection}" title="Connection settings"><i></i>${statusName}</button></div><div class="mode-tabs" role="group" aria-label="Timer mode"><button data-mode="manual" class="${s.mode === "manual" ? "selected" : ""}" ${settingsDisabled ? "disabled" : ""}>Manual</button><button data-mode="pomodoro" class="${s.mode === "pomodoro" ? "selected" : ""}" ${settingsDisabled ? "disabled" : ""}>Pomodoro</button></div><div class="subject-row"><label for="subject">I'm focusing on</label><div class="subject-controls"><button id="subject" class="subject-picker" aria-haspopup="listbox" aria-expanded="false" ${settingsDisabled ? "disabled" : ""}>${escape(s.subject)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><div id="subject-popup" class="subject-popup" popover="auto" role="listbox" aria-label="Study subjects">${s.subjects.map((n) => `<button class="subject-option" role="option" aria-selected="${n === s.subject}" data-name="${escape(n)}">${escape(n)}</button>`).join("")}<div id="subject-menu" class="subject-context" role="menu" hidden><button role="menuitem" id="context-delete">Remove subject</button></div></div><button id="add-subject" class="icon-button small" aria-label="Add subject" ${settingsDisabled ? "disabled" : ""}>${icon("plus")}</button><button id="delete-subject" class="icon-button small" aria-label="Delete selected subject" ${settingsDisabled || s.subject === "Umum" ? "disabled" : ""}>${icon("trash")}</button></div></div><div class="timer-face"><svg class="progress-ring" viewBox="0 0 300 300" aria-hidden="true"><circle class="ring-track" cx="150" cy="150" r="137"/><circle class="ring-fill" cx="150" cy="150" r="137" style="stroke-dasharray:860.8;stroke-dashoffset:${860.8 * (1 - Math.max(0, Math.min(1, ring)))}"/></svg><div class="timer-content">${icon(s.timer?.phase === "break" ? "cup" : "clock")}<div id="countdown" class="countdown" aria-label="Time remaining">${formatTime(remaining)}</div><span class="timer-caption">${caption}</span><span id="estimate" class="estimate">${connected() ? "&nbsp;" : "Estimated · waiting for server"}</span></div></div>${s.mode === "manual" ? `<div class="duration-fields" aria-label="Manual duration">${["Hours", "Minutes", "Seconds"].map((name, i) => `<label><span class="drag-label" data-index="${i}">${name}</span><input id="duration-${i}" aria-label="${name}" inputmode="numeric" maxlength="2" value="${String(manual[i]).padStart(2, "0")}" ${settingsDisabled ? "disabled" : ""}></label>`).join('<span class="colon">:</span>')}</div>` : ""}<div class="timer-actions"><button id="primary" class="primary" ${disabled ? "disabled" : ""}>${icon(s.status === "running" ? "pause" : s.status === "alarm" ? "clock" : "play")}${s.mode === "manual" && idle ? "Start timer" : label}</button><button id="reset" class="secondary" ${disabled ? "disabled" : ""}>${icon("reset")}Reset</button></div>${s.timer?.phase === "break" ? `<button id="skip" class="text-button" ${disabled || s.status !== "running" ? "disabled" : ""}>Skip break</button>` : ""}<div class="stat-grid"><div class="stat-card"><span class="stat-icon">${icon("cup")}</span><div><span class="stat-label">Break balance</span><strong>${formatTime(s.balance_seconds)}</strong></div></div><div class="stat-card"><span class="stat-icon">${icon("target")}</span><div><span class="stat-label">Focus target</span><strong>${formatTime(focusProgress)} <small>/ ${formatTime(s.focus_seconds)}</small></strong></div></div></div><p class="scope-note">${s.settings.focus_scope === "shared" ? "One focus target, shared across subjects." : "A separate focus target for each subject."}</p><div class="break-actions"><button id="break-all" class="secondary" ${!canBreak || disabled ? "disabled" : ""}>${icon("cup")}Use break balance</button><button id="break-choose" class="text-button" ${!canBreak || disabled ? "disabled" : ""}>Choose duration</button></div><div class="panel-bottom"><button id="history-toggle" class="text-button">${icon("history")}${historyVisible ? "Hide History" : "Show History"}</button><button id="timer-settings" class="text-button">${icon("settings")}Settings</button></div></section><section id="history-panel" class="panel history-panel" ${historyVisible ? "" : "hidden"}></section>`;
  workspace
    .querySelector("#connection-status")!
    .addEventListener("click", () => openSettings(true));
  workspace
    .querySelector("#timer-settings")!
    .addEventListener("click", () => openSettings());
  workspace
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        command({ type: "select", mode: b.dataset.mode!, subject: s.subject }),
      ),
    );
  setupSubjects(s, settingsDisabled);
  workspace.querySelector("#primary")!.addEventListener("click", primary);
  workspace.querySelector("#reset")!.addEventListener("click", () => {
    manual = [0, 0, 0];
    command({ type: "reset" });
  });
  workspace
    .querySelector("#skip")
    ?.addEventListener("click", () => command({ type: "skip_break" }));
  workspace
    .querySelector("#break-all")!
    .addEventListener("click", () =>
      command({
        type: "start_break",
        seconds: Math.min(s.balance_seconds, 4294967295),
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
    .addEventListener("click", () => deleteSubject(s.subject));

  workspace.querySelector("#history-toggle")!.addEventListener("click", () => {
    historyVisible = !historyVisible;
    render();
    if (historyVisible) loadHistory();
  });
  setupDuration();
  if (historyVisible) renderHistory();
  updateCountdown();
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
function setupSubjects(s: State, disabled: boolean) {
  const trigger = document.querySelector<HTMLButtonElement>("#subject")!;
  const popup = document.querySelector<HTMLDivElement>("#subject-popup")!;
  const menu = document.querySelector<HTMLDivElement>("#subject-menu")!;
  const remove = document.querySelector<HTMLButtonElement>("#context-delete")!;
  let contextName = "";
  let contextRow: HTMLButtonElement | null = null;
  trigger.addEventListener("click", () => {
    if (disabled) return;
    const rect = trigger.getBoundingClientRect();
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
    popup.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 230)}px`;
    popup.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    popup.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  popup.addEventListener("toggle", () => {
    const open = popup.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) menu.hidden = true;
  });
  const rows = Array.from(
    popup.querySelectorAll<HTMLButtonElement>(".subject-option"),
  );
  rows.forEach((row) => {
    row.addEventListener("click", () => {
      popup.hidePopover();
      command({ type: "select", mode: s.mode, subject: row.dataset.name! });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextName = row.dataset.name!;
      contextRow = row;
      remove.disabled = contextName === "Umum";
      menu.hidden = false;
      const bounds = popup.getBoundingClientRect();
      menu.style.top = `${Math.max(0, row.offsetTop - row.parentElement!.scrollTop)}px`;
      menu.style.left = `${Math.min(bounds.width - 155, 45)}px`;
      remove.focus();
    });
  });
  remove.addEventListener("click", () => {
    if (contextName === "Umum") return;
    popup.hidePopover();
    deleteSubject(contextName);
  });
  popup.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      menu.hidden = true;
      contextRow?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[
        (index + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length
      ]?.focus();
    }
  });
}
function setupDuration() {
  for (let i = 0; i < 3; i++) {
    const input = document.querySelector<HTMLInputElement>(`#duration-${i}`);
    if (!input) continue;
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
function openSettings(connectionOnly = false) {
  settingsSaveRevision = null;
  const s = view.snapshot?.state;
  const editable = usable() && s?.status === "idle";
  openDialog(
    "Make it your space",
    `<div class="settings-section"><h3>Timer preferences</h3><p class="muted">Shared with your other connected clients.</p>${!editable ? '<p class="hint">Connect and finish or Reset the timer to edit preferences.</p>' : ""}<form id="preferences"><fieldset ${editable ? "" : "disabled"}><label>Focus progress<select id="scope"><option value="shared" ${s?.settings.focus_scope !== "per_subject" ? "selected" : ""}>Shared across subjects</option><option value="per_subject" ${s?.settings.focus_scope === "per_subject" ? "selected" : ""}>Per subject</option></select></label><label class="check-row"><input id="tick-sound" type="checkbox" ${s?.settings.tick_sound ? "checked" : ""}>Tick every second</label><label>Tick volume <output id="volume-output">${s?.settings.tick_volume ?? 100}%</output><input id="tick-volume" type="range" min="0" max="400" step="1" value="${s?.settings.tick_volume ?? 100}"></label><p class="hint">100% is the original volume. This does not change the alarm.</p></fieldset><div class="dialog-actions"><button type="button" id="cancel-preferences" class="secondary">Cancel</button><button type="submit" class="primary" ${editable ? "" : "disabled"}>Save preferences</button></div></form></div><div class="settings-section"><h3>Your sync connection</h3><p class="muted">One timer. Every connected window.</p><form id="connection-form"><label>Server address<input id="endpoint" value="${escape(view.endpoint)}" spellcheck="false" placeholder="ws://127.0.0.1:4317/v1/ws" required></label><label>Access token<input id="token" type="password" autocomplete="off" placeholder="${view.has_token ? "Saved — leave blank to keep" : "Paste the token from your server"}"></label><p class="hint">Controls need a connection. Closing this window leaves the server timer running.</p><button type="submit" class="secondary" ${view.pending ? "disabled" : ""}>Save and connect</button></form></div>`,
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
      if (!editable) return;
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
  if (connectionOnly)
    document.querySelector<HTMLInputElement>("#endpoint")!.focus();
}
async function loadHistory() {
  await call("request_history");
}
function renderHistory() {
  const panel = document.querySelector("#history-panel");
  if (!panel) return;
  panel.innerHTML = `<div class="history-heading"><div><span class="eyebrow">A LITTLE PROGRESS, EVERY DAY</span><h2>Your focus, remembered</h2></div><button id="refresh-history" class="icon-button" aria-label="Refresh history">${icon("reset")}</button></div><div class="history-tabs"><button data-tab="recent" class="${historyTab === "recent" ? "active" : ""}">Recent sessions</button><button data-tab="summary" class="${historyTab === "summary" ? "active" : ""}">By subject</button></div><div id="history-list"></div>`;
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
              `<div class="history-row"><span class="session-icon">${icon("clock")}</span><div><strong>${escape(s.subject)}</strong><span>${escape(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(s.recorded_at)))} · ${s.mode === "manual" ? "Manual" : "Pomodoro"}</span></div><strong>${duration(s.duration_seconds)}</strong></div>`,
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
  panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      historyTab = b.dataset.tab!;
      renderHistory();
    }),
  );
  panel
    .querySelector("#refresh-history")!
    .addEventListener("click", loadHistory);
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
  if (countdown) countdown.textContent = formatTime(remaining);
  const estimate = document.querySelector("#estimate");
  if (estimate)
    estimate.textContent = !connected()
      ? remaining === 0
        ? "Waiting for server"
        : "Estimated · waiting for server"
      : elapsed > 2
        ? "Waiting for server"
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
  const changed =
    next.snapshot?.state.revision !== view.snapshot?.state.revision;
  view = next;
  render();
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
  if (historyVisible && changed && connected()) loadHistory();
  if (modal.open && view.error)
    document.querySelector("#dialog-error")!.textContent = view.error;
  if (
    modal.open &&
    !view.pending &&
    !view.error &&
    view.snapshot?.state.status === "idle"
  ) {
    // Keep Settings open so a failed save never discards pending choices.
    const output = document.querySelector("#dialog-error");
    if (output) output.textContent = "";
  }
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
