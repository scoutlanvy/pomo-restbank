import { test, expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function mock(page: Page, overrides: Record<string, unknown> = {}) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const bootstrap = `
import { mockIPC as _mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
window._commands=[];window._historyRequests=0;window._retryRequests=0;window._holdCommand=false;
window._view={snapshot:{state:{revision:1,tick_sequence:0,mode:'pomodoro',subject:'Umum',status:'idle',timer:null,balance_seconds:300,cycle_position:0,shared_progress:0,per_subject_progress:{},settings:{focus_scope:'shared',tick_sound:false,tick_volume:100},subjects:['Umum','English','Programming'],focus_seconds:1500,alarm_id:null},server_time_ms:Date.now(),storage_error:null,preview:false},connection:'connected',endpoint:'ws://127.0.0.1:4317/v1/ws',has_token:true,pending:null,error:null,profile:'test',preview:false,...${JSON.stringify(overrides)}};
_mockIPC((cmd,args)=>{if(cmd==='get_view')return window._view;if(cmd==='send_command'){window._commands.push(args.command);if(window._holdCommand)return new Promise((resolve,reject)=>{window._finishCommand=(error)=>error?reject(error):resolve(null);});return null;}if(cmd==='connect_server'){window._connection=args;return null;}if(cmd==='retry_pending'){window._retryRequests++;return null;}if(cmd==='request_history'){window._historyRequests++;return null;}},{shouldMockEvents:true});
window._update=async (partial)=>{window._view={...window._view,...partial};await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'restbank:view',payload:window._view});};
`;
    await route.fulfill({ response, body: bootstrap + original });
  });
  await page.goto("/");
  await expect(page.locator(".brand")).toContainText("Restbank");
}
test("minimal timer stays usable in both themes and narrow window", async ({
  page,
}) => {
  await mock(page);
  await expect(page.locator("#countdown")).toHaveText("00:25:00");
  await page.screenshot({
    path: join(tmpdir(), "pomo-restbank-ui-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await page.screenshot({
    path: join(tmpdir(), "pomo-restbank-ui-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await expect(page.getByRole("button", { name: "Start focus" })).toBeEnabled();
});
test("manual input commits valid values, restores invalid values and sends total seconds", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    const w = window as any;
    w._view.snapshot.state.mode = "manual";
    return w._update({});
  });
  await page.getByRole("textbox", { name: "Minutes", exact: true }).fill("12");
  await page
    .getByRole("textbox", { name: "Minutes", exact: true })
    .press("Enter");
  await page.getByRole("textbox", { name: "Seconds", exact: true }).fill("99");
  await page
    .getByRole("textbox", { name: "Seconds", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Seconds", exact: true }),
  ).toHaveValue("00");
  await page.getByRole("button", { name: "Start timer" }).click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "start",
    seconds: 720,
  });
});
test("disconnected client disables commands while keeping connection settings available", async ({
  page,
}) => {
  await mock(page, { connection: "disconnected" });
  await expect(page.locator("#primary")).toBeDisabled();
  await expect(page.locator("#reset")).toBeDisabled();
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Server address" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeDisabled();
});
test("space pauses a running timer once but never starts an idle timer", async ({
  page,
}) => {
  await mock(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(0);
  await page.evaluate(() => {
    const w = window as any;
    w._view.snapshot.state.status = "running";
    w._view.snapshot.state.timer = {
      phase: "focus",
      remaining_seconds: 1472,
      total_seconds: 1500,
      subject: "Umum",
      suspended_focus: null,
    };
    return w._update({});
  });
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([
    { type: "pause" },
  ]);
});
test("settings save sends shared preferences and does not save Cancel changes", async ({
  page,
}) => {
  await mock(page);
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page.getByLabel("Focus progress").selectOption("per_subject");
  await page.getByLabel("Tick every second").check();
  await page.locator("#tick-volume").fill("250");
  await page.getByRole("button", { name: "Save preferences" }).click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "save_settings",
    focus_scope: "per_subject",
    tick_sound: true,
    tick_volume: 250,
  });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(1);
});
test("subject text is escaped and removal requires confirmation", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    const w = window as any;
    w._view.snapshot.state.subject = "<img src=x onerror=alert(1)>";
    w._view.snapshot.state.subjects.push(w._view.snapshot.state.subject);
    return w._update({});
  });
  expect(await page.locator("img").count()).toBe(0);
  await page.getByRole("button", { name: "Delete selected subject" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Its history and saved progress will be kept",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(0);
});
test("right-click subject removal keeps current selection and Escape returns to the list", async ({
  page,
}) => {
  await mock(page);
  await page.locator("#subject").click();
  await page
    .getByRole("option", { name: "English", exact: true })
    .click({ button: "right" });
  await expect(page.locator("#subject")).toHaveText(/Umum/);
  await expect(
    page.getByRole("menuitem", { name: "Remove subject" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("option", { name: "English", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "English", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove subject" }).click();
  await expect(page.getByRole("dialog")).toContainText("English");
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(0);
});

async function updateState(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (patch) => {
    const w = window as any;
    w._view = {
      ...w._view,
      snapshot: {
        ...w._view.snapshot,
        state: {
          ...w._view.snapshot.state,
          ...patch,
          revision: w._view.snapshot.state.revision + 1,
        },
      },
    };
    await w._update({});
  }, patch);
}
const focusTimer = (remaining = 100) => ({
  phase: "focus",
  remaining_seconds: remaining,
  total_seconds: 1500,
  subject: "Umum",
  suspended_focus: null,
  return_to_choice: false,
});

test("tick preserves keyboard focus and animates the existing ring", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mock(page);
  await updateState(page, { status: "running", timer: focusTimer() });
  await page.locator("#primary").focus();
  await page.evaluate(async () => {
    const w = window as any;
    w._ring = document.querySelector(".ring-fill");
    w._primary = document.querySelector("#primary");
    // Commit the old style before delivering the next tick.
    getComputedStyle(w._ring).strokeDashoffset;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    w._view.snapshot = {
      ...w._view.snapshot,
      state: {
        ...w._view.snapshot.state,
        tick_sequence: 1,
        timer: {
          ...w._view.snapshot.state.timer,
          remaining_seconds: 99,
        },
      },
    };
    await w._update({});
  });
  await expect(page.locator("#primary")).toBeFocused();
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return (
        w._ring === document.querySelector(".ring-fill") &&
        w._primary === document.querySelector("#primary")
      );
    }),
  ).toBe(true);
  expect(
    await page
      .locator(".ring-fill")
      .evaluate((ring) => getComputedStyle(ring).transitionDuration),
  ).toBe("0.45s");
  await expect(page.locator("#countdown")).toHaveText("00:01:39");
  // Hold the authoritative remainder while the CSS transition settles.
  await updateState(page, { status: "paused" });
  await expect
    .poll(() =>
      page
        .locator(".ring-fill")
        .evaluate((ring) =>
          Number.parseFloat(getComputedStyle(ring).strokeDashoffset),
        ),
    )
    .toBeCloseTo((860.8 * 99) / 1500, 1);
});

