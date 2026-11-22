import type { WindowLayout } from "../window-layout";
import { setMarkup } from "./dom";
import { icon } from "./markup";

type CompactLayoutOptions = {
  workspace: HTMLElement;
  windowLayout: WindowLayout;
  hasSnapshot: () => boolean;
  closeDialog: () => void;
  prepareDetails: () => void;
  onChange: (showHistory: boolean) => void;
  showError: (error: string) => void;
};

export function createCompactLayout({
  workspace,
  windowLayout,
  hasSnapshot,
  closeDialog,
  prepareDetails,
  onChange,
  showError,
}: CompactLayoutOptions) {
  const root = document.documentElement;
  const toggle = document.querySelector<HTMLButtonElement>("#compact-toggle")!;
  const headerActions = document.querySelector<HTMLElement>(".header-actions")!;
  let compact = false;
  let details = false;
  let stagedDetails: boolean | null = null;
  let changing = false;
  let fitFrame = 0;
  let lastHeight: number | null = null;

  toggle.addEventListener("click", () => void change(!compact));
  const sizeObserver = new ResizeObserver(scheduleFit);
  sizeObserver.observe(workspace);
  sizeObserver.observe(document.querySelector("#banner")!);

  async function change(nextCompact: boolean, nextDetails = false, showHistory = false) {
    if (changing || (nextCompact && !hasSnapshot())) return;
    changing = true;
    const focused = document.activeElement as HTMLElement | null;
    const previousOverflow = root.style.overflowY;
    syncButtons();
    closeDialog();
    workspace.querySelectorAll<HTMLElement>(":popover-open").forEach((popover) => {
      popover.hidePopover();
    });
    try {
      // Measure and stage the final content before Windows changes the client area.
      let detailsHeight: number | undefined;
      if (compact && nextCompact && nextDetails) {
        prepareDetails();
        detailsHeight = measureDetails();
      }
      if (compact && nextCompact) {
        // Keep scrolling available when the current content already exceeds the viewport.
        if (root.scrollHeight <= innerHeight) root.style.overflowY = "hidden";
        stagedDetails = nextDetails;
        root.dataset.details = String(nextDetails);
        workspace.querySelector<HTMLElement>("#compact-details")!.hidden = !nextDetails;
        workspace.getBoundingClientRect();
      }
      await windowLayout.change(nextCompact, nextDetails, detailsHeight);
      compact = nextCompact;
      details = nextCompact && nextDetails;
      root.dataset.layout = compact ? "compact" : "full";
      root.dataset.details = String(details);
      const destination = compact
        ? workspace.querySelector(".section-top")
        : document.querySelector(".topbar");
      destination?.append(headerActions);
      lastHeight = detailsHeight ?? null;
      onChange(showHistory);
    } catch (error) {
      showError(`Could not change the window layout: ${String(error)}`);
    } finally {
      stagedDetails = null;
      root.dataset.details = String(details);
      const detailRegion = workspace.querySelector<HTMLElement>("#compact-details");
      if (detailRegion) detailRegion.hidden = !details;
      root.style.overflowY = previousOverflow;
      changing = false;
      syncButtons();
      scheduleFit();
      if (focused?.isConnected && focused.getClientRects().length) focused.focus();
      else toggle.focus();
    }
  }

  function syncButtons() {
    toggle.disabled = changing || !hasSnapshot();
    toggle.classList.toggle("layout-lock", changing);
    toggle.setAttribute("aria-label", compact ? "Return to full view" : "Enter compact mode");
    toggle.title = compact ? "Full view" : "Compact mode";
    setMarkup(toggle, icon(compact ? "expand" : "compact"));
    workspace.querySelectorAll<HTMLButtonElement>("#compact-detail-toggle, #compact-history")
      .forEach((button) => {
        button.disabled = false;
        button.setAttribute("aria-disabled", String(changing));
        button.setAttribute("aria-busy", String(changing));
      });
  }

  function renderDetails() {
    workspace.querySelector("#compact-detail-toggle")!
      .setAttribute("aria-expanded", String(details));
    const detailRegion = workspace.querySelector<HTMLElement>("#compact-details")!;
    const breakActions = workspace.querySelector<HTMLElement>(".break-actions")!;
    const bottom = workspace.querySelector<HTMLElement>(".panel-bottom")!;
    const menu = workspace.querySelector<HTMLElement>("#balance-menu")!;

    // Reuse the controls and their handlers in both layouts.
    if (compact) {
      if (breakActions.parentElement !== detailRegion) detailRegion.append(breakActions);
      if (bottom.parentElement !== detailRegion) detailRegion.append(bottom);
      if (menu.matches(":popover-open")) menu.hidePopover();
    } else {
      if (bottom.parentElement === detailRegion) detailRegion.before(bottom);
      if (breakActions.parentElement !== menu) menu.append(breakActions);
    }
    detailRegion.hidden = !compact || !(stagedDetails ?? details);
  }

  function measureDetails() {
    const region = workspace.querySelector<HTMLElement>("#compact-details")!;
    const wasHidden = region.hidden;
    try {
      region.hidden = false;
      return Math.max(400, Math.ceil(region.getBoundingClientRect().bottom + scrollY + 16));
    } finally {
      region.hidden = wasHidden;
    }
  }

  function scheduleFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(async () => {
      if (!details || changing) return;
      const region = workspace.querySelector<HTMLElement>("#compact-details");
      if (!region || region.hidden) return;
      const height = measureDetails();
      if (height === lastHeight) return;
      const focused = document.activeElement as HTMLElement | null;
      changing = true;
      syncButtons();
      try {
        await windowLayout.change(true, true, height);
        lastHeight = height;
        scheduleFit();
      } catch (error) {
        // Remember the height to avoid retrying the rejected resize on subsequent ticks.
        lastHeight = height;
        showError(`Could not resize timer details: ${String(error)}`);
      } finally {
        changing = false;
        syncButtons();
        if (
          document.activeElement === document.body &&
          focused?.isConnected &&
          focused.getClientRects().length
        ) {
          focused.focus();
        }
      }
    });
  }

  return {
    get compact() {
      return compact;
    },
    get details() {
      return details;
    },
    get changing() {
      return changing;
    },
    change,
    syncButtons,
    renderDetails,
  };
}

export type CompactLayout = ReturnType<typeof createCompactLayout>;
