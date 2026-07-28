export function shortAddr(a?: string, size = 4): string {
  if (!a) return "";
  return `${a.slice(0, 2 + size)}…${a.slice(-size)}`;
}

export function fmtNum(n: number, max = 6): string {
  if (!isFinite(n)) return "0";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

export function fmtUsd(n?: number | null): string {
  if (n == null || !isFinite(n)) return "-";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCompact(n?: number | null): string {
  if (n == null || !isFinite(n)) return "-";
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

export function fmtPct(n?: number | null): string {
  if (n == null || !isFinite(n)) return "-";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

// Parse a human decimal string into a bigint of `decimals` precision, safely.
export function parseUnitsSafe(value: string, decimals: number): bigint {
  const v = (value || "0").trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return 0n;
  const [whole, frac = ""] = v.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function formatUnitsNum(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return (neg ? -1 : 1) * Number(`${whole}.${frac}`);
}