test("heartbeat preserves uncommitted duration, dropdown and dialog return focus", async ({
  page,
}) => {
  await mock(page);
  await updateState(page, { mode: "manual" });
  await page.locator("#duration-1").fill("12");
  await page.evaluate(() => (window as any)._update({}));
  await expect(page.locator("#duration-1")).toBeFocused();
  await expect(page.locator("#duration-1")).toHaveValue("12");
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "start",
    seconds: 720,
  });
  await page.locator("#subject").click();
  await page.evaluate(() => (window as any)._update({}));
  await expect(
    page.getByRole("option", { name: "English", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#timer-settings").click();
  await page.evaluate(() => (window as any)._update({}));
  await page.keyboard.press("Escape");
  await expect(page.locator("#timer-settings")).toBeFocused();
});

test("dialog padding preserves drafts while backdrop and Escape dismiss", async ({
  page,
}) => {
  await mock(page);
  await page.locator("#add-subject").click();
  await page.locator("#new-subject").fill("Draft subject");
  const box = (await page.locator("#modal").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(page.locator("#modal")).toBeVisible();
  await expect(page.locator("#new-subject")).toHaveValue("Draft subject");
  await page.mouse.click(1, 1);
  await expect(page.locator("#modal")).not.toBeVisible();
  await page.locator("#add-subject").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal")).not.toBeVisible();
});

test("settings controls follow latest state without losing draft preferences", async ({
  page,
}) => {
  await mock(page);
  await page.locator("#settings").click();
  await page.locator("#tick-volume").fill("250");
  await updateState(page, { status: "running", timer: focusTimer() });
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeDisabled();
  await expect(page.locator("#tick-volume")).toBeDisabled();
  await updateState(page, { status: "idle", timer: null });
  await expect(page.locator("#tick-volume")).toBeEnabled();
  await expect(page.locator("#tick-volume")).toHaveValue("250");
  await page.evaluate(() =>
    (window as any)._update({ connection: "disconnected" }),
  );
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toBeDisabled();
  // Programmatic submit must also obey current state.
  await page
    .locator("#preferences")
    .evaluate((form) =>
      form.dispatchEvent(new Event("submit", { cancelable: true })),
    );
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([]);
  await page.evaluate(() =>
    (window as any)._update({ connection: "connected" }),
  );
  await page.getByRole("button", { name: "Save preferences" }).click();
  expect(
    await page.evaluate(() => (window as any)._commands.at(-1)),
  ).toMatchObject({ type: "save_settings", tick_volume: 250 });
});

test("local validation survives updates and clears when corrected", async ({
  page,
}) => {
  await mock(page);
  await page.locator("#break-choose").click();
  await page.locator("#break-minutes").fill("6");
  await page.locator("#break-form button").click();
  await page.evaluate(() => (window as any)._update({}));
  await expect(page.locator("#dialog-error")).toHaveText(
    "Choose a positive duration within your balance.",
  );
  await page.locator("#break-minutes").fill("2");
  await expect(page.locator("#dialog-error")).toBeEmpty();
  await page.locator("#break-form button").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "start_break",
    seconds: 120,
  });
  await page.locator("#add-subject").click();
  await page.locator("#new-subject").fill("   ");
  await page.locator("#subject-form button").click();
  await page.evaluate(() => (window as any)._update({}));
  await expect(page.locator("#dialog-error")).toHaveText(
    "Enter a subject name.",
  );
});

