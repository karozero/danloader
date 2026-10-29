import { setLanguage, type Language } from "./language.js";

/** Native emoji flags are not available on Windows; use local SVGs for every option. */
export function mountLanguagePicker(
  initial: Language,
  onChange: (language: Language) => Promise<void>,
  onError: (message: string) => void,
): void {
  const root = document.getElementById("language-picker")!;
  const toggle = document.getElementById(
    "language-toggle",
  ) as HTMLButtonElement;
  const menu = document.getElementById("language-options")!;
  const flag = document.getElementById("language-flag") as HTMLImageElement;
  const label = document.getElementById("language-name")!;
  const options = [
    ...menu.querySelectorAll<HTMLButtonElement>("[data-language]"),
  ];
  let selected: Language = initial;
  let pending = false;
  function update(): void {
    root.dataset.language = selected;
    flag.src = "assets/flags/" + selected + ".svg";
    label.textContent = selected.toUpperCase();
    for (const option of options)
      option.setAttribute(
        "aria-selected",
        String(option.dataset.language === selected),
      );
  }
  function close(focus = false): void {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (focus) toggle.focus();
  }
  function open(): void {
    if (pending) return;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    options.find((option) => option.dataset.language === selected)?.focus();
  }
  // Keep the focused option until click: an intermediate blur must not close and reopen the menu.
  toggle.onpointerdown = (event) => {
    if (event.button === 0) event.preventDefault();
  };
  toggle.onclick = () => (menu.hidden ? open() : close(true));
  toggle.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    }
  };
  for (const option of options)
    option.onclick = async () => {
      if (pending) return;
      const next = option.dataset.language;
      if (next !== "ru" && next !== "en") return;
      close(true);
      if (next === selected) return;
      pending = true;
      toggle.disabled = true;
      try {
        await setLanguage(next);
        selected = next;
        update();
        await onChange(next);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        pending = false;
        toggle.disabled = false;
        toggle.focus();
      }
    };
  menu.onkeydown = (event) => {
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
              options.length;
      options[next].focus();
    }
  };
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener("focusout", () =>
    queueMicrotask(() => {
      if (!root.contains(document.activeElement)) close();
    }),
  );
  update();
}
