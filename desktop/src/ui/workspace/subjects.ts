import type { State } from "../../ipc-types";
import type { Commands } from "../commands";
import type { Dialog } from "../dialog";
import { setText } from "../dom";
import { escape } from "../markup";

export function createSubjects(
  workspace: HTMLElement,
  getState: () => State,
  commands: Commands,
  dialog: Dialog,
) {
  let renderedSubjects = "";

  function bind() {
    renderedSubjects = "";
    const trigger = workspace.querySelector<HTMLButtonElement>("#subject")!;
    const popup = workspace.querySelector<HTMLElement>("#subject-popup")!;
    const menu = popup.querySelector<HTMLElement>("#subject-menu")!;
    const remove = menu.querySelector<HTMLButtonElement>("#context-delete")!;
    let contextName = "";
    let contextRow: HTMLButtonElement | null = null;

    trigger.addEventListener("click", () => {
      if (trigger.disabled) return;
      const rect = trigger.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 240));
      const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 230));
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
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
      const row = (event.target as Element).closest<HTMLButtonElement>(".subject-option");
      if (!row || trigger.disabled) return;
      popup.hidePopover();
      trigger.focus();
      void commands.send({ type: "select", mode: getState().mode, subject: row.dataset.name! });
    });
    popup.addEventListener("contextmenu", (event) => {
      const row = (event.target as Element).closest<HTMLButtonElement>(".subject-option");
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
      confirmRemoval(contextName);
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
        const rows = Array.from(popup.querySelectorAll<HTMLButtonElement>(".subject-option"));
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
        rows[(index + step) % rows.length]?.focus();
      }
    });

    workspace.querySelector("#add-subject")!.addEventListener("click", openAddSubject);
    workspace.querySelector("#delete-subject")!.addEventListener("click", () => {
      confirmRemoval(getState().subject);
    });
  }

  function render(state: State) {
    const unavailable = !commands.available() || state.status !== "idle";
    const subject = workspace.querySelector<HTMLButtonElement>("#subject")!;
    setText(subject.querySelector(".subject-name"), state.subject);
    subject.title = state.subject;
    commands.lockControl(subject, unavailable);
    commands.lockControl(workspace.querySelector<HTMLButtonElement>("#add-subject")!, unavailable);
    commands.lockControl(
      workspace.querySelector<HTMLButtonElement>("#delete-subject")!,
      unavailable || state.subject === "Umum",
    );

    const popup = workspace.querySelector<HTMLElement>("#subject-popup")!;
    const subjectKey = JSON.stringify(state.subjects);
    if (subjectKey !== renderedSubjects) {
      popup.querySelectorAll(".subject-option").forEach((row) => row.remove());
      popup.querySelector<HTMLElement>("#subject-menu")!.hidden = true;
      const rows = state.subjects.map((name) => {
        const label = escape(name);
        return `<button class="subject-option" role="option" data-name="${label}">${label}</button>`;
      }).join("");
      popup.insertAdjacentHTML("afterbegin", rows);
      renderedSubjects = subjectKey;
    }
    popup.querySelectorAll<HTMLButtonElement>(".subject-option").forEach((row) => {
      row.setAttribute("aria-selected", String(row.dataset.name === state.subject));
    });
    if (subject.disabled && popup.matches(":popover-open")) popup.hidePopover();
  }

  function openAddSubject() {
    dialog.open("A new subject", `
      <form id="subject-form">
        <label>
          Subject name
          <input id="new-subject" maxlength="100" placeholder="What are you learning?" required autofocus>
        </label>
        <button class="primary" type="submit">Add subject</button>
      </form>
    `);
    const form = dialog.content.querySelector("#subject-form")!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = form.querySelector<HTMLInputElement>("#new-subject")!.value.trim();
      if (!name) {
        dialog.setError("Enter a subject name.");
        return;
      }
      dialog.close();
      void commands.send({ type: "add_subject", name });
    });
  }

  function confirmRemoval(name: string) {
    dialog.open("Remove this subject?", `
      <p>Remove <strong>${escape(name)}</strong> from the list? Its history and saved progress will be kept.</p>
      <div class="dialog-actions">
        <button class="secondary" id="cancel-delete">Cancel</button>
        <button class="primary danger" id="confirm-delete">Remove subject</button>
      </div>
    `);
    dialog.content.querySelector("#cancel-delete")!.addEventListener("click", dialog.close);
    dialog.content.querySelector("#confirm-delete")!.addEventListener("click", () => {
      dialog.close();
      void commands.send({ type: "delete_subject", name });
    });
  }

  return { bind, render };
}
