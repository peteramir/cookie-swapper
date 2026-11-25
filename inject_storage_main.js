// inject_storage_main.js — CookieSwapper
//
// Runs at document_start in the MAIN world and applies the payload as early as
// the service-worker bridge can deliver it.
//
// Applies localStorage/sessionStorage from a CustomEvent dispatched by
// inject_storage.js after it receives a short-lived, tab-bound payload.
//
// WHY NOT window.name or cookies:
//
//   window.name: Cleared by Chrome on cross-origin transitions, so it is not a
//   reliable way to carry session storage data between navigations.
//
//   Cookies: Payload cookies would inflate the Cookie request header and can
//   interfere with the very session cookies this extension is restoring.

(function () {
  try {
    var listener = function (event) {
      var token = event && event.detail && event.detail.token;
      if (typeof token !== 'string' || !token) return;
      document.removeEventListener('__cs_inject_storage__', listener);
      var success = false;
      try {
        success = applyPayload(event && event.detail);
      } catch (_) {}
      document.dispatchEvent(new CustomEvent('__cs_storage_applied__', {
        detail: { token: token, applied: success },
        bubbles: false,
        cancelable: false,
      }));
    };
    document.addEventListener('__cs_inject_storage__', listener);
  } catch (_) {}

  function applyPayload(payload) {
    var ls = payload && (payload.ls || payload.localStorage);
    var ss = payload && (payload.ss || payload.sessionStorage);
    var success = true;

    // Remove values from the previous account before restoring the snapshot.
    try {
      localStorage.clear();
    } catch (_) { success = false; }
    try {
      sessionStorage.clear();
    } catch (_) { success = false; }

    // Inject into localStorage.
    if (ls && typeof ls === 'object') {
      var localEntries = Array.isArray(ls) ? ls : Object.keys(ls).map(function (k) {
        return [k, ls[k]];
      });
      localEntries.forEach(function (entry) {
        var k = entry[0];
        try {
          localStorage.setItem(k, entry[1]);
        } catch (_) { success = false; }
      });
    }

    // Inject into sessionStorage.
    if (ss && typeof ss === 'object') {
      var sessionEntries = Array.isArray(ss) ? ss : Object.keys(ss).map(function (k) {
        return [k, ss[k]];
      });
      sessionEntries.forEach(function (entry) {
        var k = entry[0];
        try {
          sessionStorage.setItem(k, entry[1]);
        } catch (_) { success = false; }
      });
    }
    return success;
  }

}());
