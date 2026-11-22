import type { State, Status, View } from "../../ipc-types";
import type { Commands } from "../commands";
import { setText } from "../dom";

const finishTimeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const primaryAction: Record<Status, string> = {
  idle: "start",
  running: "pause",
  paused: "resume",
  choice: "continue_focus",
  alarm: "stop_alarm",
};

export const formatTime = (n: number) => {
  n = Math.max(0, Math.floor(n));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
};

function focusProgress(state: State) {
  const timer = state.timer?.phase === "focus" ? state.timer : state.timer?.suspended_focus;
  if (timer && timer.remaining_seconds > 0) return state.focus_seconds - timer.remaining_seconds;
  return state.settings.focus_scope === "shared"
    ? state.shared_progress
    : (state.per_subject_progress[state.subject] ?? 0);
}

type TimerOptions = {
  workspace: HTMLElement;
  getView: () => View;
  commands: Commands;
  dialogOpen: () => boolean;
  showError: (error: string) => void;
};

export function createTimer({
  workspace, getView, commands, dialogOpen, showError,
}: TimerOptions) {
  const manual = [0, 0, 0];
  let snapshotArrived = performance.now();
  let lastSnapshotKey = "";
  let spaceHeld = false;

  function acceptSnapshot(snapshot: View["snapshot"]) {
    const key = snapshot
      ? `${snapshot.state.revision}:${snapshot.state.tick_sequence}:${snapshot.server_time_ms}`
      : "";
    if (key !== lastSnapshotKey) {
      snapshotArrived = performance.now();
      lastSnapshotKey = key;
    }
  }

  function manualSeconds() {
    return manual[0] * 3600 + manual[1] * 60 + manual[2];
  }

  function updateCountdown() {
    const view = getView();
    const state = view.snapshot?.state;
    if (!state) return;

    const elapsed = state.status === "running"
      ? Math.floor((performance.now() - snapshotArrived) / 1000)
      : 0;
    const progress = focusProgress(state);
    const remaining = state.timer
      ? Math.max(0, state.timer.remaining_seconds - elapsed)
      : state.mode === "manual" ? manualSeconds() : state.focus_seconds - progress;

    setText(workspace.querySelector("#countdown"), formatTime(remaining));
    const ring = workspace.querySelector<SVGCircleElement>(".ring-fill");
    if (ring) {
      const fraction = state.timer
        ? 1 - remaining / state.timer.total_seconds
        : state.mode === "pomodoro" ? progress / state.focus_seconds : 0;
      const offset = String(860.8 * (1 - Math.max(0, Math.min(1, fraction))));
      if (ring.style.strokeDashoffset !== offset) ring.style.strokeDashoffset = offset;
    }

    const estimate = workspace.querySelector("#estimate");
    const waiting = view.backend === "local" ? "Waiting for timer" : "Waiting for server";
    if (state.status === "idle" && remaining > 0 && commands.connected()) {
      const finishTime = finishTimeFormat.format(Date.now() + remaining * 1000);
      setText(estimate, `Ends at ${finishTime}`);
    } else if (estimate) {
      if (!commands.connected()) {
        estimate.textContent = remaining === 0 ? waiting : "Estimated · waiting for server";
      } else {
        estimate.textContent = state.status === "running" && (remaining === 0 || elapsed > 2)
          ? waiting
          : "\u00a0";
      }
    }
  }

  function readDuration(input: HTMLInputElement, index: number) {
    const value = Number(input.value);
    const max = index === 0 ? 99 : 59;
    if (!/^\d{1,2}$/.test(input.value) || value > max) return false;
    manual[index] = value;
    return true;
  }

  function commitDuration(index: number) {
    const input = workspace.querySelector<HTMLInputElement>(`#duration-${index}`);
    if (!input) return;
    readDuration(input, index);
    input.value = String(manual[index]).padStart(2, "0");
    updateCountdown();
  }

  function bindDuration() {
    for (let index = 0; index < manual.length; index++) {
      const input = workspace.querySelector<HTMLInputElement>(`#duration-${index}`)!;
      input.addEventListener("input", () => {
        if (readDuration(input, index)) updateCountdown();
      });
      input.addEventListener("blur", () => commitDuration(index));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          commitDuration(index);
          input.blur();
        }
      });

      function step(delta: number) {
        if (input.disabled) return;
        const max = index === 0 ? 100 : 60;
        manual[index] = (manual[index] + delta + max) % max;
        input.value = String(manual[index]).padStart(2, "0");
        updateCountdown();
      }

      input.addEventListener("wheel", (event) => {
        if (!input.disabled) {
          event.preventDefault();
          step(event.deltaY > 0 ? 1 : -1);
        }
      }, { passive: false });

      const drag = workspace.querySelector<HTMLElement>(`.drag-label[data-index="${index}"]`)!;
      let start: number | null = null;
      drag.addEventListener("pointerdown", (event) => {
        if (!input.disabled) {
          start = event.clientY;
          drag.setPointerCapture(event.pointerId);
        }
      });
      drag.addEventListener("pointermove", (event) => {
        if (start === null) return;
        const change = Math.trunc((start - event.clientY) / 12);
        if (change) {
          step(change);
          start = event.clientY;
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
    if (!commands.usable()) return;
    const state = getView().snapshot!.state;
    manual.forEach((_, index) => commitDuration(index));
    if (
      state.status === "idle" && state.mode === "manual" && manual.every((value) => value === 0)
    ) {
      showError("Enter a duration from 00:00:01 to 99:59:59.");
      return;
    }
    void commands.send(state.status === "idle"
      ? { type: "start", seconds: manualSeconds() }
      : { type: primaryAction[state.status] });
  }

  function bind() {
    bindDuration();
    workspace.querySelector("#primary")!.addEventListener("click", primary);
    workspace.querySelector("#reset")!.addEventListener("click", () => {
      manual.fill(0);
      workspace.querySelectorAll<HTMLInputElement>(".duration-fields input").forEach((input) => {
        input.value = "00";
      });
      void commands.send({ type: "reset" });
    });
  }

  document.addEventListener("keydown", (event) => {
    if (
      event.code !== "Space" ||
      dialogOpen() ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,select,button,a,[contenteditable]"))
    ) return;

    event.preventDefault();
    if (spaceHeld || event.repeat) return;
    spaceHeld = true;
    const state = getView().snapshot?.state;
    const canActivate = ["running", "paused", "alarm"].includes(state?.status ?? "") ||
      (state?.status === "idle" && state.mode === "pomodoro");
    if (commands.usable() && canActivate) primary();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space") spaceHeld = false;
  });
  window.addEventListener("blur", () => {
    spaceHeld = false;
  });

  return { manual: manual as readonly number[], acceptSnapshot, updateCountdown, bind };
}
