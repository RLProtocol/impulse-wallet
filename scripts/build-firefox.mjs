// Build the Firefox (Gecko) package from the Chrome output.
//
// Run `npm run build` first, then this. It does not rebuild the code: the
// JavaScript is identical on both browsers, and only the manifest differs.
// Transforming the built manifest rather than maintaining a second one means
// the two packages can never drift apart.
//
//   node scripts/build-firefox.mjs
//
// Produces dist-firefox/ and impulse-firefox.zip
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "dist");
const OUT = join(ROOT, "dist-firefox");

if (!existsSync(join(SRC, "manifest.json"))) {
  console.error("dist/manifest.json not found. Run `npm run build` first.");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

const m = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));

// 1. Gecko needs an explicit extension id, and AMO refuses uploads without one.
//
//    data_collection_permissions is AMO's machine-readable privacy declaration,
//    and "none" is the literal truth here: no backend, no analytics, nothing
//    sent anywhere. It also surfaces in the install prompt, which is worth more
//    on a wallet than any wording in a description.
//
//    That key needs Firefox 140 (142 on Android), which sets the floor. Older
//    builds are long past end of life, and the alternative is shipping without
//    a privacy declaration at all - which reviewers read as an oversight rather
//    than an answer.
m.browser_specific_settings = {
  gecko: {
    id: "impulse@hoodx.online",
    strict_min_version: "140.0",
    data_collection_permissions: { required: ["none"] },
  },
  gecko_android: { strict_min_version: "142.0" },
};

// 2. Firefox MV3 has no background service worker. It runs a non-persistent
//    event page instead, so the same entry file is declared as a script.
if (m.background?.service_worker) {
  m.background = { scripts: [m.background.service_worker], type: "module" };
}

// 3. use_dynamic_url is Chrome-only. Firefox already randomises the internal
//    UUID per profile, which defeats the same fingerprinting the flag guards
//    against on Chrome, so dropping it loses nothing here.
for (const w of m.web_accessible_resources || []) delete w.use_dynamic_url;

// 4. Chrome's `key` field, if the build ever emits one, is meaningless to Gecko.
delete m.key;

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

// 5. Strip Vite's `crossorigin` attribute from every bundled page.
//
//    Vite emits <script type="module" crossorigin src="/assets/...">, which is
//    correct for the web and wrong inside an extension. Firefox reads the
//    attribute as a request for a CORS fetch, and a moz-extension:// page
//    asking CORS for its own file is refused, so the script never runs and the
//    popup opens as an empty window with nothing in the console to explain it.
//    Chrome is lenient about the same markup, which is why it only breaks here.
for (const page of ["index.html", "bubble.html"]) {
  const f = join(OUT, page);
  if (!existsSync(f)) continue;
  const before = readFileSync(f, "utf8");
  const after = before.replace(/\s+crossorigin(=("|')[^"']*\2)?/g, "");
  if (after !== before) {
    writeFileSync(f, after);
    console.log(`  stripped crossorigin from ${page}`);
  }
}

console.log("Firefox manifest written:");
console.log("  id             ", m.browser_specific_settings.gecko.id);
console.log("  min version    ", m.browser_specific_settings.gecko.strict_min_version);
console.log("  background     ", JSON.stringify(m.background));
console.log("  permissions    ", m.permissions.join(", "));
console.log("  host perms     ", (m.host_permissions || []).length);
console.log("  WAR            ", JSON.stringify((m.web_accessible_resources || []).map((w) => w.matches)));
console.log("\nnext: zip the CONTENTS of dist-firefox/ and upload to addons.mozilla.org");