test("history reloads on reconnect and retains tab focus across ticks", async ({
  page,
}) => {
  await mock(page);
  await page.locator("#history-toggle").click();
  await expect
    .poll(() => page.evaluate(() => (window as any)._historyRequests))
    .toBe(1);
  await page.evaluate(() =>
    (window as any)._update({ connection: "disconnected" }),
  );
  await page.evaluate(() =>
    (window as any)._update({ connection: "connected" }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any)._historyRequests))
    .toBe(2);
  await page.getByRole("button", { name: "By subject", exact: true }).click();
  await page.evaluate(() => (window as any)._update({}));
  await expect(
    page.getByRole("button", { name: "By subject", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => (window as any)._historyRequests)).toBe(2);
});

test("manual zero is rejected locally and countdown zero waits for authority", async ({
  page,
}) => {
  await mock(page);
  await updateState(page, { mode: "manual" });
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([]);
  await expect(page.locator("#banner")).toContainText("Enter a duration");
  await updateState(page, {
    mode: "pomodoro",
    status: "running",
    timer: focusTimer(1),
  });
  await expect(page.locator("#countdown")).toHaveText("00:00:00", {
    timeout: 3000,
  });
  await expect(page.locator("#estimate")).toHaveText("Waiting for server");
  // Reaching zero visually must not send stop/finish commands.
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([]);
});

test("persistent action handlers use latest subject, balance and status", async ({
  page,
}) => {
  await mock(page);
  await updateState(page, { subject: "English", balance_seconds: 120 });
  await page.locator("[data-mode=manual]").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "select",
    mode: "manual",
    subject: "English",
  });
  await page.locator("#break-all").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "start_break",
    seconds: 120,
  });
  await updateState(page, { status: "running", timer: focusTimer() });
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "pause",
  });
  await updateState(page, { status: "paused" });
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1))).toEqual({
    type: "resume",
  });
});

