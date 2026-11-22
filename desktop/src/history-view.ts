import type { History } from "./ipc-types";
import { escape, icon } from "./markup";

const historyDateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const duration = (n: number) =>
  n < 60
    ? `${n}s`
    : n < 3600
      ? `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`
      : `${Math.floor(n / 3600)}h ${Math.floor(n / 60) % 60}m`;

export function createHistoryView(
  workspace: HTMLElement,
  loadHistory: () => Promise<void>,
) {
  let historyTab = "recent";
  let panelRendered: Element | null = null;
  let renderedHistory: History | null | undefined;
  let renderedHistoryTab = "";
  let renderedHistoryConnected: boolean | undefined;

  function renderHistory(history: History | null, connected: boolean) {
    const panel = workspace.querySelector("#history-panel");
    if (!panel) return;
    if (!panel.querySelector("#history-list")) {
      panel.innerHTML = `
        <div class="history-heading">
          <div>
            <span class="eyebrow">A LITTLE PROGRESS, EVERY DAY</span>
            <h2>Your focus, remembered</h2>
          </div>
          <button id="refresh-history" class="icon-button" aria-label="Refresh history">${icon("reset")}</button>
        </div>
        <div class="history-tabs">
          <button data-tab="recent">Recent sessions</button>
          <button data-tab="summary">By subject</button>
        </div>
        <div id="history-list"></div>
      `;
      panel
        .querySelectorAll<HTMLButtonElement>("[data-tab]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            historyTab = button.dataset.tab!;
            renderHistory(
              renderedHistory ?? null,
              renderedHistoryConnected ?? false,
            );
          });
        });
      panel
        .querySelector("#refresh-history")!
        .addEventListener("click", loadHistory);
    }
    if (
      panelRendered === panel &&
      renderedHistory === history &&
      renderedHistoryTab === historyTab &&
      renderedHistoryConnected === connected
    )
      return;
    panelRendered = panel;
    renderedHistory = history;
    renderedHistoryTab = historyTab;
    renderedHistoryConnected = connected;
    panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === historyTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const list = panel.querySelector("#history-list")!;
    if (!connected)
      list.innerHTML =
        '<p class="empty-state">Reconnect to load your history.</p>';
    else if (!history)
      list.innerHTML = '<p class="empty-state">Loading your sessions…</p>';
    else if (historyTab === "recent")
      list.innerHTML = history.sessions.length
        ? history.sessions
            .map((session) => {
              const date = historyDateFormat.format(new Date(session.recorded_at));
              const mode = session.mode === "manual" ? "Manual" : "Pomodoro";
              return `<div class="history-row">
                <span class="session-icon">${icon("clock")}</span>
                <div><strong>${escape(session.subject)}</strong><span>${escape(date)} · ${mode}</span></div>
                <strong>${duration(session.duration_seconds)}</strong>
              </div>`;
            })
            .join("")
        : '<p class="empty-state">Your first session starts a story.<br>Finish a timer to see it here.</p>';
    else
      list.innerHTML = history.summary.length
        ? history.summary
            .map(
              (s) =>
                `<div class="history-row">
                  <span class="session-icon">${icon("target")}</span>
                  <div><strong>${escape(s.subject)}</strong><span>${s.count} ${s.count === 1 ? "session" : "sessions"}</span></div>
                  <strong>${duration(s.duration_seconds)}</strong>
                </div>`,
            )
            .join("")
        : '<p class="empty-state">No sessions yet.</p>';
  }

  let compactHistoryMarkup = "";
  function renderCompactHistory(history: History | null, connected: boolean) {
    const list = workspace.querySelector<HTMLElement>("#compact-history-list")!;
    const markup = !connected
      ? '<p class="empty-state">Reconnect to load your history.</p>'
      : !history
        ? '<p class="empty-state">Loading your sessions\u2026</p>'
        : history.sessions.length
          ? history.sessions.slice(0, 3).map((session) => {
              const subject = escape(session.subject);
              const date = historyDateFormat.format(new Date(session.recorded_at));
              return `<div class="history-row">
                <div><strong title="${subject}">${subject}</strong><span>${escape(date)}</span></div>
                <strong>${duration(session.duration_seconds)}</strong>
              </div>`;
            }).join("")
          : '<p class="empty-state">No sessions yet.</p>';
    if (markup !== compactHistoryMarkup || list.innerHTML === "") {
      list.innerHTML = markup;
      compactHistoryMarkup = markup;
    }
  }

  return {
    renderHistory,
    renderCompactHistory,
    selectRecent() {
      historyTab = "recent";
    },
  };
}
