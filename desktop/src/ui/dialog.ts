import { icon } from "./markup";

export function createDialog(modal: HTMLDialogElement) {
  const content = modal.querySelector<HTMLDivElement>("#modal-content")!;
  let returnFocus: HTMLElement | null = null;

  modal.addEventListener("click", (event) => {
    if (event.target !== modal) return;
    const bounds = modal.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      modal.close();
    }
  });
  modal.addEventListener("close", () => returnFocus?.focus());

  function setError(message: string) {
    content.querySelector("#dialog-error")!.textContent = message;
  }

  function open(title: string, body: string) {
    returnFocus = document.activeElement as HTMLElement;
    content.innerHTML = `
      <div class="dialog-heading">
        <h2>${title}</h2>
        <button class="icon-button close-modal" aria-label="Close dialog">${icon("close")}</button>
      </div>
      ${body}
      <p id="dialog-error" role="alert" class="error-text"></p>
    `;
    content.querySelector(".close-modal")!
      .addEventListener("click", () => modal.close());
    content.querySelectorAll("input,select").forEach((input) => {
      input.addEventListener("input", () => setError(""));
    });
    if (!modal.open) modal.showModal();
  }

  return { element: modal, content, open, setError, close: () => modal.close() };
}

export type Dialog = ReturnType<typeof createDialog>;
