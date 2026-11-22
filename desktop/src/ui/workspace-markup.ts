import { icon } from "./markup";

export function workspaceMarkup(
  manual: readonly number[],
  pendingFeedback: string,
) {
  const durationFields = ["Hours", "Minutes", "Seconds"]
    .map((name, i) => {
      const value = String(manual[i]).padStart(2, "0");
      return `<label>
        <span class="drag-label" data-index="${i}">${name}</span>
        <input id="duration-${i}" aria-label="${name}" inputmode="numeric"
               maxlength="2" value="${value}">
      </label>`;
    })
    .join('<span class="colon">:</span>');

  return `
  <section class="timer-panel panel">
    <div class="section-top">
      <span class="compact-phase compact-only"></span>
      <div class="panel-heading">
        <span class="eyebrow"></span>
        ${pendingFeedback}
      </div>
      <button id="connection-status" title="Connection settings"><i></i><span></span></button>
    </div>
    <div class="compact-subject compact-only"><strong></strong><span></span></div>
    <div class="mode-tabs" role="group" aria-label="Timer mode">
      <button data-mode="manual">Manual</button>
      <button data-mode="pomodoro">Pomodoro</button>
    </div>
    <div class="subject-row">
      <label for="subject">I'm focusing on</label>
      <div class="subject-controls">
        <button id="subject" class="subject-picker" aria-haspopup="listbox" aria-expanded="false">
          <span class="subject-name"></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div id="subject-popup" class="subject-popup" popover="auto"
             role="listbox" aria-label="Study subjects">
          <div id="subject-menu" class="subject-context" role="menu" hidden>
            <button role="menuitem" id="context-delete">Remove subject</button>
          </div>
        </div>
        <button id="add-subject" class="icon-button small" aria-label="Add subject">
          ${icon("plus")}
        </button>
        <button id="delete-subject" class="icon-button small" aria-label="Delete selected subject">
          ${icon("trash")}
        </button>
      </div>
    </div>
    <div class="timer-face">
      <svg class="progress-ring" viewBox="0 0 300 300" aria-hidden="true">
        <circle class="ring-track" cx="150" cy="150" r="137"/>
        <circle class="ring-fill" cx="150" cy="150" r="137" style="stroke-dasharray:860.8"/>
      </svg>
      <div class="timer-content">
        <span class="phase-icon"></span>
        <div id="countdown" class="countdown" aria-label="Time remaining"></div>
        <span class="timer-caption"></span>
        <span id="estimate" class="estimate"></span>
      </div>
    </div>
    <div class="duration-fields" aria-label="Manual duration">${durationFields}</div>
    <div id="manual-contribution">
      <label class="check-row">
        <input id="manual-counts" type="checkbox" role="switch">Count toward Pomodoro
      </label>
      <p class="hint">Completed time and time saved by Reset count toward your focus target.</p>
    </div>
    <div class="balance-control">
      <button id="balance-toggle" class="secondary" popovertarget="balance-menu"
              aria-expanded="false" aria-controls="balance-menu">
        ${icon("cup")}Break balance <strong id="balance-value"></strong>${icon("chevron")}
      </button>
      <div id="balance-menu" popover="auto" aria-label="Break options">
        <div class="break-actions">
          <button id="break-all" class="secondary">${icon("cup")}Use break balance</button>
          <button id="break-choose" class="text-button">
            ${icon("clock")}<span>Choose duration\u2026</span>${icon("chevron")}
          </button>
        </div>
      </div>
    </div>
    <div class="timer-actions">
      <button id="primary" class="primary"></button>
      <button id="reset" class="secondary">${icon("reset")}Reset</button>
    </div>
    <button id="skip" class="text-button">Skip break</button>
    <div class="compact-footer compact-only">
      <span>Break balance <strong id="compact-balance"></strong></span>
      <button id="compact-detail-toggle" class="text-button"
              aria-expanded="false" aria-controls="compact-details">Details ${icon("chevron")}</button>
    </div>
    <div id="compact-details" class="compact-only" role="region" aria-label="Timer details">
      <p id="manual-contribution-status" class="hint"></p>
    </div>
    <div class="panel-bottom">
      <section id="compact-history-preview" class="compact-only" aria-label="Recent history">
        <div class="compact-history-heading">
          <span>${icon("history")}History</span>
          <button id="compact-history" class="text-button">View all</button>
        </div>
        <div id="compact-history-list" aria-live="polite"></div>
      </section>
      <button id="history-toggle" class="text-button"></button>
    </div>
  </section>
  <section id="history-panel" class="panel history-panel" hidden></section>
  `;
}
