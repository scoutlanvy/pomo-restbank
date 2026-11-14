import { test, expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
async function mock(page: Page, overrides: Record<string, unknown> = {}) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const bootstrap = `
import { mockIPC as _mockIPC, mockWindows as _mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
_mockWindows('main');
window._monitor={name:'Test',scaleFactor:1,position:{x:0,y:0},size:{width:1920,height:1080},workArea:{position:{x:0,y:0},size:{width:1920,height:1040}}};
window._native={maximized:false,position:{x:200,y:100},size:{width:680,height:850},minimum:{width:390,height:560},calls:[],fail:null};
function nativeIPC(cmd,args){
 const n=window._native;const key=cmd.split('|')[1];n.calls.push(key);
 if(n.fail===key){n.fail=null;throw new Error('Simulated window failure');}
 const val=args?.value?.toJSON?.();const v=val?.Physical??val?.Logical;
 switch(key){
 case 'set_theme':n.theme=args.value;return;
 case 'is_maximized':return n.maximized;
 case 'inner_size':return {...n.size};
 case 'outer_size':return {width:n.size.width+16,height:n.size.height+39};
 case 'outer_position':return {...n.position};
 case 'scale_factor':return window._monitor.scaleFactor;
 case 'available_monitors':return [window._monitor];
 case 'current_monitor':return window._monitor;
 case 'set_size':n.size={...v};return;
 case 'set_min_size':n.minimum={...v};return;
 case 'set_position':n.position={...v};return;
 case 'maximize':n.restore={size:{...n.size},position:{...n.position}};n.maximized=true;n.position={x:0,y:0};n.size={width:1904,height:1001};return;
 case 'unmaximize':n.maximized=false;if(n.restore){n.size={...n.restore.size};n.position={...n.restore.position};}return;
 default:throw new Error('Unhandled window mock '+cmd);
 }
}
window._commands=[];window._historyRequests=0;window._retryRequests=0;window._holdCommand=false;
window._view={snapshot:{state:{revision:1,tick_sequence:0,mode:'pomodoro',subject:'Umum',status:'idle',timer:null,balance_seconds:300,cycle_position:0,shared_progress:0,per_subject_progress:{},settings:{focus_scope:'shared',tick_sound:false,tick_volume:100},subjects:['Umum','English','Programming'],focus_seconds:1500,alarm_id:null},server_time_ms:Date.now(),storage_error:null,preview:false},connection:'connected',endpoint:'ws://127.0.0.1:4317/v1/ws',has_token:true,pending:null,error:null,profile:'test',preview:false,};window._defaultSnapshot=window._view.snapshot;Object.assign(window._view,${JSON.stringify(overrides)});
_mockIPC((cmd,args)=>{if(cmd.startsWith('plugin:window|'))return nativeIPC(cmd,args);if(cmd==='get_view')return window._view;if(cmd==='save_application_preferences'){window._application=args;return null;}if(cmd==='quit_application'){window._quitRequests=(window._quitRequests??0)+1;return null;}if(cmd==='initialize_local'){window._imports=(window._imports??[]);window._imports.push(args);if(window._importError)throw new Error(window._importError);return window._update({initializing:false,import_available:false,snapshot:window._defaultSnapshot,connection:'connected'});}if(cmd==='send_command'){window._commands.push(args.command);if(window._holdCommand)return new Promise((resolve,reject)=>{window._finishCommand=(error)=>error?reject(error):resolve(null);});return null;}if(cmd==='connect_server'){window._connection=args;return null;}if(cmd==='retry_pending'){window._retryRequests++;return null;}if(cmd==='request_history'){window._historyRequests++;return null;}},{shouldMockEvents:true});
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
  await expect.poll(() => page.evaluate(() => (window as any)._native.theme)).toBe("light");
  await expect(page.locator("#countdown")).toHaveText("00:25:00");
  await page.screenshot({
    path: join(tmpdir(), "pomo-restbank-ui-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect.poll(() => page.evaluate(() => (window as any)._native.theme)).toBe("dark");
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any)._native.theme)).toBe("dark");
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
  await page.locator("#settings").click();
  await page.evaluate(() => (window as any)._update({}));
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).toBeFocused();
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
  await page.locator("#balance-toggle").click();
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
  await page.locator("#balance-toggle").click();
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

async function enterCompact(page: Page) {
  await page
    .getByRole("button", { name: "Enter compact mode", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "compact");
  await page.setViewportSize({ width: 390, height: 480 });
}

test("compact details share DOM and commands, restore bounds and keep history local", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    (window as any)._timerNode = document.querySelector(".timer-face");
    (window as any)._breakNode = document.querySelector("#break-all");
  });
  const original = await page.evaluate(() => ({
    size: (window as any)._native.size,
    position: (window as any)._native.position,
  }));
  await enterCompact(page);
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.locator("#compact-details")).toBeHidden();
  await expect(page.locator("#compact-toggle")).toBeVisible();
  const bottomGap = await page.locator(".compact-footer").evaluate(
    (footer) => innerHeight - footer.getBoundingClientRect().bottom,
  );
  expect(bottomGap).toBeGreaterThanOrEqual(0);
  expect(bottomGap).toBeLessThanOrEqual(30);
  expect(await page.evaluate(() => (window as any)._native.size)).toEqual({
    width: 390,
    height: 480,
  });
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([]);
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.setViewportSize({ width: 390, height: 740 });
  await expect(page.locator("#break-all")).toBeVisible();
  await page.locator("#break-all").click();
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([
    { type: "start_break", seconds: 300 },
  ]);
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".timer-face") === (window as any)._timerNode &&
        document.querySelector("#break-all") === (window as any)._breakNode,
    ),
  ).toBe(true);
  await page.locator("#compact-history").click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
  await expect(page.locator("#history-panel")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any)._historyRequests),
  ).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => ({
      size: (window as any)._native.size,
      position: (window as any)._native.position,
    })),
  ).toEqual(original);
  await page.setViewportSize({ width: 680, height: 850 });
  await enterCompact(page);
  await expect(page.locator("#compact-details")).toBeHidden();
  await page
    .getByRole("button", { name: "Return to full view", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands)).toHaveLength(2);
  await page.reload();
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.locator("#compact-details")).toBeHidden();
});

test("compact work area clamp, DPI and maximized restore", async ({ page }) => {
  await mock(page);
  await page.evaluate(() => {
    const w = window as any;
    w._monitor.scaleFactor = 1.5;
    w._monitor.workArea = {
      position: { x: -900, y: 40 },
      size: { width: 600, height: 780 },
    };
    w._native.position = { x: -400, y: 650 };
    w._native.restore = {
      size: { width: 680, height: 850 },
      position: { x: -800, y: 90 },
    };
    w._native.maximized = true;
  });
  await enterCompact(page);
  const n = await page.evaluate(() => (window as any)._native);
  expect(n.maximized).toBe(false);
  expect(n.size).toEqual({ width: 584, height: 720 });
  expect(n.position).toEqual({ x: -900, y: 61 });
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await page.evaluate(() => (window as any)._native.size.height)).toBe(
    741,
  );
  await page
    .getByRole("button", { name: "Return to full view", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
  expect(await page.evaluate(() => (window as any)._native.maximized)).toBe(
    true,
  );
  expect(await page.evaluate(() => (window as any)._native.minimum)).toEqual({
    width: 584,
    height: 741,
  });
});

test("failed native resize rolls back without committing the view or sending commands", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    (window as any)._native.fail = "set_position";
  });
  await page.locator("#compact-toggle").click();
  await expect(page.locator("#banner")).toContainText(
    "Could not change the window layout",
  );
  await expect(page.locator(".brand")).toBeVisible();
  expect(await page.evaluate(() => (window as any)._native.size)).toEqual({
    width: 680,
    height: 850,
  });
  await enterCompact(page);
  await page.evaluate(() => {
    (window as any)._native.fail = "set_size";
  });
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#banner")).toContainText(
    "Simulated window failure",
  );
  await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(await page.evaluate(() => (window as any)._native.size)).toEqual({
    width: 390,
    height: 480,
  });
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([]);
  await page.evaluate(() => {
    (window as any)._native.fail = "set_size";
  });
  await page
    .getByRole("button", { name: "Return to full view", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "compact");
  await page
    .getByRole("button", { name: "Return to full view", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
});

test("compact keeps manual draft, closes popovers and returns keyboard focus", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    const w = window as any;
    w._view.snapshot.state.mode = "manual";
    return w._update({});
  });
  await page.getByRole("textbox", { name: "Minutes", exact: true }).fill("12");
  await page.locator("#subject").click();
  await expect(page.locator("#subject-popup")).toBeVisible();
  await enterCompact(page);
  await expect(page.locator("#subject-popup")).toBeHidden();
  await expect(page.locator("#compact-toggle")).toBeFocused();
  await expect(page.locator(".compact-subject")).toContainText(
    "Edit duration in full view",
  );
  await page.locator("#primary").click();
  expect(await page.evaluate(() => (window as any)._commands)).toEqual([
    { type: "start", seconds: 720 },
  ]);
  await page
    .getByRole("button", { name: "Return to full view", exact: true })
    .click();
  await page.setViewportSize({ width: 680, height: 850 });
  await expect(
    page.getByRole("textbox", { name: "Minutes", exact: true }),
  ).toHaveValue("12");
});

for (const theme of ["light", "dark"] as const) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    test(`compact visual, details, focus and pending ${theme}/${reducedMotion}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await freezeFeedbackClock(page);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await enterCompact(page);
      for (const details of [false, true]) {
        if (details) {
          await page.locator("#compact-detail-toggle").click();
          await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
            "aria-expanded",
            "true",
          );
          await page.setViewportSize({ width: 390, height: 740 });
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await page
            .locator("#compact-detail-toggle")
            .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
        ).toBe(true);
        const before = await page.locator(".timer-face").boundingBox();
        await page.evaluate(() =>
          (window as any)._update({ pending: "compact-command" }),
        );
        await page.clock.runFor(299);
        await expect(page.locator("#retry-pending")).toBeHidden();
        await page.clock.runFor(1);
        await expect(page.locator("#retry-pending")).toBeVisible();
        expect(await page.locator(".timer-face").boundingBox()).toEqual(before);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator("#primary")).toHaveCSS("opacity", "1");
        await page.evaluate(() => (window as any)._update({ pending: null }));
        const artifacts = join(tmpdir(), "pomo-compact-evidence-c94a");
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: join(
            artifacts,
            `pomo-compact-${theme}-${reducedMotion}-${details}.png`,
          ),
          fullPage: true,
        });
      }
      await page.locator("#compact-detail-toggle").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(page.locator("#compact-detail-toggle")).toBeFocused();
      await page.evaluate(() =>
        (window as any)._update({ connection: "disconnected" }),
      );
      await expect(page.locator("#primary")).toBeDisabled();
      await expect(page.locator("#estimate")).toContainText(
        "waiting for server",
      );
      await page.evaluate(() =>
        (window as any)._update({ connection: "connected" }),
      );
      await expect(page.locator("#primary")).toBeEnabled();
      await page.locator("#settings").click();
      await page.locator("#tick-volume").fill("250");
      await page.evaluate(() =>
        (window as any)._update({ pending: "settings-command" }),
      );
      await page.clock.runFor(300);
      await expect(page.locator("#retry-settings-pending")).toBeVisible();
      await expect(page.locator("#tick-volume")).toHaveValue("250");
      await page.keyboard.press("Escape");
      await expect(page.locator("#settings")).toBeFocused();
    });
  }
}

