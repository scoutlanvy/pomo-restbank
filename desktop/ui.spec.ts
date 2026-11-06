import { test, expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function mock(page: Page, overrides: Record<string, unknown> = {}) {
  await page.route("**/src/main.ts*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const bootstrap = `
import { mockIPC as _mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
window._commands=[];
window._view={snapshot:{state:{revision:1,tick_sequence:0,mode:'pomodoro',subject:'Umum',status:'idle',timer:null,balance_seconds:300,cycle_position:0,shared_progress:0,per_subject_progress:{},settings:{focus_scope:'shared',tick_sound:false,tick_volume:100},subjects:['Umum','English','Programming'],focus_seconds:1500,alarm_id:null},server_time_ms:Date.now(),storage_error:null,preview:false},connection:'connected',endpoint:'ws://127.0.0.1:4317/v1/ws',has_token:true,pending:null,error:null,profile:'test',preview:false,...${JSON.stringify(overrides)}};
_mockIPC((cmd,args)=>{if(cmd==='get_view')return window._view;if(cmd==='send_command'){window._commands.push(args.command);return null;}if(cmd==='connect_server'){window._connection=args;return null;}if(cmd==='request_history'){return null;}},{shouldMockEvents:true});
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
