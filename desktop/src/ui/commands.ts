import { invoke } from "@tauri-apps/api/core";
import type { Command, View } from "../ipc-types";
import { setText } from "./dom";

type CommandOptions = {
  workspace: HTMLElement;
  dialogContent: HTMLElement;
  getView: () => View;
  clearError: () => void;
  showError: (error: string) => void;
  render: () => void;
};

export function createCommands({
  workspace,
  dialogContent,
  getView,
  clearError,
  showError,
  render,
}: CommandOptions) {
  let submitting = false;
  let feedbackKey: string | null = null;
  let feedbackVisible = false;
  let feedbackTimer: number | undefined;

  function connected() {
    return getView().connection === "connected";
  }

  function available() {
    return connected() && !getView().snapshot?.storage_error;
  }

  function pending() {
    return !!getView().pending || submitting;
  }

  function usable() {
    return available() && !pending();
  }

  async function send(command: Command) {
    if (
      !connected() ||
      pending() ||
      (!available() && command.type !== "retry_storage")
    ) {
      return false;
    }
    clearError();
    submitting = true;
    render();
    try {
      await invoke("send_command", { command });
      return true;
    } catch (error) {
      showError(String(error));
      return false;
    } finally {
      submitting = false;
      render();
    }
  }

  function retry() {
    void invoke("retry_pending").catch((error) => showError(String(error)));
  }

  function lockControl(
    control: HTMLButtonElement | HTMLInputElement | HTMLFieldSetElement,
    unavailable: boolean,
  ) {
    const isPending = pending();
    const pendingOnly = isPending && !unavailable;
    control.disabled = unavailable || isPending;
    control.classList.toggle("pending-lock", pendingOnly);
    if (pendingOnly) control.setAttribute("aria-busy", "true");
    else control.removeAttribute("aria-busy");
  }

  function renderFeedback() {
    const visible = feedbackVisible && !!getView().pending;
    document.querySelectorAll<HTMLElement>(".command-feedback")
      .forEach((feedback) => {
        feedback.hidden = !visible;
        setText(feedback.querySelector('[role="status"]'), visible ? "Waiting…" : "");
        feedback.querySelector<HTMLButtonElement>("button")!.disabled = !connected();
      });
    const title = workspace.querySelector<HTMLElement>(".section-top .eyebrow");
    if (title) title.hidden = visible;
    const description = dialogContent.querySelector<HTMLElement>("#preferences-description");
    if (description) description.hidden = visible;
  }

  function syncFeedback() {
    const view = getView();
    const key = view.pending
      ? JSON.stringify([view.endpoint, view.profile, view.pending])
      : null;
    if (key === feedbackKey) return;
    if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    feedbackKey = key;
    feedbackVisible = false;
    if (key) {
      feedbackTimer = window.setTimeout(() => {
        if (feedbackKey !== key || !getView().pending) return;
        feedbackTimer = undefined;
        feedbackVisible = true;
        renderFeedback();
      }, 300);
    }
  }

  return {
    connected, available, pending, usable, send, retry, lockControl,
    renderFeedback, syncFeedback,
  };
}

export type Commands = ReturnType<typeof createCommands>;

export function pendingFeedbackMarkup(retryId: string) {
  return `
    <div class="command-feedback" hidden>
      <span role="status" aria-live="polite" aria-atomic="true"></span>
      <button id="${retryId}" class="text-button">Retry same command</button>
    </div>
  `;
}
