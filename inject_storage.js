// inject_storage.js — CookieSwapper
//
// This content script runs at document_start in the ISOLATED world.
// It asks the service worker for this tab's pending storage payload
// and posts it to the MAIN world via a CustomEvent, where a sister
// script (inject_storage_main.js) applies it to localStorage/sessionStorage
// as early as Chrome can deliver the storage payload.
//
// Two-script approach is required because:
//  - the service worker can bind the payload to sender.tab.id
//  - localStorage must be written in the MAIN world (same JS context as page)
//
// Registered dynamically by navigateAndApplyCookieSet() in service_worker.js.
// Unregistered after the tab finishes loading.

(async () => {
  try {
    const sendRuntimeMessage = (message) => new Promise((resolve) => {
      chrome.runtime.sendMessage(
        message,
        (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(result || null);
        }
      );
    });
    const response = await sendRuntimeMessage({
      type: "takePendingStoragePayload",
      origin: location.origin,
      url: location.href,
    });
    const payload = response?.success ? response.data : null;
    if (!payload?.deliveryId || !payload?.token) return;

    const acknowledgement = new Promise((resolve) => {
      const timer = setTimeout(() => {
        document.removeEventListener("__cs_storage_applied__", listener);
        resolve(false);
      }, 1500);
      const listener = (event) => {
        if (event?.detail?.token !== payload.token) return;
        clearTimeout(timer);
        document.removeEventListener("__cs_storage_applied__", listener);
        resolve(event.detail.applied === true);
      };
      document.addEventListener("__cs_storage_applied__", listener);
    });

    // Dispatch the payload to the MAIN world via a CustomEvent on the document.
    // inject_storage_main.js (MAIN world) listens for this event and applies
    // the data to localStorage/sessionStorage synchronously.
    document.dispatchEvent(new CustomEvent("__cs_inject_storage__", {
      detail: {
        token: payload.token,
        ls: payload.localStorage  || {},
        ss: payload.sessionStorage || {},
      },
      bubbles: false,
      cancelable: false,
    }));
    const applied = await acknowledgement;
    await sendRuntimeMessage({
      type: "confirmPendingStorageApplied",
      deliveryId: payload.deliveryId,
      token: payload.token,
      applied,
    });
  } catch (_) {
    // Never throw — errors here must be silent
  }
})();
