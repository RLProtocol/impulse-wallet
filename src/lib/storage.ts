// Thin wrapper over chrome.storage.local with a localStorage fallback so the
// app also runs in a normal Vite dev tab (outside the extension sandbox).

const hasChrome = typeof chrome !== "undefined" && !!chrome?.storage?.local;

export async function getItem<T = unknown>(key: string): Promise<T | undefined> {
  if (hasChrome) {
    const r = await chrome.storage.local.get(key);
    return r[key] as T | undefined;
  }
  const raw = localStorage.getItem(key);
  return raw == null ? undefined : (JSON.parse(raw) as T);
}

export async function setItem(key: string, value: unknown): Promise<void> {
  if (hasChrome) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

export async function removeItem(key: string): Promise<void> {
  if (hasChrome) {
    await chrome.storage.local.remove(key);
    return;
  }
  localStorage.removeItem(key);
}

// Session-only storage (cleared when browser closes) for the unlocked key.
// chrome.storage.session is memory-backed and not persisted to disk.
const hasSession = typeof chrome !== "undefined" && !!chrome?.storage?.session;

export async function getSession<T = unknown>(key: string): Promise<T | undefined> {
  if (hasSession) {
    const r = await chrome.storage.session.get(key);
    return r[key] as T | undefined;
  }
  const raw = sessionStorage.getItem(key);
  return raw == null ? undefined : (JSON.parse(raw) as T);
}

export async function setSession(key: string, value: unknown): Promise<void> {
  if (hasSession) {
    await chrome.storage.session.set({ [key]: value });
    return;
  }
  sessionStorage.setItem(key, JSON.stringify(value));
}

export async function clearSession(key: string): Promise<void> {
  if (hasSession) {
    await chrome.storage.session.remove(key);
    return;
  }
  sessionStorage.removeItem(key);
}
