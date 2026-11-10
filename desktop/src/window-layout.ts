import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";

type Bounds = {
  position: PhysicalPosition;
  size: PhysicalSize;
  maximized: boolean;
};

// One native window; timer state and connections do not participate in resizing.
export class WindowLayout {
  private full: Bounds | null = null;
  private compact = false;

  async change(compact: boolean, details: boolean): Promise<void> {
    const win = getCurrentWindow();
    const before: Bounds = {
      maximized: await win.isMaximized(),
      position: await win.outerPosition(),
      size: await win.innerSize(),
    };
    let rollback = before;
    try {
      if (before.maximized) {
        await win.unmaximize();
        // Capture Windows' restored rectangle, not the maximized client size.
        rollback = {
          maximized: true,
          position: await win.outerPosition(),
          size: await win.innerSize(),
        };
      }
      const target = !compact ? this.full : null;
      if (!compact && !target)
        throw new Error("Full window bounds are unavailable.");
      const monitors = await availableMonitors();
      const position = target?.position ?? rollback.position;
      const monitor =
        (target && monitors.find((m) => contains(m, position))) ||
        (await currentMonitor()) ||
        monitors[0];
      if (!monitor) throw new Error("The monitor work area is unavailable.");
      const scale = monitor.scaleFactor;
      const inner = await win.innerSize();
      const outer = await win.outerSize();
      const frame = {
        width: outer.width - inner.width,
        height: outer.height - inner.height,
      };
      const area = monitor.workArea;
      const available = {
        width: Math.max(1, area.size.width - frame.width),
        height: Math.max(1, area.size.height - frame.height),
      };
      const minimum = new PhysicalSize(
        Math.min(Math.round((compact ? 360 : 390) * scale), available.width),
        Math.min(Math.round((compact ? 400 : 560) * scale), available.height),
      );
      await win.setMinSize(minimum);
      const size = new PhysicalSize(
        Math.min(
          target?.size.width ?? Math.round(390 * scale),
          available.width,
        ),
        Math.min(
          target?.size.height ?? Math.round((details ? 740 : 480) * scale),
          available.height,
        ),
      );
      await win.setSize(size);
      await win.setPosition(
        new PhysicalPosition(
          Math.max(
            area.position.x,
            Math.min(
              position.x,
              area.position.x + available.width - size.width,
            ),
          ),
          Math.max(
            area.position.y,
            Math.min(
              position.y,
              area.position.y + available.height - size.height,
            ),
          ),
        ),
      );
      if (target?.maximized) await win.maximize();
      if (compact && !this.compact) this.full = rollback;
      this.compact = compact;
      if (!compact) this.full = null;
    } catch (error) {
      // Best effort rollback also restores Windows' normal rectangle before maximize.
      try {
        await win.setMinSize(new PhysicalSize(1, 1));
        await win.setSize(rollback.size);
        await win.setPosition(rollback.position);
        if (rollback.maximized) await win.maximize();
        const scale = await win.scaleFactor();
        await win.setMinSize(
          new PhysicalSize(
            Math.min(
              Math.round((this.compact ? 360 : 390) * scale),
              rollback.size.width,
            ),
            Math.min(
              Math.round((this.compact ? 400 : 560) * scale),
              rollback.size.height,
            ),
          ),
        );
      } catch (rollbackError) {
        throw new Error(
          `${String(error)} Window restoration also failed: ${String(rollbackError)}`,
        );
      }
      throw error;
    }
  }
}
function contains(monitor: Monitor, position: PhysicalPosition) {
  const { position: p, size } = monitor.workArea;
  return (
    position.x >= p.x &&
    position.y >= p.y &&
    position.x < p.x + size.width &&
    position.y < p.y + size.height
  );
}