test("compact default height fits without scrolling and smaller windows can scroll", async ({ page }) => {
  await mock(page);
  await enterCompact(page);
  const measure = () => page.evaluate(() => ({
    height: innerHeight,
    content: document.documentElement.scrollHeight,
  }));
  const bounds = await measure();
  expect(bounds, JSON.stringify(bounds)).toMatchObject({ content: bounds.height });
  await page.setViewportSize({ width: 360, height: 400 });
  expect((await measure()).content).toBeGreaterThan(400);
});

test("compact reflects every timer state and preserves break and storage restrictions", async ({
  page,
}) => {
  await mock(page);
  await enterCompact(page);
  const states = [
    ["idle", "focus", "Start focus"],
    ["running", "focus", "Pause"],
    ["paused", "focus", "Resume"],
    ["choice", "focus", "Continue Focus"],
    ["alarm", "focus", "Stop Alarm"],
    ["running", "break", "Pause"],
    ["paused", "break", "Resume"],
    ["alarm", "break", "Stop Alarm"],
    ["running", "manual", "Pause"],
    ["paused", "manual", "Resume"],
    ["alarm", "manual", "Stop Alarm"],
  ];
  for (const [status, phase, label] of states) {
    await page.evaluate(
      ({ status, phase }) => {
        const w = window as any;
        const s = w._view.snapshot.state;
        s.status = status;
        s.mode = phase === "manual" ? "manual" : "pomodoro";
        s.timer =
          status === "idle" || status === "choice"
            ? null
            : {
                phase,
                total_seconds: 1500,
                remaining_seconds: 1085,
                subject: "Umum",
                suspended_focus: null,
                return_to_choice: false,
              };
        s.subject = "A".repeat(100);
        s.revision++;
        return w._update({});
      },
      { status, phase },
    );
    await expect(page.locator("#primary")).toContainText(label);
    await page.locator("#primary").click();
    const action = (
      {
        idle: "start",
        running: "pause",
        paused: "resume",
        choice: "continue_focus",
        alarm: "stop_alarm",
      } as Record<string, string>
    )[status];
    expect(
      await page.evaluate(() => (window as any)._commands.at(-1).type),
    ).toBe(action);
    if (phase === "break") {
      await expect(page.locator("#skip")).toBeVisible();
      if (status === "running") {
        await page.locator("#skip").click();
        expect(
          await page.evaluate(() => (window as any)._commands.at(-1).type),
        ).toBe("skip_break");
      } else await expect(page.locator("#skip")).toBeDisabled();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#break-all")).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w._view.snapshot.storage_error = "Test storage error";
    return w._update({});
  });
  await expect(page.locator("#banner")).toContainText("Test storage error");
  await expect(page.locator("#primary")).toBeDisabled();
  await page.locator("#retry-storage").click();
  expect(await page.evaluate(() => (window as any)._commands.at(-1).type)).toBe(
    "retry_storage",
  );
});

