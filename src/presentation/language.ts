export type Language = "ru" | "en";
const storageKey = "danloader.language";
const english: Readonly<Record<string, string>> = {
  "Качай всё, что надо, без ограничений":
    "Download everything you need, without limits",
  "Обновить список": "Refresh list",
  "Очистить завершённые": "Clear completed",
  Язык: "Language",
  Загрузки: "Downloads",
  Выбрать: "Choose",
  "Выбрать папку": "Choose folder",
  "Этот браузер не поддерживает выбор папки.":
    "This browser does not support choosing a folder.",
  "Место сохранения для всех видео": "Save location for all videos",
  "Сохранять в": "Save to",
  "Папка загрузок браузера": "Browser downloads folder",
  "Выбрать папку…": "Choose folder…",
  "Включите воспроизведение, чтобы обнаружить потоки.":
    "Play a video to detect its streams.",
  Скачивания: "Downloads",
  "Найденные видео": "Detected videos",
  "Ищем видео…": "Looking for videos…",
  "Сделал Dan Shulgin — ": "Made by Dan Shulgin — ",
  "В очереди": "Queued",
  Подготовка: "Preparing",
  Скачивание: "Downloading",
  Объединение: "Merging",
  Сохранение: "Saving",
  Готово: "Done",
  Ошибка: "Error",
  Отменено: "Cancelled",
  "Видео пока не найдено. Запустите его на странице и обновите список.":
    "No videos found yet. Play a video and refresh the list.",
  "Обложка видео": "Video thumbnail",
  "Качество видео": "Video quality",
  Недоступно: "Unavailable",
  "Загрузка…": "Loading…",
  Исходное: "Original",
  "Ошибка разбора": "Parsing failed",
  "Ожидание разбора": "Waiting to parse",
  "Загрузка качеств…": "Loading qualities…",
  "Получить доступные качества": "Refresh available qualities",
  Качество: "Quality",
  Контейнер: "Container",
  Формат: "Format",
  "Текущий Reel": "Current Reel",
  "Включите воспроизведение со звуком, чтобы обнаружить аудиодорожку.":
    "Play with sound to detect the audio track.",
  Видео: "Video",
  "Имя файла": "Filename",
  Скачать: "Download",
  "Пока не найдена аудиодорожка.": "Audio track not detected yet.",
  "Ожидается разбор качеств.": "Waiting for qualities.",
  "Нет доступных ссылок для скачивания.": "No download links available.",
  "Добавить скачивание в общую очередь": "Add download to queue",
  "Скачать видео": "Download video",
  "Другая вкладка: ": "Other tab: ",
  "ожидание данных": "waiting for data",
  "Папка: ": "Folder: ",
  Завершить: "Finish",
  "Отменить скачивание": "Cancel download",
  "Прогресс скачивания": "Download progress",
  "Папка, указанная в настройках браузера":
    "Folder selected in browser settings",
  "Разрешить доступ…": "Allow access…",
  "Сервис недоступен.": "Service unavailable.",
  ГБ: "GB",
  МБ: "MB",
  КБ: "KB",
  "Папка для видео": "Video folder",
  "Куда сохранять видео?": "Where should videos be saved?",
  "Выберите папку один раз — она будет общей для всех новых скачиваний.":
    "Choose a folder once for all new downloads.",
  "Текущее место": "Current location",
  "Папка выбрана. Все новые видео будут сохраняться сюда.":
    "Folder selected. New videos will be saved here.",
  "Видео будут сохраняться в папку загрузок браузера.":
    "Videos will be saved in the browser downloads folder.",
};
const russian = new Map(Object.entries(english).map(([ru, en]) => [en, ru]));
let language: Language = "ru";
export function deviceLanguage(locale: string): Language {
  return /^ru(?:-|$)/i.test(locale) ? "ru" : "en";
}
export async function initializeLanguage(): Promise<Language> {
  const stored = await chrome.storage.local.get(storageKey);
  const value: unknown = stored[storageKey];
  language =
    value === "ru" || value === "en"
      ? value
      : deviceLanguage(chrome.i18n.getUILanguage());
  document.documentElement.lang = language;
  return language;
}
export async function setLanguage(value: Language): Promise<void> {
  if (value !== "ru" && value !== "en") throw new Error("Unsupported language");
  await chrome.storage.local.set({ [storageKey]: value });
  language = value;
  document.documentElement.lang = value;
}
export function t(text: string): string {
  const original = russian.get(text) ?? text;
  return language === "en" ? (english[original] ?? original) : original;
}
export function translateMarkup(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()))
    node.textContent = t(node.textContent ?? "");
  for (const element of root.querySelectorAll("[title], [aria-label]")) {
    for (const attribute of ["title", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, t(value));
    }
  }
}
