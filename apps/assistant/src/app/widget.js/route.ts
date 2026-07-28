import { env } from "@/lib/env";

/**
 * Vanilla-JS embed script (brief §9): floating chat bubble + iframe panel,
 * injected into Outline pages via nginx sub_filter. Namespaced `avops-*`,
 * inline styles, zero dependencies.
 */
export function GET() {
  const appUrl = env.APP_URL.replace(/\/$/, "");

  const script = `(function () {
  if (window.__avopsWidgetLoaded) return;
  window.__avopsWidgetLoaded = true;

  var ACCENT = "#0366D6";
  var PANEL_W = 380;
  var PANEL_H = 560;

  var bubble = document.createElement("button");
  bubble.id = "avops-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "AV Ops assistant");
  bubble.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:2147483000;" +
    "width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;" +
    "background:" + ACCENT + ";color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.25);" +
    "display:flex;align-items:center;justify-content:center;padding:0;" +
    "transition:transform .15s ease;";
  bubble.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  bubble.onmouseenter = function () { bubble.style.transform = "scale(1.06)"; };
  bubble.onmouseleave = function () { bubble.style.transform = "scale(1)"; };

  var panel = document.createElement("div");
  panel.id = "avops-panel";
  panel.style.cssText =
    "position:fixed;bottom:84px;right:20px;z-index:2147483000;" +
    "width:" + PANEL_W + "px;height:" + PANEL_H + "px;max-width:calc(100vw - 32px);" +
    "max-height:calc(100vh - 110px);border-radius:12px;overflow:hidden;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;background:#fff;";

  var frame = document.createElement("iframe");
  frame.id = "avops-frame";
  frame.title = "ILUMINA AV Ops assistant";
  frame.style.cssText = "width:100%;height:100%;border:none;";
  frame.loading = "lazy";

  panel.appendChild(frame);

  var open = false;
  bubble.addEventListener("click", function () {
    open = !open;
    if (open && !frame.src) frame.src = "${appUrl}/widget";
    panel.style.display = open ? "block" : "none";
    bubble.innerHTML = open
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  });

  function mount() {
    document.body.appendChild(bubble);
    document.body.appendChild(panel);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
`;

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