test("compact fractional DPI uses integer physical pixels and small screens scroll only vertically", async ({
  page,
}) => {
  await mock(page);
  await page.evaluate(() => {
    (window as any)._monitor.scaleFactor = 1.25;
  });
  await enterCompact(page);
  expect(await page.evaluate(() => (window as any)._native.size)).toEqual({
    width: 488,
    height: 600,
  });
  await page.setViewportSize({ width: 360, height: 400 });
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#compact-detail-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator("#compact-history").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight > innerHeight,
    ),
  ).toBe(true);
  await page.locator("#compact-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
});


test("Local settings hide connection credentials and persist backend/close preferences", async ({page}) => {
  await mock(page, {backend:"local",next_backend:"local",close_behavior:"tray"});
  await expect(page.locator("#connection-status")).toContainText("Local");
  await page.locator("#settings").click();
  await expect(page.getByRole("textbox", {name:"Server address"})).toBeHidden();
  await expect(page.locator("#close-behavior")).toHaveValue("tray");
  await page.locator("#backend-mode").selectOption("server");
  await page.locator("#close-behavior").selectOption("quit");
  await page.getByRole("button",{name:"Save application settings",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=> (window as any)._application)).toEqual({backend:"server",closeBehavior:"quit"});
  await page.evaluate(()=> (window as any)._update({next_backend:"server",close_behavior:"quit"}));
  await expect(page.locator("#mode-status")).toContainText("Quit application");
  await page.getByRole("button",{name:"Quit application",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=> (window as any)._quitRequests)).toBe(1);
});

