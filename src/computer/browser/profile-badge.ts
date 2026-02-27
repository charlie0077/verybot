/**
 * Injectable JS script that renders a floating profile badge at the top of
 * every page. Injected via `context.addInitScript()` so it runs on every
 * navigation within the persistent browser context.
 *
 * The badge color is deterministic — derived from a simple hash of the profile
 * name so each profile always gets the same hue.
 */

const BADGE_ID = "__verybot_profile_badge__";

/**
 * Build the init-script source string for a given profile name.
 * The returned string is plain JS (no imports) safe for `addInitScript`.
 */
export function buildProfileBadgeScript(profileName: string): string {
  // Defense-in-depth: reject anything outside [a-zA-Z0-9-] even if caller validated
  if (!/^[a-zA-Z0-9-]+$/.test(profileName)) {
    throw new Error(`Unsafe profile name for badge script: "${profileName}"`);
  }

  // Deterministic hue from profile name (djb2 hash → 0-360)
  let hash = 5381;
  for (let i = 0; i < profileName.length; i++) {
    hash = ((hash << 5) + hash + profileName.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;

  // Also override document.title so the window is identifiable
  const upperName = profileName.toUpperCase();

  return `
(function() {
  if (document.getElementById("${BADGE_ID}")) return;

  /* --- title prefix --- */
  var origTitle = document.title;
  document.title = "[${upperName}] " + origTitle;
  new MutationObserver(function() {
    if (!document.title.startsWith("[${upperName}] ")) {
      document.title = "[${upperName}] " + document.title;
    }
  }).observe(document.querySelector("title") || document.head, { childList: true, subtree: true, characterData: true });

  /* --- badge bar --- */
  var bar = document.createElement("div");
  bar.id = "${BADGE_ID}";
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;" +
    "background:hsl(${hue},65%,45%);color:#fff;font:bold 13px/28px sans-serif;" +
    "display:flex;align-items:center;padding:0 12px;box-shadow:0 1px 4px rgba(0,0,0,.25);";

  var dot = document.createElement("span");
  dot.textContent = "\\u25CF ";
  dot.style.marginRight = "6px";
  bar.appendChild(dot);

  var label = document.createElement("span");
  label.textContent = "${upperName}";
  label.style.flex = "1";
  bar.appendChild(label);

  var close = document.createElement("span");
  close.textContent = "\\u2715";
  close.style.cssText = "cursor:pointer;padding:0 4px;font-size:15px;opacity:.8;";
  close.addEventListener("click", function() { bar.remove(); });
  bar.appendChild(close);

  document.documentElement.appendChild(bar);
})();
`;
}
