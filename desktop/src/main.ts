import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { History, View } from "./ipc-types";
import { createCommands } from "./ui/commands";
import { createCompactLayout } from "./ui/compact-layout";
import { createDialog } from "./ui/dialog";
import { createSettings } from "./ui/settings";
import { mountShell } from "./ui/shell";
import { createHistoryView } from "./ui/workspace/history-view";
import { createWorkspace } from "./ui/workspace/workspace";
import { WindowLayout } from "./window-layout";

export { formatTime } from "./ui/workspace/timer";

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
let localError: string | null = null;
let lastViewRevision: number | undefined;

const getView = () => view;
const shell = mountShell(document.querySelector<HTMLElement>("#app")!);
const { workspace } = shell;
const dialog = createDialog(shell.modal);
const windowLayout = new WindowLayout();
const historyView = createHistoryView(workspace, loadHistory);
const commands = createCommands({
  workspace,
  dialogContent: dialog.content,
  getView,
  clearError: () => {
    localError = null;
  },
  showError,
  render,
});
const settings = createSettings({ dialog, commands, getView, showError });
const layout = createCompactLayout({
  workspace,
  windowLayout,
  hasSnapshot: () => !!view.snapshot,
  closeDialog: () => {
    if (dialog.element.open) dialog.close();
  },
  prepareDetails: renderCompactHistory,
  onChange: handleLayoutChange,
  showError,
});
const workspaceView = createWorkspace({
  workspace,
  getView,
  commands,
  dialog,
  layout,
  openSetup: () => {
    if (view.initializing) settings.openLocalSetup();
    else settings.open(true);
  },
  openConnectionSettings: () => settings.open(true),
  toggleHistory,
  openFullHistory,
  showError,
});

shell.settingsButton.addEventListener("click", () => settings.open());
setInterval(workspaceView.updateCountdown, 200);
void boot();

function render() {
  layout.syncButtons();
  shell.renderBanner(view, localError, commands);
  shell.renderProfile(view);
  workspaceView.render(historyVisible);
  if (view.snapshot) renderHistory();
  settings.render();
  commands.renderFeedback();
  workspaceView.updateCountdown();
}

function showError(error: string) {
  if (dialog.element.open) {
    dialog.setError(error);
  } else {
    localError = error;
    shell.renderBanner(view, localError, commands);
  }
}

async function call<T>(name: string): Promise<T | undefined> {
  try {
    return await invoke<T>(name);
  } catch (error) {
    showError(String(error));
    return undefined;
  }
}

async function loadHistory() {
  await call("request_history");
}

function renderCompactHistory() {
  historyView.renderCompactHistory(history, commands.connected());
}

function renderHistory() {
  if (historyVisible) historyView.renderHistory(history, commands.connected());
  if (layout.details) renderCompactHistory();
}

function toggleHistory() {
  historyVisible = !historyVisible;
  render();
  if (historyVisible) void loadHistory();
}

function openFullHistory() {
  if (layout.changing) return;
  historyView.selectRecent();
  void layout.change(false, false, true);
}

function handleLayoutChange(showHistory: boolean) {
  if (layout.details && commands.connected()) void loadHistory();
  if (showHistory) {
    historyVisible = true;
    if (commands.connected()) void loadHistory();
  }
  render();
}

function applyView(next: View) {
  workspaceView.acceptSnapshot(next.snapshot);
  const previous = view;
  const revision = next.snapshot?.state.revision;
  const revisionChanged = revision !== lastViewRevision;
  const reconnected = next.connection === "connected" && previous.connection !== "connected";
  const serverChanged = next.endpoint !== previous.endpoint;
  if (serverChanged) history = null;
  lastViewRevision = revision;
  view = next;

  commands.syncFeedback();
  render();
  settings.syncView();
  if (
    (historyVisible || layout.details) &&
    (revisionChanged || reconnected || serverChanged) &&
    commands.connected()
  ) {
    void loadHistory();
  }
  if (dialog.element.open && view.error && view.error !== previous.error) {
    dialog.setError(view.error);
  }
}

async function boot() {
  try {
    await windowLayout.fitStartup();
  } catch (error) {
    console.error("Could not fit startup window to monitor work area", error);
  }
  await listen<View>("restbank:view", ({ payload }) => applyView(payload));
  await listen<History>("restbank:history", ({ payload }) => {
    history = payload;
    renderHistory();
  });
  const initial = await call<View>("get_view");
  if (initial) applyView(initial);
  else render();
}