test("Mode switch locks while running/pending but close preference remains available", async ({page}) => {
  await mock(page,{backend:"local",next_backend:"local"});
  await page.evaluate(()=> {const w=window as any;return w._update({snapshot:{...w._view.snapshot,state:{...w._view.snapshot.state,status:'running'}}});});
  await page.locator("#settings").click();
  await expect(page.locator("#backend-mode")).toBeDisabled();
  await expect(page.locator("#close-behavior")).toBeEnabled();
  await page.evaluate(()=> (window as any)._update({connection:'disconnected',pending:null,backend:'server'}));
  await expect(page.locator("#backend-mode")).toBeEnabled();
  await page.evaluate(()=> (window as any)._update({pending:'in-flight'}));
  await expect(page.locator("#backend-mode")).toBeDisabled();
});

test("First Local launch imports once and retries a busy source without losing the choice", async ({page}) => {
  await mock(page,{backend:"local",next_backend:"local",initializing:true,import_available:true,snapshot:null,connection:'disconnected'});
  await expect(page.getByRole('heading',{name:'Start your Local timer'})).toBeVisible();
  await page.evaluate(()=> (window as any)._importError='Stop the source server, then Retry.');
  await page.getByRole('button',{name:'Import existing data',exact:true}).click();
  await expect(page.locator('#dialog-error')).toContainText('Stop the source server');
  await expect(page.getByRole('button',{name:'Retry import',exact:true})).toBeEnabled();
  await page.evaluate(()=> (window as any)._importError=null);
  await page.getByRole('button',{name:'Retry import',exact:true}).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  await expect(page.locator('#primary')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=> (window as any)._imports)).toEqual([{import:true},{import:true}]);
});

