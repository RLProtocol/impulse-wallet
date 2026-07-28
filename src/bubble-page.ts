// Extension page hosting the Bubblemaps holder map in an iframe. x.com's CSP
// can't block an extension-page iframe, and our own extension CSP allows
// framing bubblemaps.io.  ?ca=0x…
const params = new URLSearchParams(location.search);
const ca = params.get("ca") || "";

if (/^0x[0-9a-fA-F]{40}$/.test(ca)) {
  // Frame the PUBLIC app (not the partner-only iframe endpoint). Its
  // frame-ancestors/X-Frame-Options headers are stripped for sub_frame
  // requests by our declarativeNetRequest rule (public/rules/bubblemaps.json).
  const src = `https://v2.bubblemaps.io/map?address=${ca}&chain=robinhood`;
  const f = document.createElement("iframe");
  f.src = src;
  f.allow = "clipboard-write";
  f.referrerPolicy = "no-referrer";
  document.body.appendChild(f);
} else {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = "Invalid token address.";
  document.body.appendChild(d);
}
