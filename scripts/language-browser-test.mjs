import fs from "node:fs/promises";
import { launch } from "./cdp.mjs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "..");
const browser = await launch(root);
try {
  const { id } = await browser.send("Extensions.loadUnpacked", {
    path: path.join(root, "dist"),
  });
  const base = "chrome-extension://" + id;
  const page = await browser.page(base + "/popup.html");
  await new Promise((r) => setTimeout(r, 700));
  const evaluate = (expression) => browser.evaluate(page.sessionId, expression);
  const read = () =>
    evaluate(
      `({language:document.documentElement.lang,selected:document.querySelector('#language-picker').dataset.language,clear:document.querySelector('#clear').title,footer:document.querySelector('.credits').textContent,href:document.querySelector('.credits a').href,overflow:document.body.scrollWidth>document.body.clientWidth,button:document.querySelector('#language-toggle').tagName,arrow:getComputedStyle(document.querySelector('#language-toggle'),'::after').content,flag:document.querySelector('#language-flag').getAttribute('src'),flagLoaded:document.querySelector('#language-flag').naturalWidth>0,options:[...document.querySelectorAll('#language-options button')].map(o=>o.textContent.trim()),order:[...document.querySelector('.header-actions').children].map(x=>x.id||x.className)})`,
    );
  const initial = await read();
  const device = await evaluate("chrome.i18n.getUILanguage()");
  assert.equal(initial.language, /^ru(?:-|$)/i.test(device) ? "ru" : "en");
  assert.equal(initial.button, "BUTTON");
  assert.equal(initial.arrow, "none");
  assert.equal(initial.flagLoaded, true);
  assert.deepEqual(initial.options, ["RU", "EN"]);
  assert.deepEqual(initial.order, [
    "refresh",
    "clear",
    "header-divider",
    "language-picker",
  ]);
  const toggleBounds = await evaluate(
    `(()=>{const r=document.querySelector('#language-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  async function pointerClick() {
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...toggleBounds },
      page.sessionId,
    );
    await browser.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...toggleBounds },
      page.sessionId,
    );
  }
  await pointerClick();
  assert.equal(
    await evaluate(`document.querySelector('#language-options').hidden`),
    false,
  );
  await pointerClick();
  assert.equal(
    await evaluate(`document.querySelector('#language-options').hidden`),
    true,
  );
  const keyboard = await evaluate(
    `(()=>{const button=document.querySelector('#language-toggle'),menu=document.querySelector('#language-options');button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));const opened=!menu.hidden&&menu.contains(document.activeElement);menu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));const focused=document.activeElement.dataset.language;menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {opened,focused,closed:menu.hidden&&document.activeElement===button};})()`,
  );
  assert.equal(keyboard.opened, true);
  assert.equal(keyboard.closed, true);
  assert.equal(keyboard.focused, initial.language === "ru" ? "en" : "ru");
  for (const language of [
    initial.language === "ru" ? "en" : "ru",
    "en",
    "ru",
  ]) {
    await evaluate(
      `document.querySelector('#language-toggle').click();document.querySelector('#language-options [data-language="${language}"]').click()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const state = await read();
    assert.equal(state.language, language);
    assert.equal(state.selected, language);
    assert.equal(state.overflow, false);
    assert.equal(state.flagLoaded, true);
    assert.equal(state.flag, "assets/flags/" + language + ".svg");
    assert.equal(
      state.clear,
      language === "ru" ? "Очистить завершённые" : "Clear completed",
    );
    assert.equal(state.href, "https://github.com/karozero/danloader");
    assert.ok(state.footer.includes("github.com/karozero/danloader"));
    assert.ok(!state.footer.includes("https://"));
    assert.ok(
      state.footer.startsWith(language === "ru" ? "Сделал" : "Made by"),
    );
    const saved = await evaluate(
      `chrome.storage.local.get('danloader.language')`,
    );
    assert.equal(saved["danloader.language"], language);
    console.log(JSON.stringify(state));
  }
  const reopened = await browser.page(base + "/popup.html");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    await browser.evaluate(
      reopened.sessionId,
      `document.querySelector('#language-picker').dataset.language`,
    ),
    "ru",
  );
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 440, height: 600, deviceScaleFactor: 1, mobile: false },
    page.sessionId,
  );
  const screenshot = await browser.send(
    "Page.captureScreenshot",
    { format: "png" },
    page.sessionId,
  );
  await fs.mkdir(path.join(root, "test-output"), { recursive: true });
  await fs.writeFile(
    path.join(root, "test-output/language-popup.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  console.log(
    "Language defaults, SVG flags, keyboard, switching, persistence, header order and footer passed.",
  );
} finally {
  await browser.close();
}