for (const width of [680, 390]) {
  test(`motion and readable themes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 680 ? 850 : 700 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mock(page);
    const longName = "LongSubject".repeat(9);
    await updateState(page, {
      subject: longName,
      subjects: ["Umum", longName],
    });
    await expect(page.locator("#subject")).toHaveAttribute("title", longName);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const contrast = await page
        .locator(".timer-caption")
        .evaluate((caption) => {
          const rgb = (color: string) =>
            color.match(/\d+/g)!.slice(0, 3).map(Number);
          const luminance = (color: number[]) =>
            color
              .map((n) => {
                n /= 255;
                return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
              })
              .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
          const fg = luminance(rgb(getComputedStyle(caption).color));
          const bg = luminance(
            rgb(
              getComputedStyle(caption.closest(".timer-panel")!)
                .backgroundColor,
            ),
          );
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    await page.locator("#settings").click();
    expect(
      await page
        .locator("#modal")
        .evaluate((dialog) => getComputedStyle(dialog).animationDuration),
    ).toBe("0.14s");
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#subject").click();
    expect(
      await page
        .locator("#subject-popup")
        .evaluate((popup) => getComputedStyle(popup).animationName),
    ).toBe("none");
    await page.keyboard.press("Escape");
    expect(
      await page
        .locator(".ring-fill")
        .evaluate((ring) => getComputedStyle(ring).transitionDuration),
    ).toBe("0s");
    await page.locator("#primary").hover();
    await page.mouse.down();
    expect(
      await page
        .locator("#primary")
        .evaluate((button) => getComputedStyle(button).transform),
    ).toBe("none");
    await page.mouse.up();
  });
}

async function freezeFeedbackClock(page: Page) {
  await page.clock.install({ time: new Date("2026-11-07T00:00:00Z") });
  await mock(page);
  await page.clock.pauseAt(new Date("2026-11-07T00:01:00Z"));
}

test("pending locks immediately without dimming and fast confirmation never flashes", async ({
  page,
}) => {
  await freezeFeedbackClock(page);
  await page.locator("#primary").hover();
  const hoverFilter = await page
    .locator("#primary")
    .evaluate((button) => getComputedStyle(button).filter);
  await page.evaluate(() => {
    (window as any)._holdCommand = true;
  });
  await page.locator("#primary").dispatchEvent("click");
  await expect(page.locator("#primary")).toBeDisabled();
  await expect(page.locator("#primary")).toHaveCSS("opacity", "1");
  await expect(page.locator("#primary")).toHaveCSS("filter", hoverFilter);
  await page.locator("#primary").dispatchEvent("click");
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(1);
  await page.evaluate(async () => {
    const w = window as any;
    await w._update({ pending: "quick-command" });
    w._finishCommand();
  });
  await page.clock.runFor(200);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await page.evaluate(() => (window as any)._update({ pending: null }));
  await page.clock.runFor(1000);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await expect(page.locator("#primary")).toBeEnabled();
  await expect(page.locator("#banner")).toBeEmpty();
});

for (const width of [680, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`pending indicator stays in place at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 680 ? 850 : 700 });
      await freezeFeedbackClock(page);
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const motion of ["no-preference", "reduce"] as const) {
        await page.emulateMedia({ reducedMotion: motion });
        const before = await page.locator(".timer-panel").boundingBox();
        const countdownBefore = await page.locator("#countdown").boundingBox();
        const actionBefore = await page.locator("#primary").boundingBox();
        await page.evaluate(() =>
          (window as any)._update({ pending: "slow-command" }),
        );
        await page.clock.runFor(200);
        await page.evaluate(() => (window as any)._update({}));
        await page.clock.runFor(99);
        await expect(page.locator("#retry-pending")).toBeHidden();
        await page.clock.runFor(1);
        await expect(page.locator("#retry-pending")).toBeVisible();
        await expect(page.locator(".panel-heading [role=status]")).toHaveText(
          "Waiting\u2026",
        );
        expect(await page.locator(".timer-panel").boundingBox()).toEqual(
          before,
        );
        expect(await page.locator("#countdown").boundingBox()).toEqual(
          countdownBefore,
        );
        expect(await page.locator("#primary").boundingBox()).toEqual(
          actionBefore,
        );
        await expect(page.locator("#primary")).toHaveCSS("opacity", "1");
        // Protected Umum removal must remain genuinely disabled and dim.
        await expect(page.locator("#delete-subject")).toHaveCSS(
          "opacity",
          "0.42",
        );
        await page.locator("#retry-pending").dispatchEvent("click");
        expect(await page.evaluate(() => (window as any)._retryRequests)).toBe(
          motion === "reduce" ? 2 : 1,
        );
        await page.evaluate(() => (window as any)._update({ pending: null }));
        expect(await page.locator(".timer-panel").boundingBox()).toEqual(
          before,
        );
        await expect(page.locator("#retry-pending")).toBeHidden();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    });
  }
}

