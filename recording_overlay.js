(() => {
  let isTopLevel = false;
  try {
    isTopLevel = window === window.top;
  } catch (_) {
    isTopLevel = false;
  }
  if (!isTopLevel) {
    return;
  }

  const OVERLAY_ID = "__whisper_rec_overlay";
  const DEFAULT_TEXT = "Whisper recording... Press Alt+E (Windows: Alt+Shift+E) to stop.";
  let configuredDefaultText = DEFAULT_TEXT;
  const OVERLAY_READY_MESSAGE = "content-overlay-ready";

  const overlayState = {
    root: null,
    textNode: null,
  };

  (function notifyBackgroundReady() {
    if (!chrome?.runtime?.sendMessage) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: OVERLAY_READY_MESSAGE });
    } catch (_) {
      // ignore environments where messaging is unavailable
    }
  })();

  function ensureOverlayRoot() {
    if (overlayState.root && document.contains(overlayState.root)) {
      return overlayState;
    }

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:8px 12px",
      "background:rgba(217,83,79,0.94)",
      "color:#fff",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px",
      "letter-spacing:0.3px",
      "border-radius:999px",
      "box-shadow:0 2px 8px rgba(0,0,0,0.35)",
      "pointer-events:none",
      "opacity:0",
      "transform:translateY(-6px)",
      "transition:opacity 120ms ease,transform 120ms ease",
    ].join(";");

    const dot = document.createElement("span");
    dot.style.cssText = [
      "width:8px",
      "height:8px",
      "border-radius:50%",
      "background:#fff",
      "display:inline-block",
      "box-shadow:0 0 6px rgba(255,255,255,0.8)",
    ].join(";");

    const textNode = document.createElement("span");
    textNode.textContent = configuredDefaultText;

    root.appendChild(dot);
    root.appendChild(textNode);

    const mountPoint = document.documentElement || document.body;
    if (mountPoint) {
      mountPoint.appendChild(root);
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          const lateMount = document.documentElement || document.body;
          if (lateMount && !lateMount.contains(root)) {
            lateMount.appendChild(root);
          }
        },
        { once: true }
      );
    }

    overlayState.root = root;
    overlayState.textNode = textNode;
    return overlayState;
  }

  function setDefaultText(text) {
    const fallback = typeof text === "string" && text.trim().length > 0 ? text.trim() : DEFAULT_TEXT;
    configuredDefaultText = fallback;
    if (overlayState.textNode) {
      overlayState.textNode.textContent = fallback;
    }
  }

  function showOverlay(text) {
    const overlay = ensureOverlayRoot();
    if (!overlay?.root) {
      return;
    }
    overlay.textNode.textContent = typeof text === "string" && text.trim().length > 0 ? text : configuredDefaultText;
    overlay.root.style.opacity = "1";
    overlay.root.style.transform = "translateY(0)";
  }

  function hideOverlay() {
    if (!overlayState.root) {
      return;
    }
    overlayState.root.style.opacity = "0";
    overlayState.root.style.transform = "translateY(-6px)";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "content-overlay") {
      return;
    }
    if (msg.action === "show") {
      showOverlay(msg.text);
    } else if (msg.action === "hide") {
      hideOverlay();
    } else if (msg.action === "set-default-text") {
      setDefaultText(msg.text);
    }
  });
})();
