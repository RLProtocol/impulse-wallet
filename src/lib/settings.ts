import { getItem, setItem, getSession, setSession, clearSession } from "./storage";

const AUTOLOCK_KEY = "strix.autolockMin";
const SECACK_KEY = "strix.securityAck";
const LASTACTIVE_KEY = "strix.lastActive";

// Auto-lock: minutes of inactivity before the wallet locks. 0 = never.
export const AUTOLOCK_OPTIONS = [1, 5, 15, 30, 60, 0];

export async function getAutoLockMin(): Promise<number> {
  const v = await getItem<number>(AUTOLOCK_KEY);
  return v == null ? 15 : v;
}
export async function setAutoLockMin(min: number): Promise<void> {
  await setItem(AUTOLOCK_KEY, min);
}

export async function getSecurityAck(): Promise<boolean> {
  return !!(await getItem<boolean>(SECACK_KEY));
}
export async function setSecurityAck(v: boolean): Promise<void> {
  await setItem(SECACK_KEY, v);
}

export async function touchActivity(): Promise<void> {
  await setSession(LASTACTIVE_KEY, Date.now());
}
export async function getLastActive(): Promise<number | undefined> {
  return getSession<number>(LASTACTIVE_KEY);
}

/**
 * Forget when the wallet was last used.
 *
 * Called on lock. Leaving the timestamp behind is what caused the wallet to
 * refuse a correct password: reload() re-checks isIdleExpired() straight after
 * a successful unlock, saw the pre-lock timestamp still sitting there, decided
 * the session was stale and locked again — permanently, since the value was
 * never cleared.
 */
export async function clearActivity(): Promise<void> {
  await clearSession(LASTACTIVE_KEY);
}

// True when the wallet has been idle longer than the auto-lock window.
export async function isIdleExpired(): Promise<boolean> {
  const min = await getAutoLockMin();
  if (!min) return false;
  const last = await getLastActive();
  if (last == null) return false;
  return Date.now() - last > min * 60_000;
}
