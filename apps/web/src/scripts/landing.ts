document.querySelectorAll<HTMLDetailsElement>("[data-mobile-nav]").forEach((menu) => {
  menu.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) menu.open = false;
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
});

document.querySelectorAll<HTMLElement>("[data-code-tabs]").forEach((group) => {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...group.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  const select = (tab: HTMLButtonElement) => {
    tabs.forEach((item) => {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    });
  };
  if (tabs.length) select(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0]);
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(tabs[next]);
      tabs[next].focus();
    });
  });
});

async function copyText(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Older browsers and restricted contexts may still allow a native copy.
    }
  }
  const previousFocus = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-copy], [data-copy-target]").forEach((button) => {
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  const originalLabel = label?.textContent || "Copy";
  let reset: ReturnType<typeof setTimeout>;
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    clearTimeout(reset);
    delete button.dataset.copyState;
    button.disabled = true;
    const status = document.getElementById("copy-status");
    if (status) status.textContent = "";
    try {
      const text = button.dataset.copyTarget
        ? document.getElementById(button.dataset.copyTarget)?.textContent
        : button.dataset.copy;
      if (!text) throw new Error("Nothing to copy");
      await copyText(text);
      button.dataset.copyState = "copied";
      if (label) label.textContent = "Copied";
      if (status) status.textContent = "Copied to clipboard.";
    } catch {
      button.dataset.copyState = "error";
      if (label) label.textContent = "Try again";
      if (status) status.textContent = "Could not copy. Try again or select the code to copy it manually.";
    } finally {
      button.disabled = false;
      reset = setTimeout(() => {
        delete button.dataset.copyState;
        if (label) label.textContent = originalLabel;
      }, 2000);
    }
  });
});

const hero = document.querySelector<HTMLElement>("[data-hero-motion]");
const motionAllowed = window.matchMedia("(prefers-reduced-motion: no-preference)");
if (hero && "IntersectionObserver" in window) {
  const toggle = hero.querySelector<HTMLButtonElement>("[data-globe-toggle]");
  let visible = false;
  let userPaused = false;
  const update = () => {
    hero.dataset.motion = motionAllowed.matches ? "running" : "static";
    hero.dataset.paused = String(!motionAllowed.matches || !visible || document.hidden || userPaused);
    if (toggle) toggle.hidden = !motionAllowed.matches;
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    update();
  });
  toggle?.addEventListener("click", () => {
    userPaused = !userPaused;
    toggle.setAttribute("aria-pressed", String(userPaused));
    toggle.setAttribute("aria-label", userPaused ? "Resume globe animation" : "Pause globe animation");
    update();
  });
  motionAllowed.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  observer.observe(hero);
  update();
}