test("pending timers do not survive replacement, failure or confirmation", async ({
  page,
}) => {
  await freezeFeedbackClock(page);
  await page.evaluate(() =>
    (window as any)._update({ pending: "old-command" }),
  );
  await page.clock.runFor(200);
  await page.evaluate(() =>
    (window as any)._update({ pending: "replacement-command" }),
  );
  await page.clock.runFor(100);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await page.clock.runFor(200);
  await expect(page.locator("#retry-pending")).toBeVisible();
  await page.evaluate(() =>
    (window as any)._update({ connection: "disconnected" }),
  );
  await expect(page.locator("#retry-pending")).toBeDisabled();
  await expect(page.locator("#primary")).toHaveCSS("opacity", "0.42");
  await page.evaluate(() =>
    (window as any)._update({ connection: "connected" }),
  );
  await expect(page.locator("#retry-pending")).toBeEnabled();
  await page.evaluate(() =>
    (window as any)._update({ pending: null, error: "Rejected command" }),
  );
  await page.clock.runFor(1000);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await expect(page.locator("#banner")).toContainText("Rejected command");
  await page.evaluate(() =>
    (window as any)._update({ pending: "cancelled-early", error: null }),
  );
  await page.clock.runFor(100);
  await page.evaluate(() => (window as any)._update({ pending: null }));
  await page.clock.runFor(500);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await expect(page.locator("#primary")).toBeEnabled();
});

test("Settings pending keeps draft, opacity and geometry without a transient hint", async ({
  page,
}) => {
  await freezeFeedbackClock(page);
  await page.locator("#settings").dispatchEvent("click");
  await page.locator("#tick-volume").fill("250");
  // CSS entry animations use the browser timeline, not the mocked JS clock.
  await expect(page.locator("#modal")).toHaveCSS("transform", "none");
  const before = await page.locator("#modal").boundingBox();
  const volumeBefore = await page.locator("#tick-volume").boundingBox();
  await page.evaluate(() =>
    (window as any)._update({ pending: "save-settings" }),
  );
  await expect(page.locator("#preferences fieldset")).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(page.locator("#tick-volume")).toBeDisabled();
  await expect(page.locator("#preferences fieldset")).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toHaveCSS("opacity", "1");
  await expect(page.locator("#preferences-hint")).toBeHidden();
  await expect(page.locator("#tick-volume")).toHaveValue("250");
  expect(await page.locator("#modal").boundingBox()).toEqual(before);
  await page.clock.runFor(300);
  await expect(page.locator("#retry-settings-pending")).toBeVisible();
  expect(await page.locator("#modal").boundingBox()).toEqual(before);
  expect(await page.locator("#tick-volume").boundingBox()).toEqual(
    volumeBefore,
  );
  await page.locator("#retry-settings-pending").dispatchEvent("click");
  expect(await page.evaluate(() => (window as any)._retryRequests)).toBe(1);
  await page.evaluate(() =>
    (window as any)._update({ connection: "disconnected" }),
  );
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toHaveCSS("opacity", "0.42");
  await expect(page.locator("#preferences fieldset")).toHaveCSS(
    "opacity",
    "0.45",
  );
  await page.evaluate(() =>
    (window as any)._update({ pending: null, connection: "connected" }),
  );
  await expect(page.locator("#retry-settings-pending")).toBeHidden();
  await expect(page.locator("#tick-volume")).toHaveValue("250");
  await expect(page.locator("#tick-volume")).toBeEnabled();
});

test("failed IPC submission unlocks controls without delayed pending feedback", async ({
  page,
}) => {
  await freezeFeedbackClock(page);
  await page.evaluate(() => {
    (window as any)._holdCommand = true;
  });
  await page.locator("#primary").dispatchEvent("click");
  await expect(page.locator("#primary")).toBeDisabled();
  await page.evaluate(() =>
    (window as any)._finishCommand("Simulated IPC failure"),
  );
  await expect(page.locator("#primary")).toBeEnabled();
  await page.clock.runFor(1000);
  await expect(page.locator("#retry-pending")).toBeHidden();
  await expect(page.locator("#banner")).toContainText("Simulated IPC failure");
});