test("Cancel Local setup quits without initializing a database", async ({page}) => {
  await mock(page,{backend:"local",initializing:true,import_available:true,snapshot:null,connection:'disconnected'});
  await page.getByRole('button',{name:'Cancel and quit',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=> (window as any)._quitRequests)).toBe(1);
  expect(await page.evaluate(()=> (window as any)._imports)).toBeUndefined();
});


test("centered full view fits and balance disclosure preserves timer state", async ({ page }) => {
  await mock(page);
  for (const size of [{width:1440,height:830},{width:680,height:850}]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
  await expect(page.locator('.stat-grid')).toBeHidden();
  await expect(page.locator('#timer-settings')).toHaveCount(0);
  await page.locator('#balance-toggle').click();
  await expect(page.locator('#break-all')).toBeVisible();
  expect(await page.evaluate(() => (window as any)._commands.length)).toBe(0);
  await page.evaluate(() => { (window as any)._view.snapshot.state.balance_seconds=120; return (window as any)._update({}); });
  await expect(page.locator('#break-all')).toContainText('00:02:00');
  await expect(page.locator('#balance-toggle')).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#break-all')).toBeHidden();
  await page.locator('#balance-toggle').click();
  await page.evaluate(() => (window as any)._update({connection:'disconnected'}));
  await expect(page.locator('#balance-toggle')).toBeDisabled();
  await expect(page.locator('#break-all')).toBeHidden();
});


test("balance menu matches trigger with compact rows and correct text", async ({ page }) => {
  await mock(page);
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme=theme,theme);
    for (const width of [390,680]) {
      await page.setViewportSize({width,height:850});
      await page.locator('#balance-toggle').click();
      await expect(page.locator('#break-all')).toHaveText('Use all \u00b7 00:05:00');
      await expect(page.locator('#break-choose')).toHaveText('Choose duration\u2026');
      const trigger = await page.locator('#balance-toggle').boundingBox();
      const menu = await page.locator('#balance-menu').boundingBox();
      expect(Math.abs(trigger!.width-menu!.width)).toBeLessThanOrEqual(1);
      expect(menu!.height).toBeLessThanOrEqual(96);
      if (theme === 'dark' && width === 680) await page.screenshot({path:join(tmpdir(),'pomo-dropdown-refined.png')});
      expect(menu!.x).toBeGreaterThanOrEqual(0);
      expect(menu!.x+menu!.width).toBeLessThanOrEqual(width);
      await page.locator('#break-all').focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('#break-choose')).toBeFocused();
      await page.keyboard.press('Escape');
      await page.locator('#balance-toggle').focus();
      await expect(page.locator('#balance-toggle')).toHaveCSS('outline-width','2px');
    }
  }
});


