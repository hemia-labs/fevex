// Run with: bun apps/web/scripts/check-landing.mjs
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const source = await Bun.file(new URL("../src/scripts/landing.ts", import.meta.url)).text();
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source);

function page({ allowed = true } = {}) {
  const node = (props = {}) => ({
    dataset: {}, style: {}, attributes: {}, listeners: {}, children: {}, textContent: "",
    addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { this.listeners[type]?.delete(fn); },
    async fire(type, props = {}) {
      const event = { target: this, preventDefault() {}, ...props };
      await Promise.all([...this.listeners[type] || []].map((fn) => fn(event)));
    },
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return this.children[selector]?.[0] || null; },
    querySelectorAll(selector) { return this.children[selector] || []; },
    matches(selector) { return selector === this.selector; },
    closest(selector) { return this.matches(selector) ? this : null; },
    focus() { document.activeElement = this; },
    select() {}, remove() { this.removed = true; },
    ...props,
  });
  const document = node({ hidden: false, activeElement: null });
  const summary = node();
  const nav = node({ open: true, children: { summary: [summary] } });
  const tabs = [0, 1, 2].map((i) => node({ attributes: { "aria-controls": `panel-${i}` } }));
  const panels = [0, 1, 2].map((i) => node({ id: `panel-${i}` }));
  const group = node({ children: { '[role="tab"]': tabs, '[role="tabpanel"]': panels } });
  const label = node({ textContent: "Copy" });
  const copy = node({ dataset: { copyTarget: "example-code" }, children: { "[data-copy-label]": [label] } });
  const status = node();
  const code = node({ textContent: "private example code" });
  const toggle = node();
  const hero = node({ children: { "[data-globe-toggle]": [toggle] } });
  const media = node({ matches: allowed });
  const navigator = { clipboard: undefined };
  let observer;
  let nativeCopySucceeds = false;
  let textarea;
  document.children = {
    "[data-mobile-nav]": [nav], "[data-code-tabs]": [group],
    "[data-copy], [data-copy-target]": [copy], "[data-hero-motion]": [hero],
  };
  document.getElementById = (id) => ({ "copy-status": status, "example-code": code })[id];
  document.createElement = () => (textarea = node());
  document.body = { append() {} };
  document.execCommand = () => nativeCopySucceeds;
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  runInNewContext(script, {
    document, navigator, IntersectionObserver,
    window: { matchMedia: () => media, IntersectionObserver },
    setTimeout: () => 1, clearTimeout() {},
  });
  return {
    document, nav, summary, tabs, panels, copy, label, status, hero, toggle, media, navigator, observer,
    node, get textarea() { return textarea; },
    /** @param {boolean} value */
    set nativeCopySucceeds(value) { nativeCopySucceeds = value; },
  };
}

const p = page();
await p.tabs[0].fire("keydown", { key: "ArrowLeft" });
assert.equal(p.document.activeElement, p.tabs[2], "Left wraps and moves focus");
assert.deepEqual(p.tabs.map((tab) => tab.tabIndex), [-1, -1, 0]);
assert.deepEqual(p.panels.map((panel) => panel.hidden), [true, true, false]);
await p.tabs[2].fire("keydown", { key: "Home" });
assert.equal(p.tabs[0].getAttribute("aria-selected"), "true");
await p.tabs[1].fire("click");
assert.equal(p.panels[1].hidden, false);
await p.nav.fire("keydown", { key: "Escape" });
assert.equal(p.nav.open, false);
assert.equal(p.document.activeElement, p.summary);
p.nav.open = true;
await p.nav.fire("click", { target: p.node({ selector: "a" }) });
assert.equal(p.nav.open, false);

await p.copy.fire("click");
assert.equal(p.label.textContent, "Try again", "Native copy failure must not announce success");
assert.equal(p.copy.dataset.copyState, "error");
assert.equal(p.copy.disabled, false, "Failed copy permits retry");
assert.equal(p.textarea.removed, true);
assert.equal(p.textarea.value, "private example code");
p.navigator.clipboard = { writeText: async () => { throw new Error("Permission denied"); } };
p.nativeCopySucceeds = true;
await p.copy.fire("click");
assert.equal(p.label.textContent, "Copied", "A successful native fallback is accepted");
assert.equal(p.copy.dataset.copyState, "copied");
assert.equal(p.status.textContent, "Copied to clipboard.");

p.observer.callback([{ isIntersecting: true }]);
assert.equal(p.hero.dataset.motion, "running");
p.document.hidden = true;
await p.document.fire("visibilitychange");
assert.equal(p.hero.dataset.paused, "true");
p.document.hidden = false;
await p.document.fire("visibilitychange");
assert.equal(p.hero.dataset.paused, "false");
p.observer.callback([{ isIntersecting: false }]);
assert.equal(p.hero.dataset.paused, "true", "Offscreen animation pauses");
p.observer.callback([{ isIntersecting: true }]);
await p.toggle.fire("click");
assert.equal(p.hero.dataset.paused, "true", "User can pause continuous motion");
assert.equal(p.toggle.getAttribute("aria-label"), "Resume globe animation");
p.document.hidden = true;
await p.document.fire("visibilitychange");
p.document.hidden = false;
await p.document.fire("visibilitychange");
assert.equal(p.hero.dataset.paused, "true", "Visibility must preserve user pause");
await p.toggle.fire("click");
assert.equal(p.hero.dataset.paused, "false");
assert.equal(p.toggle.getAttribute("aria-pressed"), "false");
const reduced = page({ allowed: false });
assert.equal(reduced.hero.dataset.motion, "static", "Reduced motion stays static");
assert.equal(reduced.toggle.hidden, true);
const changed = page();
changed.observer.callback([{ isIntersecting: true }]);
changed.media.matches = false;
await changed.media.fire("change");
assert.equal(changed.hero.dataset.motion, "static", "Preference changes stop animation");
assert.equal(changed.hero.dataset.paused, "true");
changed.media.matches = true;
await changed.media.fire("change");
assert.equal(changed.hero.dataset.motion, "running");
assert.equal(changed.hero.dataset.paused, "false");
console.log("Landing checks passed: tabs, navigation, clipboard failure/retry, globe pause, visibility and reduced motion.");
