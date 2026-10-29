import {
  currentDestination,
  selectDirectory,
  useBrowserDirectory,
} from "../infrastructure/destination-store.js";
import { t } from "./language.js";

export function mountDestinationPicker(onError: (message: string) => void): {
  refresh: () => Promise<void>;
} {
  const name = document.getElementById("destination-name")!;
  const downloads = document.getElementById(
    "browser-destination",
  ) as HTMLButtonElement;
  const choose = document.getElementById(
    "choose-destination",
  ) as HTMLButtonElement;
  let pending = false;
  let custom = false;
  let needsAccess = false;
  let ready = false;
  function updateDisabled(): void {
    downloads.disabled = !ready || pending || !custom;
    choose.disabled = !ready || pending || (custom && !needsAccess);
  }
  async function refresh(): Promise<void> {
    const value = await currentDestination();
    custom = value.mode === "directory";
    needsAccess = value.mode === "directory" && value.permission !== "granted";
    name.textContent =
      value.mode === "directory" ? value.name : t("Папка загрузок браузера");
    name.title =
      value.mode === "directory"
        ? value.name
        : t("Папка, указанная в настройках браузера");
    downloads.textContent = t("Загрузки");
    choose.textContent = t("Выбрать");
    choose.title = needsAccess ? t("Разрешить доступ…") : t("Выбрать папку");
    downloads.classList.toggle("selected-destination", !custom);
    choose.classList.toggle("selected-destination", custom && !needsAccess);
    choose.classList.toggle("needs-access", needsAccess);
    downloads.setAttribute("aria-pressed", String(!custom));
    choose.setAttribute("aria-pressed", String(custom));
    ready = true;
    updateDisabled();
  }
  async function changed(): Promise<void> {
    await refresh();
    const response = await chrome.runtime.sendMessage({
      target: "destination",
      action: "changed",
    });
    if (!response?.ok)
      throw new Error(response?.error || t("Сервис недоступен."));
  }
  function busy(value: boolean): void {
    pending = value;
    updateDisabled();
  }
  choose.onclick = async () => {
    if (choose.disabled || pending) return;
    onError("");
    busy(true);
    try {
      if (typeof window.showDirectoryPicker !== "function")
        throw new Error(t("Этот браузер не поддерживает выбор папки."));
      // Do not await storage or messaging before this call: the picker needs the original user activation.
      const handle = await window.showDirectoryPicker({
        id: "dan-video-save-directory",
        mode: "readwrite",
        startIn: "downloads",
      });
      await selectDirectory(handle);
      await changed();
    } catch (error) {
      if (error?.name !== "AbortError")
        onError(error instanceof Error ? error.message : String(error));
    } finally {
      busy(false);
      await refresh().catch((error) => onError(error.message));
    }
  };
  downloads.onclick = async () => {
    if (pending) return;
    onError("");
    busy(true);
    try {
      await useBrowserDirectory();
      await changed();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      busy(false);
      await refresh().catch((error) => onError(error.message));
    }
  };
  updateDisabled();
  return { refresh };
}