test("compact History previews three sessions, fits content, and refreshes only when needed", async ({ page }) => {
  await mock(page);
  await enterCompact(page);
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#compact-history-list")).toContainText("Loading your sessions");
  const sendHistory = async (count: number) => page.evaluate(async (count) => {
    const sessions = Array.from({ length: count }, (_, i) => ({ subject: i === 0 ? '<Subject> ' + 'Long name '.repeat(20) : `Subject ${i}`, recorded_at: '2026-11-14T00:00:00Z', mode: 'pomodoro', duration_seconds: 1500 }));
    await (window as any).__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'restbank:history', payload: { type: 'history', sessions, summary: [] } });
  }, count);
  await sendHistory(0);
  await expect(page.locator("#compact-history-list")).toHaveText("No sessions yet.");
  await expect.poll(() => page.evaluate(() => (window as any)._native.size.height)).toBeLessThan(740);
  const emptyHeight = await page.evaluate(() => (window as any)._native.size.height);
  await sendHistory(1);
  await expect(page.locator("#compact-history-list .history-row")).toHaveCount(1);
  await sendHistory(5);
  await expect(page.locator("#compact-history-list .history-row")).toHaveCount(3);
  await expect(page.locator("#compact-history-list .history-row").first()).toContainText('<Subject>');
  await expect(page.locator("#compact-history-list .history-row").first()).toContainText('07:00');
  await expect(page.locator("#compact-history-list .history-row").first()).toContainText('25m 00s');
  await expect(page.locator("#compact-history-list subject")).toHaveCount(0);
  await expect(page.getByText("Focus target", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any)._native.size.height)).toBeGreaterThan(emptyHeight);
  const height = await page.evaluate(() => (window as any)._native.size.height);
  await page.setViewportSize({ width: 390, height });
  await expect.poll(() => page.locator("#compact-details").evaluate(el => innerHeight - el.getBoundingClientRect().bottom)).toBe(16);
  await page.screenshot({ path: join(tmpdir(), "pomo-restbank-history-preview-light.png"), fullPage: true });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#theme")!.click());
  await page.screenshot({ path: join(tmpdir(), "pomo-restbank-history-preview-dark.png"), fullPage: true });
  await page.locator("#compact-history").focus();
  const requests = await page.evaluate(() => (window as any)._historyRequests);
  const resizes = await page.evaluate(() => (window as any)._native.calls.filter((c: string) => c === 'set_size').length);
  await page.evaluate(async () => { const w = window as any; w._view.snapshot.state.tick_sequence++; await w._update({}); });
  await expect(page.locator("#compact-history")).toBeFocused();
  expect(await page.evaluate(() => (window as any)._historyRequests)).toBe(requests);
  expect(await page.evaluate(() => (window as any)._native.calls.filter((c: string) => c === 'set_size').length)).toBe(resizes);
  await page.evaluate(async () => { const w = window as any; w._view.snapshot.state.revision++; await w._update({}); });
  await expect.poll(() => page.evaluate(() => (window as any)._historyRequests)).toBe(requests + 1);
  await page.evaluate(() => (window as any)._update({ connection: 'disconnected' }));
  await expect(page.locator("#compact-history-list")).toContainText("Reconnect");
  await page.evaluate(() => (window as any)._update({ connection: 'connected' }));
  await expect.poll(() => page.evaluate(() => (window as any)._historyRequests)).toBe(requests + 2);
  await page.evaluate(() => (window as any)._update({ endpoint: 'ws://127.0.0.1:4318/v1/ws' }));
  await expect.poll(() => page.evaluate(() => (window as any)._historyRequests)).toBe(requests + 3);
  await expect(page.locator("#compact-history-list")).toContainText("Loading your sessions");
  await sendHistory(5);
  await expect(page.locator("#compact-history-list .history-row")).toHaveCount(3);
  await page.locator("#compact-history").click();
  await expect(page.locator("html")).toHaveAttribute("data-layout", "full");
  await expect(page.locator('[data-tab="recent"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator("#history-list .history-row")).toHaveCount(5);
});


test("automatic Details fitting preserves a manually resized window width", async ({ page }) => {
  await mock(page);
  await enterCompact(page);
  await page.locator("#compact-detail-toggle").click();
  await expect(page.locator("#compact-history-list")).toContainText("Loading");
  await expect.poll(() => page.evaluate(() => (window as any)._native.size.height)).not.toBe(600);
  await page.evaluate(() => { (window as any)._native.size.width = 360; });
  await page.setViewportSize({ width: 360, height: 700 });
  await page.evaluate(async () => (window as any).__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'restbank:history', payload: { type: 'history', sessions: [{ subject: 'Umum', recorded_at: '2026-11-14T00:00:00Z', duration_seconds: 1500, mode: 'pomodoro' }], summary: [] } }));
  await expect(page.locator("#compact-history-list .history-row")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any)._native.size.width)).toBe(360);
  await expect.poll(() => page.locator("#compact-toggle").isEnabled()).toBe(true);
});
