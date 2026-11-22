import type { State, Status, View } from "../../ipc-types";
import { pendingFeedbackMarkup, type Commands } from "../commands";
import type { CompactLayout } from "../compact-layout";
import type { Dialog } from "../dialog";
import { setMarkup, setText } from "../dom";
import { icon } from "../markup";
import { createSubjects } from "./subjects";
import { createTimer, formatTime } from "./timer";
import { workspaceMarkup } from "./workspace-markup";

const primaryLabel: Record<Status, string> = {
  idle: "Start focus",
  running: "Pause",
  paused: "Resume",
  choice: "Continue Focus",
  alarm: "Stop Alarm",
};

type WorkspaceOptions = {
  workspace: HTMLElement;
  getView: () => View;
  commands: Commands;
  dialog: Dialog;
  layout: CompactLayout;
  openSetup: () => void;
  openConnectionSettings: () => void;
  toggleHistory: () => void;
  openFullHistory: () => void;
  showError: (error: string) => void;
};

export function createWorkspace({
  workspace,
  getView,
  commands,
  dialog,
  layout,
  openSetup,
  openConnectionSettings,
  toggleHistory,
  openFullHistory,
  showError,
}: WorkspaceOptions) {
  const getState = () => getView().snapshot!.state;
  const subjects = createSubjects(workspace, getState, commands, dialog);
  const timer = createTimer({
    workspace,
    getView,
    commands,
    dialogOpen: () => dialog.element.open,
    showError,
  });

  function build() {
    workspace.innerHTML = workspaceMarkup(timer.manual, pendingFeedbackMarkup("retry-pending"));
    workspace.querySelector("#connection-status")!.addEventListener("click", openConnectionSettings);
    workspace.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        void commands.send({
          type: "select",
          mode: button.dataset.mode!,
          subject: getState().subject,
        });
      });
    });
    workspace.querySelector("#retry-pending")!.addEventListener("click", commands.retry);
    workspace.querySelector("#compact-detail-toggle")!.addEventListener("click", () => {
      void layout.change(true, !layout.details);
    });
    workspace.querySelector("#compact-history")!.addEventListener("click", openFullHistory);
    workspace.querySelector("#history-toggle")!.addEventListener("click", toggleHistory);
    workspace.querySelector("#skip")!.addEventListener("click", () => {
      void commands.send({ type: "skip_break" });
    });

    const contribution = workspace.querySelector<HTMLInputElement>("#manual-counts")!;
    contribution.addEventListener("change", () => {
      const state = getState();
      const selected = contribution.checked;
      contribution.checked = !!state.settings.manual_counts_toward_pomodoro;
      if (!commands.usable() || state.status !== "idle" || state.mode !== "manual") return;
      void commands.send({
        type: "save_settings",
        ...state.settings,
        manual_counts_toward_pomodoro: selected,
      });
    });

    bindBreakControls();
    subjects.bind();
    timer.bind();
  }

  function bindBreakControls() {
    const menu = workspace.querySelector<HTMLElement>("#balance-menu")!;
    const toggle = workspace.querySelector("#balance-toggle")!;
    menu.addEventListener("toggle", () => {
      toggle.setAttribute("aria-expanded", String(menu.matches(":popover-open")));
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : buttons.length - 1;
      buttons[(index + step) % buttons.length]?.focus();
    });
    menu.addEventListener("click", (event) => {
      if ((event.target as Element).closest("button")) menu.hidePopover();
    });
    workspace.querySelector("#break-all")!.addEventListener("click", () => {
      void commands.send({
        type: "start_break",
        seconds: Math.min(getState().balance_seconds, 4294967295),
      });
    });
    workspace.querySelector("#break-choose")!.addEventListener("click", chooseBreak);
  }

  function chooseBreak() {
    const balance = getState().balance_seconds;
    dialog.open("Choose your break", `
      <p class="muted">Available balance: ${formatTime(balance)}</p>
      <form id="break-form">
        <div class="form-grid">
          <label>
            Hours
            <input id="break-hours" inputmode="numeric" type="number" min="0" max="99" value="0" required>
          </label>
          <label>
            Minutes
            <input id="break-minutes" inputmode="numeric" type="number" min="0" max="59"
                   value="${Math.min(5, Math.floor(balance / 60))}" required>
          </label>
          <label>
            Seconds
            <input id="break-seconds" inputmode="numeric" type="number" min="0" max="59"
                   value="${balance < 60 ? balance : 0}" required>
          </label>
        </div>
        <button class="primary" type="submit">Start break</button>
      </form>
    `);
    const form = dialog.content.querySelector("#break-form")!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const hours = form.querySelector<HTMLInputElement>("#break-hours")!.value;
      const minutes = form.querySelector<HTMLInputElement>("#break-minutes")!.value;
      const seconds = form.querySelector<HTMLInputElement>("#break-seconds")!.value;
      const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
      if (total < 1 || total > balance) {
        dialog.setError("Choose a positive duration within your balance.");
        return;
      }
      dialog.close();
      void commands.send({ type: "start_break", seconds: total });
    });
  }

  function renderWelcome(view: View) {
    if (!workspace.querySelector("#setup")) {
      const local = view.backend === "local";
      const copy = local
        ? "Choose how to start your Local timer. Your server data stays separate."
        : "Connect to your Restbank server to start a shared timer and keep your progress together.";
      workspace.innerHTML = `
        <section class="welcome panel">
          <span class="eyebrow">YOUR SPACE TO FOCUS</span>
          <div class="welcome-icon">${icon("cup")}</div>
          <h1>A little focus.<br>A well-earned break.</h1>
          <p>${copy}</p>
          <button id="setup" class="primary">
            ${icon("link")}${local ? "Set up Local mode" : "Connect your timer"}
          </button>
          <span class="connection"></span>
        </section>
      `;
      workspace.querySelector("#setup")!.addEventListener("click", openSetup);
    }
    const connection = workspace.querySelector(".connection")!;
    connection.className = `connection ${view.connection}`;
    setMarkup(connection, `<i></i>${connectionName(view)}`);
  }

  function renderBreakControls(state: State) {
    const canBreak = state.mode === "pomodoro" && state.balance_seconds > 0 &&
      (state.status === "idle" || state.status === "choice" ||
        (state.status === "paused" && state.timer?.phase === "focus"));
    const unavailable = !commands.available() || !canBreak;
    const balance = formatTime(state.balance_seconds);
    setText(workspace.querySelector("#balance-value"), balance);
    setText(workspace.querySelector("#compact-balance"), balance);
    const toggle = workspace.querySelector<HTMLButtonElement>("#balance-toggle")!;
    commands.lockControl(toggle, unavailable);
    if (toggle.disabled) workspace.querySelector<HTMLElement>("#balance-menu")!.hidePopover();

    const useAll = workspace.querySelector<HTMLButtonElement>("#break-all")!;
    const label = layout.compact ? "Use break balance" : `<span>Use all · ${balance}</span>`;
    setMarkup(useAll, `${icon("cup")}${label}`);
    commands.lockControl(useAll, unavailable);
    commands.lockControl(workspace.querySelector<HTMLButtonElement>("#break-choose")!, unavailable);
  }

  function render(historyVisible: boolean) {
    const view = getView();
    const state = view.snapshot?.state;
    if (!state) {
      renderWelcome(view);
      return;
    }
    if (!workspace.querySelector("#primary")) build();

    const { mode, status } = state;
    const idle = status === "idle";
    const manual = mode === "manual";
    const onBreak = state.timer?.phase === "break";
    const unavailable = !commands.available();
    const editingUnavailable = unavailable || !idle;
    const counts = state.timer?.counts_toward_pomodoro ?? state.settings.manual_counts_toward_pomodoro;

    const title = status === "alarm" ? "Time to take a breath"
      : status === "choice" ? "A focus session, well spent"
      : onBreak ? "Make room to recharge"
      : status === "paused" ? "Ready when you are"
      : "One thing at a time";
    const caption = status === "alarm" ? "Session complete"
      : status === "choice" ? "Choose your next step"
      : status === "paused" ? "Paused"
      : onBreak ? "Resting"
      : manual ? "Manual session"
      : `Focus session ${state.cycle_position + 1} of 4`;
    setText(workspace.querySelector(".section-top .eyebrow"), title);
    setText(workspace.querySelector(".timer-caption"), caption);
    setMarkup(workspace.querySelector(".phase-icon")!, icon(onBreak ? "cup" : "clock"));
    renderCompactSummary(state, Boolean(counts));
    layout.renderDetails();

    const connection = workspace.querySelector<HTMLButtonElement>("#connection-status")!;
    connection.className = `connection ${view.connection}`;
    setText(connection.querySelector("span"), connectionName(view));
    workspace.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      const selected = button.dataset.mode === mode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      commands.lockControl(button, editingUnavailable);
    });
    subjects.render(state);

    workspace.querySelector<HTMLElement>(".duration-fields")!.hidden = !manual;
    workspace.querySelectorAll<HTMLInputElement>(".duration-fields input").forEach((input) => {
      commands.lockControl(input, editingUnavailable);
    });
    workspace.querySelector<HTMLElement>("#manual-contribution")!.hidden = !manual;
    const contribution = workspace.querySelector<HTMLInputElement>("#manual-counts")!;
    contribution.checked = !!counts;
    commands.lockControl(contribution, editingUnavailable);

    const primary = workspace.querySelector<HTMLButtonElement>("#primary")!;
    const actionIcon = status === "running" ? "pause" : status === "alarm" ? "clock" : "play";
    const label = manual && idle ? "Start timer" : primaryLabel[status];
    setMarkup(primary, `${icon(actionIcon)}${label}`);
    commands.lockControl(primary, unavailable);
    commands.lockControl(workspace.querySelector<HTMLButtonElement>("#reset")!, unavailable);
    const skip = workspace.querySelector<HTMLButtonElement>("#skip")!;
    skip.hidden = !onBreak;
    commands.lockControl(skip, unavailable || status !== "running");
    renderBreakControls(state);

    const historyLabel = historyVisible ? "Hide History" : "Show History";
    setMarkup(workspace.querySelector("#history-toggle")!, `${icon("history")}${historyLabel}`);
    workspace.querySelector<HTMLElement>("#history-panel")!.hidden = layout.compact || !historyVisible;
  }

  function renderCompactSummary(state: State, counts: boolean) {
    const manual = state.mode === "manual";
    const phase = state.timer?.phase === "break" ? "Break" : manual ? "Manual" : "Focus";
    const suffix = state.status === "paused" ? " paused" : state.status === "idle" ? " ready" : "";
    const phaseLabel = state.status === "alarm" ? "Complete"
      : state.status === "choice" ? "Choose next"
      : `${phase}${suffix}`;
    setText(workspace.querySelector(".compact-phase"), phaseLabel);
    const subject = workspace.querySelector<HTMLElement>(".compact-subject strong")!;
    setText(subject, state.subject);
    subject.title = state.subject;
    const mode = manual ? "Manual" : `Pomodoro · session ${state.cycle_position + 1}/4`;
    const hint = manual && state.status === "idle" ? " · Edit duration in full view" : "";
    setText(workspace.querySelector(".compact-subject > span"), `${mode}${hint}`);
    const contribution = workspace.querySelector<HTMLElement>("#manual-contribution-status")!;
    contribution.hidden = !manual;
    setText(contribution, `Count toward Pomodoro: ${counts ? "On" : "Off"}`);
  }

  return { render, acceptSnapshot: timer.acceptSnapshot, updateCountdown: timer.updateCountdown };
}

function connectionName(view: View) {
  if (view.backend === "local") return view.initializing ? "Local setup" : "Local";
  return view.connection === "connected" ? "Connected"
    : view.connection === "connecting" ? "Connecting"
    : "Disconnected";
}
