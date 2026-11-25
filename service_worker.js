
const STORAGE_KEY = "cookieSwapperData";
const STATE_METADATA_KEY = "cookieSwapperSessionIndex";
const MAX_ENTRIES_PER_DOMAIN = 12;
const MAX_GLOBAL_DOMAINS = 100;
const MAX_LABEL_LENGTH = 64;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_COOKIES_PER_SNAPSHOT = 1000;
const MAX_STORAGE_ENTRIES_PER_AREA = 5000;
const COOKIE_WRITE_BATCH_SIZE = 16;
const COOKIE_EXPIRY_SAFETY_WINDOW_SECONDS = 1;
const REPORT_RELAY_URLS = [
  "https://cookieswapper.aminox.dev/api/reports",
];
const REVIEW_FEEDBACK_DOMAIN = "review-feedback.cookieswapper.aminox.dev";
const SESSION_INVALIDATION_HINTS_KEY = "cookieSwapperSessionInvalidationHints";
const SESSION_INVALIDATION_HINT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_INVALIDATION_HINTS = 100;
const PENDING_STORAGE_PREFIX = "__cs_pending_storage_";
const STORAGE_DELIVERY_TIMEOUT_MS = 5000;
const pendingStorageAcknowledgements = new Map();
const createServiceError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getPendingStorageArea = async () => {
  if (chrome.storage.session) {
    try {
      if (chrome.storage.session.setAccessLevel) {
        await chrome.storage.session.setAccessLevel({
          accessLevel: "TRUSTED_CONTEXTS",
        });
      }
    } catch (_) {}
    return chrome.storage.session;
  }
  return chrome.storage.local;
};

const prunePendingStoragePayloads = async (area) => {
  try {
    const all = await area.get(null);
    const now = Date.now();
    const expiredKeys = Object.entries(all || {})
      .filter(([key, value]) =>
        key.startsWith(PENDING_STORAGE_PREFIX) &&
        (!value || typeof value !== "object" || !value.expiresAt || now > Number(value.expiresAt))
      )
      .map(([key]) => key);
    if (expiredKeys.length) {
      await area.remove(expiredKeys);
    }
  } catch (_) {}
};

const pruneAllPendingStoragePayloads = async () => {
  const area = await getPendingStorageArea();
  await prunePendingStoragePayloads(area);
};

void pruneAllPendingStoragePayloads();

const createRandomId = (prefix) => {
  const randomPart = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${Date.now()}-${randomPart}`;
};

const createStorageAcknowledgement = (deliveryId, token, tabId) => {
  let finish = null;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingStorageAcknowledgements.delete(deliveryId);
      resolve(false);
    }, STORAGE_DELIVERY_TIMEOUT_MS);

    finish = (success) => {
      clearTimeout(timer);
      pendingStorageAcknowledgements.delete(deliveryId);
      resolve(success === true);
    };
    pendingStorageAcknowledgements.set(deliveryId, { token, tabId, finish });
  });

  return {
    promise,
    cancel: () => finish?.(false),
  };
};

const takePendingStoragePayload = async (sender, message) => {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0 || Number(sender?.frameId || 0) !== 0) {
    throw createServiceError("ERR_INVALID_TAB");
  }

  const requestedOrigin = typeof message?.origin === "string" ? message.origin : "";
  const requestedUrl = typeof message?.url === "string" ? message.url.split("#")[0] : "";
  const keyPrefix = `${PENDING_STORAGE_PREFIX}${tabId}_`;
  const area = await getPendingStorageArea();
  await prunePendingStoragePayloads(area);
  const all = await area.get(null);
  const match = Object.entries(all || {})
    .filter(([key, value]) => {
      if (!key.startsWith(keyPrefix) || !value || typeof value !== "object") return false;
      if (value.origin && value.origin !== requestedOrigin) return false;
      if (value.urlPrefix && !requestedUrl.startsWith(value.urlPrefix)) return false;
      return true;
    })
    .sort(([left], [right]) => right.localeCompare(left))[0];

  if (!match) return null;

  const [key, payload] = match;
  await area.remove(key);
  return {
    deliveryId: payload.deliveryId,
    token: payload.token,
    localStorage: Object.entries(normalizeStorageSnapshot(payload.localStorage)),
    sessionStorage: Object.entries(normalizeStorageSnapshot(payload.sessionStorage)),
  };
};

const confirmPendingStorageApplied = (sender, message) => {
  const tabId = Number(sender?.tab?.id);
  const deliveryId = typeof message?.deliveryId === "string" ? message.deliveryId : "";
  const token = typeof message?.token === "string" ? message.token : "";
  const pending = pendingStorageAcknowledgements.get(deliveryId);
  if (
    !pending ||
    !Number.isInteger(tabId) ||
    tabId !== pending.tabId ||
    Number(sender?.frameId || 0) !== 0 ||
    token !== pending.token
  ) {
    throw createServiceError("ERR_INVALID_TAB");
  }
  pending.finish(message?.applied === true);
  return { acknowledged: true };
};

const createRecord = () => Object.create(null);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const defaultState = () => ({ domains: createRecord() });

const normalizeStateShape = (state) => {
  const next = isRecord(state) ? { ...state } : defaultState();
  if (!isRecord(next.domains)) {
    next.domains = createRecord();
  } else {
    next.domains = normalizeStoredDomains(next.domains);
  }
  delete next.activityLog;
  delete next.runtimeMeta;
  return next;
};

const normalizeDomain = (domain) => {
  const raw = String(domain || "")
    .trim()
    .replace(/^\./, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!raw || raw.length > 253 || /[\s/@]/.test(raw)) return "";
  try {
    return new URL(`https://${raw}`).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
};

const normalizeSessionInvalidationHints = (value, now = Date.now()) =>
  (Array.isArray(value) ? value : [])
    .filter((hint) => {
      if (!hint || typeof hint !== "object") return false;
      const detectedAt = Number(hint.detectedAt);
      return (
        Boolean(normalizeDomain(hint.domain)) &&
        typeof hint.sessionId === "string" &&
        hint.sessionId.length > 0 &&
        hint.sessionId.length <= 256 &&
        Number.isFinite(detectedAt) &&
        detectedAt > 0 &&
        detectedAt + SESSION_INVALIDATION_HINT_TTL_MS >= now
      );
    })
    .map((hint) => ({
      domain: normalizeDomain(hint.domain),
      sessionId: hint.sessionId,
      detectedAt: Number(hint.detectedAt),
      change: hint.change === "removed" ? "removed" : "changed",
    }))
    .sort((left, right) => right.detectedAt - left.detectedAt)
    .slice(0, MAX_SESSION_INVALIDATION_HINTS);

const getSessionInvalidationHints = async () => {
  const data = await chrome.storage.local.get(SESSION_INVALIDATION_HINTS_KEY);
  const raw = data[SESSION_INVALIDATION_HINTS_KEY];
  const normalized = normalizeSessionInvalidationHints(raw);
  if (JSON.stringify(raw || []) !== JSON.stringify(normalized)) {
    await chrome.storage.local.set({ [SESSION_INVALIDATION_HINTS_KEY]: normalized });
  }
  return normalized;
};

const recordSessionInvalidationHint = async (domain, sessionId, changeInfo) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || typeof sessionId !== "string" || !sessionId) return false;
  const hints = await getSessionInvalidationHints();
  const next = normalizeSessionInvalidationHints([
    {
      domain: normalizedDomain,
      sessionId,
      detectedAt: Date.now(),
      change: changeInfo?.removed === true ? "removed" : "changed",
    },
    ...hints.filter(
      (hint) => hint.domain !== normalizedDomain || hint.sessionId !== sessionId
    ),
  ]);
  await chrome.storage.local.set({ [SESSION_INVALIDATION_HINTS_KEY]: next });
  return true;
};

const getRecentSessionInvalidationHint = async (domain, sessionId) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || typeof sessionId !== "string" || !sessionId) return null;
  const hints = await getSessionInvalidationHints();
  return (
    hints.find(
      (hint) => hint.domain === normalizedDomain && hint.sessionId === sessionId
    ) || null
  );
};

const clearSessionInvalidationHint = async (domain, sessionId) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || typeof sessionId !== "string" || !sessionId) return false;
  const hints = await getSessionInvalidationHints();
  const next = hints.filter(
    (hint) => hint.domain !== normalizedDomain || hint.sessionId !== sessionId
  );
  if (next.length === hints.length) return false;
  await chrome.storage.local.set({ [SESSION_INVALIDATION_HINTS_KEY]: next });
  return true;
};

const getInvalidationEvidence = async (domain, entry, now = Date.now()) => {
  const externalHint = await getRecentSessionInvalidationHint(domain, entry?.id).catch(() => null);
  if (externalHint) {
    return {
      reason: "external-change",
      requiresExtendedVerification: externalHint.change === "removed",
    };
  }
  const createdAt = Number(entry?.createdAt);
  if (
    Number.isFinite(createdAt) &&
    createdAt > 0 &&
    createdAt <= now &&
    now - createdAt <= SESSION_INVALIDATION_HINT_TTL_MS
  ) {
    return { reason: "recent-rejection", requiresExtendedVerification: false };
  }
  return { reason: "unknown", requiresExtendedVerification: false };
};

const classifyInvalidSessionFailure = async (domain, entry, now = Date.now()) =>
  (await getInvalidationEvidence(domain, entry, now)).reason;

const hasProbableLoggedOutSignal = (authCheck) =>
  Boolean(
    authCheck?.hasLoggedOutSignal &&
      !authCheck.hasLoggedInSignal &&
      authCheck.authActionCount >= 2
  );

const shouldTreatSessionAsInvalid = (verification, evidenceReason = "unknown") => {
  if (verification?.invalidSession) return true;

  const authCheck = verification?.authCheck;
  if (!authCheck?.hasLoggedOutSignal || authCheck.hasLoggedInSignal) return false;

  const hasStrongLoggedOutSignal = Boolean(
    authCheck.hasExpiredText ||
      authCheck.authFormCount > 0 ||
      (authCheck.urlLooksAuth &&
        (authCheck.passwordInputCount > 0 || authCheck.authActionCount > 0))
  );
  return Boolean(
    hasStrongLoggedOutSignal &&
      (evidenceReason === "external-change" || evidenceReason === "recent-rejection")
  );
};

const classifyRestoredSession = (verification, evidenceReason = "unknown") => {
  if (shouldTreatSessionAsInvalid(verification, evidenceReason)) return "rejected";
  if (verification?.authCheck?.hasLoggedInSignal) return "confirmed";
  if (hasProbableLoggedOutSignal(verification?.authCheck)) {
    return "unconfirmed";
  }
  return "unknown";
};

const TAB_DOMAIN_HINTS_KEY = "cookieSwapperTabDomainHints";
const TAB_DOMAIN_HINT_TTL_MS = 10 * 60 * 1000;
const MAX_HINTS_PER_TAB = 5;

const getSessionStorageArea = () => chrome.storage.session || chrome.storage.local;
void chrome.storage.local.remove("cookieSwapperTabDomainHintsLocal").catch(() => {});

// Supports both the legacy single-object format and the new array format.
const pruneTabDomainHints = (items, now = Date.now(), ttl = TAB_DOMAIN_HINT_TTL_MS) =>
  Object.fromEntries(
    Object.entries(items || {})
      .filter(([tabId]) => /^\d+$/.test(String(tabId)))
      .map(([tabId, item]) => {
        const list = Array.isArray(item) ? item : (item && typeof item === "object" ? [item] : []);
        const pruned = list.filter((h) => {
          if (!h || typeof h !== "object") return false;
          const at = Number(h.at);
          return Number.isFinite(at) && at + ttl >= now && Boolean(normalizeDomain(h.domain));
        });
        return [tabId, pruned];
      })
      .filter(([, list]) => list.length > 0)
  );

const getTabDomainHints = async () => {
  const area = getSessionStorageArea();
  const data = await area.get(TAB_DOMAIN_HINTS_KEY);
  const raw = data[TAB_DOMAIN_HINTS_KEY];
  const next = pruneTabDomainHints(raw);
  await area.set({ [TAB_DOMAIN_HINTS_KEY]: next });
  return next;
};

// Adds a hint entry to the front of this tab's hint list (most recent first).
// Deduplicates by domain. Caps at MAX_HINTS_PER_TAB entries.
const setTabDomainHint = async (tabId, domain, reason = "redirect") => {
  const numericTabId = Number(tabId);
  const normalizedDomain = normalizeDomain(domain);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0 || !normalizedDomain) return false;

  const area = getSessionStorageArea();
  const hints = await getTabDomainHints();
  const existing = Array.isArray(hints[String(numericTabId)]) ? hints[String(numericTabId)] : [];

  // Remove any stale entry for the same domain, then prepend the new one.
  const deduped = existing.filter((h) => normalizeDomain(h.domain) !== normalizedDomain);
  const updated = [
    { domain: normalizedDomain, reason, at: Date.now() },
    ...deduped,
  ].slice(0, MAX_HINTS_PER_TAB);

  hints[String(numericTabId)] = updated;
  await area.set({ [TAB_DOMAIN_HINTS_KEY]: hints });

  return true;
};

// Removes either a specific domain entry (if domain provided) or the entire tab entry.
const clearTabDomainHint = async (tabId, domain = null) => {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return false;

  const area = getSessionStorageArea();
  const hints = await getTabDomainHints();
  if (!hints[String(numericTabId)]) return false;

  if (domain) {
    const normalizedDomain = normalizeDomain(domain);
    const list = Array.isArray(hints[String(numericTabId)])
      ? hints[String(numericTabId)]
      : [hints[String(numericTabId)]];
    const filtered = list.filter((h) => normalizeDomain(h.domain) !== normalizedDomain);
    if (filtered.length === 0) {
      delete hints[String(numericTabId)];
    } else {
      hints[String(numericTabId)] = filtered;
    }
  } else {
    delete hints[String(numericTabId)];
  }

  await area.set({ [TAB_DOMAIN_HINTS_KEY]: hints });

  return true;
};

// Iterates the tab's hint list (most recent first) and returns the first hint whose domain:
//   - differs from currentDomain
//   - actually has saved entries in state (when state is provided)
const getRecentTabDomainHint = async (tabId, currentDomain, state = null) => {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return null;
  const hints = await getTabDomainHints();
  const hintEntry = hints[String(numericTabId)];
  if (!hintEntry) return null;

  const normalizedCurrentDomain = normalizeDomain(currentDomain);
  // Support both legacy single-object and new array format.
  const list = Array.isArray(hintEntry) ? hintEntry : [hintEntry];

  for (const hint of list) {
    if (!hint || typeof hint !== "object") continue;
    const normalizedHintDomain = normalizeDomain(hint.domain);
    if (!normalizedHintDomain || normalizedHintDomain === normalizedCurrentDomain) continue;
    // When state is provided, skip hints whose domain has no entries.
    if (state) {
      const hintedEntries = state.domains[normalizedHintDomain]?.entries || [];
      if (!hintedEntries.length) {
        continue;
      }
    }
    return {
      domain: normalizedHintDomain,
      reason: hint.reason || "redirect",
      at: Number(hint.at) || 0,
    };
  }
  return null;
};

const buildCookieUrl = (cookie, fallbackDomain) => {
  const domain = normalizeDomain(cookie.domain || fallbackDomain);
  const host = domain || fallbackDomain;
  const path = cookie.path && cookie.path.startsWith("/")
    ? cookie.path
    : `/${cookie.path || ""}`;
  const protocol = cookie.secure ? "https" : "http";
  return `${protocol}://${host}${path}`;
};

const toStorableCookie = (cookie) => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path,
  hostOnly: cookie.hostOnly,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  expirationDate: cookie.expirationDate,
  storeId: cookie.storeId,
  partitionKey: cookie.partitionKey,
});

const partitionKeyToString = (partitionKey) => {
  if (!partitionKey) return "";
  const topLevelSite = partitionKey.topLevelSite || "";
  const hasCrossSiteAncestor = partitionKey.hasCrossSiteAncestor ? "1" : "0";
  return JSON.stringify([topLevelSite, hasCrossSiteAncestor]);
};

const cookieIdentityKey = (cookie) =>
  JSON.stringify([
    cookie.name,
    cookie.path || "/",
    normalizeDomain(cookie.domain || ""),
    cookie.storeId || "",
    cookie.hostOnly === true,
    partitionKeyToString(cookie.partitionKey),
  ]);

const dedupeCookies = (cookies) => {
  const map = new Map();
  cookies.forEach((cookie) => {
    map.set(cookieIdentityKey(cookie), cookie);
  });
  return Array.from(map.values());
};

const EXPECTED_COOKIE_MUTATION_TTL_MS = 10000;
const expectedCookieMutations = new Map();

const pruneExpectedCookieMutations = (now = Date.now()) => {
  expectedCookieMutations.forEach((items, key) => {
    const pending = items.filter((item) => item.expiresAt > now);
    if (pending.length) expectedCookieMutations.set(key, pending);
    else expectedCookieMutations.delete(key);
  });
};

const rememberExpectedCookieMutation = (cookie, operation = "set") => {
  if (!cookie?.name) return null;
  pruneExpectedCookieMutations();
  const key = cookieIdentityKey(cookie);
  const pending = expectedCookieMutations.get(key) || [];
  const item = {
    operation: operation === "remove" ? "remove" : "set",
    signature: signatureFromCookies([cookie], null),
    expiresAt: Date.now() + EXPECTED_COOKIE_MUTATION_TTL_MS,
  };
  pending.push(item);
  expectedCookieMutations.set(key, pending);
  return { key, item };
};

const forgetExpectedCookieMutation = (expectation) => {
  if (!expectation?.key || !expectation.item) return;
  const pending = expectedCookieMutations.get(expectation.key) || [];
  const next = pending.filter((item) => item !== expectation.item);
  if (next.length) expectedCookieMutations.set(expectation.key, next);
  else expectedCookieMutations.delete(expectation.key);
};

const isExpectedCookieMutation = (changeInfo) => {
  pruneExpectedCookieMutations();
  const cookie = changeInfo?.cookie;
  if (!cookie?.name) return false;
  const key = cookieIdentityKey(cookie);
  const pending = expectedCookieMutations.get(key) || [];
  const changedSignature = signatureFromCookies([toStorableCookie(cookie)], null);
  const matchIndex = pending.findIndex((item) => {
    if (item.operation === "remove") {
      return changeInfo.removed === true && changeInfo.cause === "explicit";
    }
    if (changeInfo.removed === true) {
      return changeInfo.cause === "overwrite";
    }
    return item.signature === changedSignature;
  });
  if (matchIndex === -1) return false;

  const matched = pending[matchIndex];
  const setOverwrite =
    matched.operation === "set" &&
    changeInfo.removed === true &&
    changeInfo.cause === "overwrite";
  if (!setOverwrite) pending.splice(matchIndex, 1);
  if (pending.length) expectedCookieMutations.set(key, pending);
  else expectedCookieMutations.delete(key);
  return true;
};

const LEGACY_MARKER_COOKIE_NAME = "__cookieswapper_active";

const isLegacyMarkerCookie = (cookie) =>
  cookie?.name === LEGACY_MARKER_COOKIE_NAME &&
  /^1\|(?:manual-\d{10,16}|import-\d{10,16}-[a-z0-9]{4,16})\|[a-z0-9]{0,16}$/i.test(
    String(cookie?.value || "")
  );

const ensureDomainState = (state, domain) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return null;
  if (!Object.hasOwn(state.domains, normalizedDomain)) {
    state.domains[normalizedDomain] = { entries: [] };
  }
  return state.domains[normalizedDomain];
};

const getActiveSessionId = (domainState) =>
  typeof domainState?.activeSessionId === "string" ? domainState.activeSessionId : null;

const setActiveSession = (state, domain, sessionId) => {
  const domainState = ensureDomainState(state, domain);
  if (!domainState || !sessionId) return false;
  if (domainState.activeSessionId === sessionId) return false;
  domainState.activeSessionId = sessionId;
  return true;
};

const clearActiveSession = (state, domain, sessionId = null) => {
  const normalizedDomain = normalizeDomain(domain);
  const domainState = normalizedDomain ? state.domains[normalizedDomain] : null;
  if (!domainState?.activeSessionId) return false;
  if (sessionId && domainState.activeSessionId !== sessionId) return false;
  delete domainState.activeSessionId;
  return true;
};

const DB_NAME = "cookieSwapperDB";
const DB_VERSION = 1;
const DB_STORE = "state";
let databasePromise = null;

const openDb = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });
  return databasePromise;
};

const idbGet = async (key) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    let value;
    req.onsuccess = () => {
      value = req.result;
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => {
      resolve(value);
    };
    tx.onerror = () => {
      reject(tx.error);
    };
  });
};

const idbSet = async (key, value) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => {};
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error);
    };
  });
};

const utf8ByteLength = (value) => {
  const text = String(value || "");
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch (_) {
    return text.length;
  }
};

const jsonByteLength = (value) => {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
};

const hashCanonicalText = (text) => {
  const source = String(text || "");
  const hashes = [2166136261, 2246822507, 3266489909, 668265263];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      hashes[hashIndex] ^= code + hashIndex * 131;
      hashes[hashIndex] = Math.imul(hashes[hashIndex], 16777619 + hashIndex * 2);
    }
  }
  return `${hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("")}:${source.length}`;
};

const sortedStorageEntries = (storageData) =>
  Object.keys(storageData || {})
    .sort()
    .map((key) => [key, storageData[key]]);

const storageSignature = (siteData) =>
  hashCanonicalText(
    JSON.stringify([
      siteData?.origin || "",
      sortedStorageEntries(siteData?.localStorage),
      sortedStorageEntries(siteData?.sessionStorage),
    ])
  );

const signatureFromCookies = (cookies, siteData) => {
  const canonicalCookies = [...(cookies || [])]
    .sort((left, right) => cookieIdentityKey(left).localeCompare(cookieIdentityKey(right)))
    .map((cookie) => [
      cookie.name || "",
      cookie.value || "",
      normalizeDomain(cookie.domain || ""),
      cookie.path || "/",
      cookie.hostOnly === true,
      cookie.secure === true,
      cookie.httpOnly === true,
      cookie.sameSite || "",
      cookie.storeId || "",
      partitionKeyToString(cookie.partitionKey),
    ]);
  return hashCanonicalText(
    JSON.stringify([canonicalCookies, storageSignature(siteData)])
  );
};

// Active-session identity favors account-distinguishing cookies and treats
// Web Storage as weaker evidence because sites mutate it during normal use.
const LIVE_SESSION_COOKIE_MIN_WEIGHT = 3;
const LIVE_SESSION_STORAGE_MIN_WEIGHT = 2;
const LIVE_SESSION_CONTINUITY_RATIO = 0.85;

const cookieSessionSignalWeight = (cookie) => {
  if (cookie?.httpOnly === true) return 6;
  if (cookie?.secure === true) return 4;
  return 3;
};

const cookieSessionSignals = (cookies) => {
  const signals = new Map();
  (cookies || []).forEach((cookie) => {
    const value = typeof cookie?.value === "string" ? cookie.value : "";
    if (!cookie?.name || !value) return;
    signals.set(cookieIdentityKey(cookie), {
      value,
      weight: cookieSessionSignalWeight(cookie),
    });
  });
  return signals;
};

const storageSessionSignals = (siteData) => {
  const signals = new Map();
  [
    ["local", siteData?.localStorage, 2],
    ["session", siteData?.sessionStorage, 1],
  ].forEach(([scope, storageData, weight]) => {
    Object.entries(storageData || {}).forEach(([key, value]) => {
      if (typeof value !== "string" || !value) return;
      signals.set(`${scope}:${key}`, { value, weight });
    });
  });
  return signals;
};

const buildLiveSessionSignals = (cookies, siteData) => ({
  cookies: cookieSessionSignals(cookies),
  storage: storageSessionSignals(siteData),
});

const findDiscriminatingSignalKeys = (signalMaps) => {
  const keys = new Set();
  signalMaps.forEach((signals) => {
    signals.forEach((_signal, key) => keys.add(key));
  });
  return [...keys].filter((key) => {
    const values = new Set(
      signalMaps.map((signals) => {
        const signal = signals.get(key);
        return signal ? JSON.stringify([true, signal.value]) : JSON.stringify([false]);
      })
    );
    return values.size > 1;
  });
};

const scoreSessionSignals = (savedSignals, liveSignals, discriminatingKeys) => {
  let matchedWeight = 0;
  let matchedCount = 0;
  let conflictWeight = 0;
  discriminatingKeys.forEach((key) => {
    const savedSignal = savedSignals.get(key);
    if (!savedSignal) return;
    const liveSignal = liveSignals.get(key);
    if (liveSignal?.value === savedSignal.value) {
      matchedWeight += savedSignal.weight;
      matchedCount += 1;
    } else {
      conflictWeight += savedSignal.weight;
    }
  });
  return { matchedWeight, matchedCount, conflictWeight };
};

const compareLiveSessionScores = (left, right) => {
  const leftValues = [
    left.cookie.matchedWeight,
    left.cookie.matchedCount,
    left.storage.matchedWeight,
    left.storage.matchedCount,
    -left.cookie.conflictWeight,
    -left.storage.conflictWeight,
  ];
  const rightValues = [
    right.cookie.matchedWeight,
    right.cookie.matchedCount,
    right.storage.matchedWeight,
    right.storage.matchedCount,
    -right.cookie.conflictWeight,
    -right.storage.conflictWeight,
  ];
  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] !== rightValues[index]) {
      return rightValues[index] - leftValues[index];
    }
  }
  return 0;
};

const signalProfileKey = (signals) =>
  JSON.stringify(
    [...signals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, signal]) => [key, signal.value])
  );

const hasUniqueSignalProfile = (entrySignals, candidateIndex, type) => {
  const profile = signalProfileKey(entrySignals[candidateIndex][type]);
  if (profile === "[]") return false;
  return entrySignals.every(
    (signals, index) => index === candidateIndex || signalProfileKey(signals[type]) !== profile
  );
};

const matchesContinuityProfile = (savedSignals, liveSignals, minimumWeight) => {
  let totalWeight = 0;
  let matchedWeight = 0;
  savedSignals.forEach((savedSignal, key) => {
    totalWeight += savedSignal.weight;
    if (liveSignals.get(key)?.value === savedSignal.value) {
      matchedWeight += savedSignal.weight;
    }
  });
  return (
    matchedWeight >= minimumWeight &&
    totalWeight > 0 &&
    matchedWeight / totalWeight >= LIVE_SESSION_CONTINUITY_RATIO
  );
};

const findRobustLiveSession = (
  entries,
  entrySignals,
  liveSignals,
  activeSessionId = null
) => {
  if (!activeSessionId || !entries.some((entry) => entry.id === activeSessionId)) {
    return null;
  }
  const cookieKeys = findDiscriminatingSignalKeys(
    entrySignals.map((signals) => signals.cookies)
  );
  const storageKeys = findDiscriminatingSignalKeys(
    entrySignals.map((signals) => signals.storage)
  );
  const scoredEntries = entries.map((entry, index) => ({
    entry,
    index,
    cookie: scoreSessionSignals(entrySignals[index].cookies, liveSignals.cookies, cookieKeys),
    storage: scoreSessionSignals(entrySignals[index].storage, liveSignals.storage, storageKeys),
  }));
  scoredEntries.sort(compareLiveSessionScores);

  const best = scoredEntries[0];
  const runnerUp = scoredEntries[1];
  const uniqueBest = best && (!runnerUp || compareLiveSessionScores(best, runnerUp) !== 0);
  const hasDiscriminatingEvidence =
    best?.cookie.matchedWeight >= LIVE_SESSION_COOKIE_MIN_WEIGHT ||
    (best?.cookie.matchedWeight === 0 &&
      best?.storage.matchedWeight >= LIVE_SESSION_STORAGE_MIN_WEIGHT);
  if (uniqueBest && hasDiscriminatingEvidence) return best.entry;

  const continuityIndex = entries.findIndex((entry) => entry.id === activeSessionId);
  if (continuityIndex < 0) return null;

  const candidateSignals = entrySignals[continuityIndex];
  if (
    hasUniqueSignalProfile(entrySignals, continuityIndex, "cookies") &&
    matchesContinuityProfile(
      candidateSignals.cookies,
      liveSignals.cookies,
      LIVE_SESSION_COOKIE_MIN_WEIGHT
    )
  ) {
    return entries[continuityIndex];
  }
  if (
    candidateSignals.cookies.size === 0 &&
    hasUniqueSignalProfile(entrySignals, continuityIndex, "storage") &&
    matchesContinuityProfile(
      candidateSignals.storage,
      liveSignals.storage,
      LIVE_SESSION_STORAGE_MIN_WEIGHT
    )
  ) {
    return entries[continuityIndex];
  }
  return null;
};

const matchLiveSession = (
  entries,
  liveCookies,
  liveSiteData,
  activeSessionId = null
) => {
  const liveSignature = signatureFromCookies(liveCookies, liveSiteData);
  const exactMatch = entries.find((entry) => {
    const entrySignature =
      entry.signature || signatureFromCookies(entry.cookies, entry.siteData);
    return entrySignature === liveSignature;
  });
  if (exactMatch) return { entry: exactMatch, matchType: "exact" };

  const entrySignals = entries.map((entry) =>
    buildLiveSessionSignals(entry.cookies, entry.siteData)
  );
  const liveSignals = buildLiveSessionSignals(liveCookies, liveSiteData);
  const robustMatch = findRobustLiveSession(
    entries,
    entrySignals,
    liveSignals,
    activeSessionId
  );
  return {
    entry: robustMatch,
    matchType: robustMatch ? "robust" : null,
  };
};

const hasStorageValues = (storageData) =>
  Object.values(storageData || {}).some(
    (value) => typeof value === "string" && value.length > 0
  );

const hasMeaningfulSiteData = (siteData) =>
  Boolean(siteData && (hasStorageValues(siteData.localStorage) || hasStorageValues(siteData.sessionStorage)));

const normalizeStorageSnapshot = (storageData, { strict = false } = {}) => {
  const snapshot = createRecord();
  if (!isRecord(storageData)) {
    if (strict && storageData != null) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return snapshot;
  }
  const entries = Object.entries(storageData);
  if (strict && entries.length > MAX_STORAGE_ENTRIES_PER_AREA) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  entries.forEach(([key, value]) => {
    if (typeof key !== "string" || typeof value !== "string") {
      if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
      return;
    }
    if (strict && (utf8ByteLength(key) > 4096 || utf8ByteLength(value) > MAX_SNAPSHOT_BYTES)) {
      throw createServiceError("ERR_INVALID_IMPORT_DATA");
    }
    snapshot[key] = value;
  });
  return snapshot;
};

const normalizeHttpOrigin = (value, owningDomain) => {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    if (owningDomain && normalizeDomain(parsed.hostname) !== owningDomain) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
};

const normalizePartitionKey = (partitionKey, owningDomain, { strict = false } = {}) => {
  if (!partitionKey || typeof partitionKey !== "object") return undefined;
  const topLevelSite = normalizeHttpOrigin(partitionKey.topLevelSite, null);
  if (!topLevelSite) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return undefined;
  }
  const topLevelHost = normalizeDomain(new URL(topLevelSite).hostname);
  const relatedToOwner =
    topLevelHost === owningDomain ||
    owningDomain.endsWith(`.${topLevelHost}`) ||
    topLevelHost.endsWith(`.${owningDomain}`);
  if (!relatedToOwner) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return undefined;
  }
  return {
    topLevelSite,
    hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor === true,
  };
};

const normalizeCookie = (cookie, owningDomain, { strict = false } = {}) => {
  if (!cookie || typeof cookie !== "object") {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }
  const cookieDomain = normalizeDomain(cookie.domain || owningDomain);
  const belongsToDomain =
    Boolean(cookieDomain) &&
    (cookieDomain === owningDomain || owningDomain.endsWith(`.${cookieDomain}`));
  const hostOnly = cookie.hostOnly === true;
  const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  if (
    !belongsToDomain ||
    (hostOnly && cookieDomain !== owningDomain) ||
    utf8ByteLength(cookie.name) > 1024 ||
    utf8ByteLength(cookie.value) > 16 * 1024 ||
    utf8ByteLength(path) > 2048
  ) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }

  const allowedSameSite = new Set(["unspecified", "no_restriction", "lax", "strict"]);
  if (strict && cookie.sameSite != null && !allowedSameSite.has(cookie.sameSite)) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  if (strict && cookie.storeId != null && cookie.storeId !== "0") {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  const sameSite = allowedSameSite.has(cookie.sameSite) ? cookie.sameSite : "unspecified";
  if (
    strict &&
    ((sameSite === "no_restriction" && cookie.secure !== true) ||
      (cookie.name.startsWith("__Secure-") && cookie.secure !== true) ||
      (cookie.name.startsWith("__Host-") &&
        (cookie.secure !== true || !hostOnly || path !== "/")))
  ) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  const expirationDate = Number(cookie.expirationDate);
  const normalized = {
    name: cookie.name,
    value: cookie.value,
    domain: cookieDomain,
    path,
    hostOnly,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite,
    expirationDate: Number.isFinite(expirationDate) && expirationDate > 0 ? expirationDate : undefined,
    storeId: cookie.storeId === "0" ? "0" : undefined,
    partitionKey: normalizePartitionKey(cookie.partitionKey, owningDomain, { strict }),
  };
  return normalized;
};

const normalizeSiteData = (
  siteData,
  owningDomain,
  fallbackOrigin = null,
  { strict = false } = {}
) => {
  if (!isRecord(siteData)) {
    if (strict && siteData != null) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }
  const localStorage = normalizeStorageSnapshot(siteData.localStorage, { strict });
  const sessionStorage = normalizeStorageSnapshot(siteData.sessionStorage, { strict });
  const providedOrigin = siteData.origin ? normalizeHttpOrigin(siteData.origin, owningDomain) : null;
  if (siteData.origin && !providedOrigin) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }
  const origin = providedOrigin || fallbackOrigin;

  if (!origin && !Object.keys(localStorage).length && !Object.keys(sessionStorage).length) {
    return null;
  }
  if (strict && !origin && (Object.keys(localStorage).length || Object.keys(sessionStorage).length)) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }

  return {
    origin,
    localStorage,
    sessionStorage,
  };
};

const normalizeSessionEntry = (
  entry,
  {
    owningDomain = "",
    fallbackLabelPrefix = "Saved",
    sourceFallback = "manual",
    strict = false,
    regenerateId = false,
  } = {}
) => {
  if (!entry || !Array.isArray(entry.cookies) || !owningDomain) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }
  if (strict && entry.cookies.length > MAX_COOKIES_PER_SNAPSHOT) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }

  const cookies = dedupeCookies(
    entry.cookies
      .map((cookie) => normalizeCookie(cookie, owningDomain, { strict }))
      .filter(Boolean)
  );
  const originUrl = entry.originUrl ? normalizeHttpOrigin(entry.originUrl, owningDomain) : null;
  if (strict && entry.originUrl && !originUrl) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  const siteData = normalizeSiteData(entry.siteData, owningDomain, originUrl, { strict });
  const signature = signatureFromCookies(cookies, siteData);

  if (!signature || (!cookies.length && !hasMeaningfulSiteData(siteData))) {
    if (strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return null;
  }

  const rawCreatedAt = Number(entry.createdAt);
  const createdAt =
    Number.isFinite(rawCreatedAt) && rawCreatedAt > 0 && rawCreatedAt <= Date.now() + 86400000
      ? rawCreatedAt
      : Date.now();
  const rawLabel =
    typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim()
      : `${fallbackLabelPrefix} ${new Date(createdAt).toLocaleString()}`;
  if (strict && rawLabel.length > MAX_LABEL_LENGTH) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  const label = rawLabel.slice(0, MAX_LABEL_LENGTH);
  const rawId = typeof entry.id === "string" ? entry.id : "";
  const validId = /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(rawId);

  const normalizedEntry = {
    id: regenerateId || !validId ? createRandomId(sourceFallback) : rawId,
    label,
    source:
      entry.source === "import"
        ? "import"
        : entry.source === "manual"
          ? "manual"
          : sourceFallback,
    createdAt,
    signature,
    cookies,
    siteData,
    originUrl: originUrl || siteData?.origin || null,
  };
  if (strict && jsonByteLength(normalizedEntry) > MAX_SNAPSHOT_BYTES) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }
  return normalizedEntry;
};

const normalizeStoredDomains = (domains, options = {}) => {
  if (!isRecord(domains)) {
    if (options.strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
    return createRecord();
  }
  const next = createRecord();
  const rawDomains = Object.entries(domains);
  if (options.strict && rawDomains.length > MAX_GLOBAL_DOMAINS) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  rawDomains.forEach(([domain, data]) => {
    if (options.strict && (!isRecord(data) || !Array.isArray(data.entries))) {
      throw createServiceError("ERR_INVALID_IMPORT_DATA");
    }
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) {
      if (options.strict) throw createServiceError("ERR_INVALID_IMPORT_DATA");
      return;
    }
    if (options.strict && next[normalizedDomain]) {
      throw createServiceError("ERR_INVALID_IMPORT_DATA");
    }

    const map = new Map();
    const usedIds = new Set();
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (options.strict && entries.length > MAX_ENTRIES_PER_DOMAIN) {
      throw createServiceError("ERR_INVALID_IMPORT_DATA");
    }
    entries.forEach((rawEntry) => {
      const entry = normalizeSessionEntry(rawEntry, {
        ...options,
        owningDomain: normalizedDomain,
      });
      if (!entry) return;
      if (usedIds.has(entry.id)) {
        entry.id = createRandomId(entry.source || "session");
      }
      usedIds.add(entry.id);
      const previous = map.get(entry.signature);
      if (!previous || (entry.createdAt || 0) >= (previous.createdAt || 0)) {
        map.set(entry.signature, previous ? { ...entry, id: previous.id } : entry);
      }
    });

    const normalizedEntries = Array.from(map.values()).slice(0, MAX_ENTRIES_PER_DOMAIN);
    const activeSessionId =
      typeof data?.activeSessionId === "string" &&
      normalizedEntries.some((entry) => entry.id === data.activeSessionId)
        ? data.activeSessionId
        : null;

    next[normalizedDomain] = activeSessionId
      ? { entries: normalizedEntries, activeSessionId }
      : { entries: normalizedEntries };
  });

  const domainList = Object.entries(next);
  if (domainList.length > MAX_GLOBAL_DOMAINS) {
    const sorted = domainList.map(([domain, data]) => {
      const newestCreatedAt = (data.entries || []).reduce((max, entry) => Math.max(max, Number(entry.createdAt) || 0), 0);
      return { domain, data, newestCreatedAt };
    }).sort((a, b) => b.newestCreatedAt - a.newestCreatedAt);
    
    const pruned = createRecord();
    sorted.slice(0, MAX_GLOBAL_DOMAINS).forEach((item) => {
      pruned[item.domain] = item.data;
    });
    return pruned;
  }

  return next;
};

const normalizeImportedState = (payload) => {
  if (jsonByteLength(payload) > MAX_IMPORT_BYTES) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }
  const raw = isRecord(payload?.state) && Object.hasOwn(payload.state, "domains")
    ? payload.state
    : payload;
  if (!isRecord(raw) || !isRecord(raw.domains)) {
    return null;
  }
  return {
    domains: normalizeStoredDomains(raw.domains, {
      fallbackLabelPrefix: "Imported",
      sourceFallback: "import",
      strict: true,
      regenerateId: true,
    }),
  };
};

const mergeImportedState = (current, incoming) => {
  const normalizedCurrent = normalizeStateShape(current);
  const next = {
    ...normalizedCurrent,
    domains: Object.assign(createRecord(), normalizedCurrent.domains || {}),
  };
  Object.entries(incoming.domains || {}).forEach(([domain, data]) => {
    const existingDomainState = next.domains[domain] || {};
    const existing = existingDomainState.entries || [];
    const existingActiveSessionId = getActiveSessionId(existingDomainState);
    const map = new Map();

    const upsertEntry = (rawEntry) => {
      const normalizedEntry = normalizeSessionEntry(rawEntry, {
        owningDomain: domain,
        fallbackLabelPrefix: "Imported",
        sourceFallback: "import",
      });
      if (!normalizedEntry) return;
      const sig = normalizedEntry.signature;
      const previous = map.get(sig);
      if (!previous) {
        map.set(sig, normalizedEntry);
        return;
      }
      const previousCreatedAt = Number(previous.createdAt) || 0;
      const incomingCreatedAt = Number(normalizedEntry.createdAt) || 0;
      const newer = incomingCreatedAt >= previousCreatedAt ? normalizedEntry : previous;
      const older = newer === normalizedEntry ? previous : normalizedEntry;
      map.set(sig, {
        ...older,
        ...newer,
        id: previous.id || normalizedEntry.id,
        label: (newer.label || older.label || "").trim() || previous.label || normalizedEntry.label,
        source: newer.source || older.source || "import",
        createdAt: Math.max(previousCreatedAt, incomingCreatedAt),
        cookies: Array.isArray(newer.cookies) && newer.cookies.length ? newer.cookies : older.cookies,
        siteData: hasMeaningfulSiteData(newer.siteData) ? newer.siteData : older.siteData,
        originUrl:
          newer.originUrl ||
          older.originUrl ||
          newer.siteData?.origin ||
          older.siteData?.origin ||
          null,
        signature: sig,
      });
    };

    existing.forEach(upsertEntry);
    (data.entries || []).forEach(upsertEntry);

    const mergedEntries = Array.from(map.values()).slice(0, MAX_ENTRIES_PER_DOMAIN);
    next.domains[domain] =
      existingActiveSessionId &&
      mergedEntries.some((entry) => entry.id === existingActiveSessionId)
        ? { entries: mergedEntries, activeSessionId: existingActiveSessionId }
        : { entries: mergedEntries };
  });
  return normalizeStateShape(next);
};

const serializeStateForExport = (state) => {
  const normalized = normalizeStateShape(state);
  return {
    domains: normalized.domains || {},
  };
};


const getStateRevision = (state) => {
  const revision = Number(state?._storageRevision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
};

const buildStateMetadataIndex = (state) => {
  const domains = createRecord();
  Object.entries(state?.domains || {}).forEach(([domain, domainState]) => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) return;
    domains[normalizedDomain] = {
      entries: (Array.isArray(domainState?.entries) ? domainState.entries : [])
        .slice(0, MAX_ENTRIES_PER_DOMAIN)
        .map((entry) => ({
          id: String(entry?.id || ""),
          label: String(entry?.label || "").slice(0, MAX_LABEL_LENGTH),
          createdAt: Number(entry?.createdAt) || 0,
        }))
        .filter((entry) => entry.id),
    };
  });
  return {
    revision: getStateRevision(state),
    domains,
  };
};

const normalizeStateMetadataIndex = (value) => {
  if (!isRecord(value) || !isRecord(value.domains)) return null;
  const revision = Math.floor(Number(value.revision) || 0);
  if (!Number.isSafeInteger(revision) || revision <= 0) return null;
  const domains = createRecord();
  Object.entries(value.domains)
    .slice(0, MAX_GLOBAL_DOMAINS)
    .forEach(([domain, domainState]) => {
      const normalizedDomain = normalizeDomain(domain);
      if (!normalizedDomain || !isRecord(domainState)) return;
      const entries = (Array.isArray(domainState.entries) ? domainState.entries : [])
        .slice(0, MAX_ENTRIES_PER_DOMAIN)
        .map((entry) => ({
          id: typeof entry?.id === "string" ? entry.id.slice(0, 128) : "",
          label: typeof entry?.label === "string" ? entry.label.slice(0, MAX_LABEL_LENGTH) : "",
          createdAt: Number(entry?.createdAt) || 0,
        }))
        .filter((entry) => entry.id);
      domains[normalizedDomain] = { entries };
    });
  return {
    revision,
    domains,
  };
};

const withNextStateRevision = (state) => {
  const normalized = normalizeStateShape(state);
  normalized._storageRevision = Math.max(Date.now(), getStateRevision(normalized) + 1);
  return normalized;
};

const persistStateMetadata = async (state) => {
  await chrome.storage.local.set({
    [STATE_METADATA_KEY]: buildStateMetadataIndex(state),
  });
};

const persistStateCopies = async (state, { requireSuccess = true } = {}) => {
  const metadataIndex = buildStateMetadataIndex(state);
  const results = await Promise.allSettled([
    idbSet(STORAGE_KEY, state),
    chrome.storage.local.set({
      [STORAGE_KEY]: state,
      [STATE_METADATA_KEY]: metadataIndex,
    }),
  ]);
  if (requireSuccess && results.every((result) => result.status === "rejected")) {
    throw createServiceError("ERR_STORAGE_WRITE_FAILED");
  }
  return results;
};

let stateCache = null;
let stateLoadPromise = null;

const loadStateFromStorage = async () => {
  const [idbResult, localResult] = await Promise.allSettled([
    idbGet(STORAGE_KEY),
    chrome.storage.local.get([STORAGE_KEY, STATE_METADATA_KEY]),
  ]);
  const idbState =
    idbResult.status === "fulfilled" && idbResult.value && typeof idbResult.value === "object"
      ? idbResult.value
      : null;
  const localValue = localResult.status === "fulfilled" ? localResult.value?.[STORAGE_KEY] : null;
  const localState = localValue && typeof localValue === "object" ? localValue : null;
  const localMetadata =
    localResult.status === "fulfilled"
      ? normalizeStateMetadataIndex(localResult.value?.[STATE_METADATA_KEY])
      : null;

  let selected = null;
  if (idbState && localState) {
    const idbRevision = getStateRevision(idbState);
    const localRevision = getStateRevision(localState);
    if (idbRevision === 0 && localRevision === 0) {
      selected = withNextStateRevision(
        mergeImportedState(normalizeStateShape(localState), normalizeStateShape(idbState))
      );
    } else {
      selected = normalizeStateShape(localRevision > idbRevision ? localState : idbState);
    }
  } else {
    selected = normalizeStateShape(idbState || localState || defaultState());
  }
  if (getStateRevision(selected) === 0) {
    selected = withNextStateRevision(selected);
  }

  const selectedRevision = getStateRevision(selected);
  const needsRepair =
    (idbResult.status === "fulfilled" &&
      (!idbState || getStateRevision(idbState) < selectedRevision)) ||
    (localResult.status === "fulfilled" &&
      (!localState || getStateRevision(localState) < selectedRevision));
  if (needsRepair) {
    await persistStateCopies(selected, { requireSuccess: false });
  } else if (!localMetadata || localMetadata.revision !== selectedRevision) {
    await persistStateMetadata(selected).catch(() => {});
  }
  return selected;
};

const getState = async () => {
  if (stateCache) return stateCache;
  if (!stateLoadPromise) stateLoadPromise = loadStateFromStorage();
  try {
    stateCache = await stateLoadPromise;
    return stateCache;
  } finally {
    stateLoadPromise = null;
  }
};

const getStateMetadataIndex = async () => {
  const data = await chrome.storage.local.get(STATE_METADATA_KEY);
  const storedIndex = normalizeStateMetadataIndex(data?.[STATE_METADATA_KEY]);
  if (
    storedIndex &&
    (!stateCache || storedIndex.revision === getStateRevision(stateCache))
  ) {
    return storedIndex;
  }

  const state = stateCache || await getState();
  const rebuiltIndex = buildStateMetadataIndex(state);
  await chrome.storage.local.set({ [STATE_METADATA_KEY]: rebuiltIndex }).catch(() => {});
  return rebuiltIndex;
};

void getStateMetadataIndex().catch(() => {});

const setState = async (state) => {
  const normalizedState = withNextStateRevision(state);
  await persistStateCopies(normalizedState);
  state._storageRevision = normalizedState._storageRevision;
  stateCache = normalizedState;
};

let stateTaskQueue = Promise.resolve();

const runStateTask = (task) => {
  const run = () =>
    Promise.resolve()
      .then(task)
      .catch((error) => {
        stateCache = null;
        stateLoadPromise = null;
        throw error;
      });
  const result = stateTaskQueue.then(run, run);
  stateTaskQueue = result.catch(() => {});
  return result;
};

const SESSION_LINK_MENU_ROOT_ID = "cookieswapper-link-root";
const SESSION_LINK_MENU_ACTION_ID = "cookieswapper-link-action";
const SESSION_LINK_MENU_ENTRY_PREFIX = "cookieswapper-link-session:";
let sessionLinkMenuRefreshQueue = Promise.resolve();

const callContextMenuApi = (method, ...args) =>
  new Promise((resolve, reject) => {
    try {
      chrome.contextMenus[method](...args, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "Context menu update failed"));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });

const makeSessionLinkMenuEntryId = (domain, id) =>
  `${SESSION_LINK_MENU_ENTRY_PREFIX}${encodeURIComponent(domain)}|${encodeURIComponent(id)}`;

const parseSessionLinkMenuEntryId = (menuItemId) => {
  if (typeof menuItemId !== "string" || !menuItemId.startsWith(SESSION_LINK_MENU_ENTRY_PREFIX)) {
    return null;
  }
  const encodedParts = menuItemId.slice(SESSION_LINK_MENU_ENTRY_PREFIX.length);
  const separator = encodedParts.indexOf("|");
  if (separator < 0) return null;
  try {
    const domain = normalizeDomain(decodeURIComponent(encodedParts.slice(0, separator)));
    const id = decodeURIComponent(encodedParts.slice(separator + 1));
    return domain && id ? { domain, id } : null;
  } catch (_) {
    return null;
  }
};

const contextMenuLabel = (entry, domain, origin) => {
  const label = String(entry?.label || "Saved session")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  let host = domain;
  try {
    host = new URL(origin).host;
  } catch (_) {}
  return `${label || "Saved session"} (${host})`;
};

const rebuildSessionLinkContextMenu = async () => {
  if (!chrome.contextMenus?.create || !chrome.contextMenus?.removeAll) return false;
  const state = await getState();
  const menuEntries = [];
  Object.entries(state.domains || {}).forEach(([rawDomain, domainState]) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) return;
    (domainState?.entries || []).forEach((entry) => {
      const origin = normalizeHttpOrigin(
        entry.siteData?.origin || entry.originUrl || `https://${domain}`,
        domain
      );
      if (!origin || typeof entry.id !== "string" || !entry.id) return;
      menuEntries.push({ domain, entry, origin });
    });
  });

  await callContextMenuApi("removeAll");
  if (!menuEntries.length) return true;

  const targetUrlPatterns = [...new Set(menuEntries.map(({ origin }) => `${origin}/*`))];
  const creations = [
    callContextMenuApi("create", {
      id: SESSION_LINK_MENU_ROOT_ID,
      title: "CookieSwapper",
      contexts: ["link"],
      targetUrlPatterns,
    }),
    callContextMenuApi("create", {
      id: SESSION_LINK_MENU_ACTION_ID,
      parentId: SESSION_LINK_MENU_ROOT_ID,
      title: "Open link as",
      contexts: ["link"],
      targetUrlPatterns,
    }),
    ...menuEntries.map(({ domain, entry, origin }) =>
      callContextMenuApi("create", {
        id: makeSessionLinkMenuEntryId(domain, entry.id),
        parentId: SESSION_LINK_MENU_ACTION_ID,
        title: contextMenuLabel(entry, domain, origin),
        contexts: ["link"],
        targetUrlPatterns: [`${origin}/*`],
      })
    ),
  ];

  await Promise.all(creations);
  if (typeof chrome.contextMenus.refresh === "function") {
    await callContextMenuApi("refresh");
  }
  return true;
};

const scheduleSessionLinkContextMenuRefresh = () => {
  if (!chrome.contextMenus?.create) return Promise.resolve(false);
  const refresh = () => rebuildSessionLinkContextMenu();
  const result = sessionLinkMenuRefreshQueue.then(refresh, refresh);
  sessionLinkMenuRefreshQueue = result.catch((error) => {
    console.warn("CookieSwapper could not refresh its link menu", error?.message || error);
    return false;
  });
  return sessionLinkMenuRefreshQueue;
};

if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes?.[STORAGE_KEY]) return;
    const nextRevision = getStateRevision(changes[STORAGE_KEY].newValue);
    if (!stateCache || nextRevision !== getStateRevision(stateCache)) {
      stateCache = null;
      stateLoadPromise = null;
    }
  });
}

const getDomainCandidates = (domain) => {
  const normalized = normalizeDomain(domain);
  if (!normalized) return [];
  if (
    normalized === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized) ||
    normalized.startsWith("[")
  ) {
    return [normalized];
  }
  const parts = normalized.split(".");
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    if (candidate.split(".").length >= 2) {
      candidates.push(candidate);
    }
  }
  return candidates;
};

const cookieMatchesHost = (cookie, host) => {
  if (!host) return true;
  const normalizedHost = normalizeDomain(host);
  if (!normalizedHost) return true;
  const cookieDomain = normalizeDomain(cookie.domain || "");
  if (!cookieDomain) return false;
  if (cookie.hostOnly) return normalizedHost === cookieDomain;
  if (normalizedHost === cookieDomain) return true;
  return normalizedHost.endsWith(`.${cookieDomain}`);
};

const getCurrentPartitionKey = async (tabId) => {
  if (!tabId || typeof chrome.cookies.getPartitionKey !== "function") return null;
  try {
    const result = await chrome.cookies.getPartitionKey({ tabId, frameId: 0 });
    return result?.partitionKey || null;
  } catch (_) {
    return null;
  }
};

const collectCookiesForDomain = async (domain, url, tabId = null) => {
  const normalizedDomain = normalizeDomain(domain);
  let host = null;
  const partitionKeyPromise = getCurrentPartitionKey(tabId);

  const queries = [];
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch (_) {
      host = null;
    }
    queries.push({ url });
  }

  const candidates = getDomainCandidates(normalizedDomain);
  for (const candidate of candidates) {
    queries.push({ domain: candidate });
  }

  const regularCookiesPromise = Promise.all(
    queries.map((query) => chrome.cookies.getAll(query))
  );
  const partitionKey = await partitionKeyPromise;
  const partitionedCookiesPromise = partitionKey
    ? Promise.all(
        queries.map((query) =>
          chrome.cookies.getAll({ ...query, partitionKey }).catch(() => [])
        )
      )
    : Promise.resolve([]);
  const [regularCookies, partitionedCookies] = await Promise.all([
    regularCookiesPromise,
    partitionedCookiesPromise,
  ]);
  const collected = [...regularCookies.flat(), ...partitionedCookies.flat()];
  const cookies = dedupeCookies(collected.map(toStorableCookie)).filter(
    (cookie) => !isLegacyMarkerCookie(cookie)
  );
  if (host) {
    return cookies.filter((cookie) => cookieMatchesHost(cookie, host));
  }
  return cookies;
};

const collectLegacyMarkerCookiesForDomain = async (domain, url) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return [];

  const queries = [];
  let host = normalizedDomain;

  if (url) {
    try {
      host = new URL(url).hostname;
      queries.push({ url });
    } catch (_) {
      host = normalizedDomain;
    }
  }

  const candidates = getDomainCandidates(normalizedDomain);
  for (const candidate of candidates) {
    queries.push({ domain: candidate });
  }
  const collected = (await Promise.all(queries.map((query) => chrome.cookies.getAll(query)))).flat();

  return dedupeCookies(collected.map(toStorableCookie)).filter(
    (cookie) => isLegacyMarkerCookie(cookie) && cookieMatchesHost(cookie, host)
  );
};

const clearLegacySessionMarkerCookie = async (domain, url) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return false;

  try {
    const markerCookies = await collectLegacyMarkerCookiesForDomain(normalizedDomain, url);
    if (!markerCookies.length) return false;
    const removals = await Promise.allSettled(
      markerCookies.map(async (cookie) => {
        const removeDetails = {
          url: buildCookieUrl(cookie, normalizedDomain),
          name: cookie.name,
        };
        if (cookie.storeId) {
          removeDetails.storeId = cookie.storeId;
        }
        if (cookie.partitionKey) {
          removeDetails.partitionKey = cookie.partitionKey;
        }
        const expectation = rememberExpectedCookieMutation(cookie, "remove");
        try {
          const removedCookie = await chrome.cookies.remove(removeDetails);
          if (!removedCookie) forgetExpectedCookieMutation(expectation);
          return removedCookie;
        } catch (error) {
          forgetExpectedCookieMutation(expectation);
          throw error;
        }
      })
    );
    return removals.some(
      (result) => result.status === "fulfilled" && result.value != null
    );
  } catch (_) {
    return false;
  }
};

const waitForTabComplete = (tabId, timeoutMs = 15000) =>
  new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (updatedTabId, info, tab) => {
      if (updatedTabId !== tabId) return;
      if (info.status !== "complete") return;
      cleanup();
      resolve(tab?.url || null);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });

const urlHasSameOrigin = (value, target) => {
  try {
    return new URL(value || "").origin === new URL(target || "").origin;
  } catch (_) {
    return false;
  }
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const captureSiteStorage = async (tabId, limitBytes = MAX_SNAPSHOT_BYTES) => {
  if (!tabId) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [limitBytes],
      func: (maxBytes) => {
        const encoder = new TextEncoder();
        let capturedBytes = 0;
        let tooLarge = false;
        const dump = (storage) => {
          const data = Object.create(null);
          try {
            for (let i = 0; i < storage.length; i += 1) {
              const key = storage.key(i);
              const value = storage.getItem(key);
              capturedBytes += encoder.encode(key || "").byteLength;
              capturedBytes += encoder.encode(value || "").byteLength;
              if (capturedBytes > maxBytes) {
                tooLarge = true;
                break;
              }
              data[key] = value;
            }
          } catch (_) {}
          return data;
        };
        let local = {};
        let session = {};
        try {
          local = dump(localStorage);
        } catch (_) {}
        try {
          session = dump(sessionStorage);
        } catch (_) {}
        return {
          origin: location.origin,
          localStorage: local,
          sessionStorage: session,
          tooLarge,
        };
      },
    });
    return result?.result || null;
  } catch (_) {
    return null;
  }
};

const clearTabSiteStorage = async (tabId, url) => {
  if (!tabId) return false;
  let expectedOrigin = null;
  if (url) {
    try {
      expectedOrigin = new URL(url).origin;
    } catch (_) {
      expectedOrigin = null;
    }
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [expectedOrigin],
      func: (origin) => {
        if (origin && location.origin !== origin) return false;
        let success = true;
        try {
          localStorage.clear();
        } catch (_) {
          success = false;
        }
        try {
          sessionStorage.clear();
        } catch (_) {
          success = false;
        }
        return success;
      },
    });
    return result?.result === true;
  } catch (_) {
    return false;
  }
};

const normalizeHttpTargetUrl = (value) => {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
};

const urlsHaveSameNavigationTarget = (value, target) => {
  try {
    const left = new URL(value || "");
    const right = new URL(target || "");
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch (_) {
    return false;
  }
};

const applySiteStorage = async (tabId, siteData, url) => {
  if (!tabId) return false;
  if (!siteData) return true;
  if (url && siteData.origin) {
    try {
      const origin = new URL(url).origin;
      if (origin !== siteData.origin) return false;
    } catch (_) {
      return false;
    }
  }
  try {
    const storagePayload = {
      localStorage: Object.entries(normalizeStorageSnapshot(siteData.localStorage)),
      sessionStorage: Object.entries(normalizeStorageSnapshot(siteData.sessionStorage)),
    };
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [storagePayload],
      func: (payload) => {
        let success = true;
        const apply = (storage, data) => {
          try {
            storage.clear();
          } catch (_) {
            success = false;
          }
          if (!data) return;
          const entries = Array.isArray(data) ? data : Object.entries(data);
          entries.forEach(([key, value]) => {
            try {
              storage.setItem(key, value);
            } catch (_) {
              success = false;
            }
          });
        };
        try {
          apply(localStorage, payload.localStorage);
        } catch (_) {}
        try {
          apply(sessionStorage, payload.sessionStorage);
        } catch (_) {}
        return success;
      },
    });
    return result?.result === true;
  } catch (_) {
    return false;
  }
};

const inspectTabAuthState = async (tabId) => {
  if (!tabId) {
    return { looksLoggedOut: false, score: 0, reasons: ["no-tab"] };
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = (value) =>
          String(value || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        const visible = (element) => {
          if (!(element instanceof Element)) return false;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };

        const loginTerms = [
          "log in",
          "login",
          "sign in",
          "signin",
          "sign up",
          "signup",
          "register",
          "create account",
          "continue with",
          "login with",
          "sign in with",
          "access account",
          "iniciar sesion",
          "iniciar sesión",
          "acceder",
          "entrar",
          "registrarse",
          "crear cuenta",
          "continuar con",
          "se connecter",
          "connexion",
          "s'inscrire",
          "anmelden",
          "einloggen",
          "registrieren",
          "accedi",
          "registrati",
          "iniciar sessão",
          "entrar com",
          "criar conta",
          "ログイン",
          "サインイン",
          "新規登録",
          "로그인",
          "회원가입",
          "войти",
          "зарегистрироваться",
          "\u767b\u5f55",
          "\u767b\u5165",
          "\u6ce8\u518c",
          "\u7ee7\u7eed",
          "\u4f7f\u7528",
        ];
        const loggedInTerms = [
          "log out",
          "logout",
          "sign out",
          "my account",
          "cerrar sesion",
          "cerrar sesión",
          "mi cuenta",
          "se déconnecter",
          "mon compte",
          "abmelden",
          "mein konto",
          "disconnetti",
          "il mio account",
          "sair",
          "minha conta",
          "ログアウト",
          "マイアカウント",
          "로그아웃",
          "내 계정",
          "выйти",
          "мой аккаунт",
          "\u9000\u51fa",
          "\u6211\u7684\u5e10\u6237",
        ];
        const expiredTerms = [
          "session expired",
          "session has expired",
          "please sign in",
          "please log in",
          "your session ended",
          "tu sesion ha caducado",
          "tu sesión ha caducado",
          "vuelve a iniciar sesion",
          "vuelve a iniciar sesión",
          "session expirée",
          "veuillez vous connecter",
          "sitzung abgelaufen",
          "bitte erneut anmelden",
          "sessione scaduta",
          "accedi di nuovo",
          "sessão expirada",
          "inicie sessão novamente",
          "セッションの有効期限が切れ",
          "再度ログイン",
          "세션이 만료",
          "다시 로그인",
          "сессия истекла",
          "войдите снова",
          "\u4f1a\u8bdd\u5df2\u8fc7\u671f",
          "\u8bf7\u91cd\u65b0\u767b\u5f55",
        ];

        const authPathPattern = /(login|log-in|signin|sign-in|auth|oauth|sso|session-expired|account\/login|reauth)/i;
        const passwordInputs = Array.from(
          document.querySelectorAll("input[type='password']:not([disabled])")
        ).filter(visible);
        const emailInputs = Array.from(
          document.querySelectorAll("input[type='email']:not([disabled]), input[name*='email']:not([disabled])")
        ).filter(visible);
        const authForms = Array.from(document.forms || []).filter((form) => {
          if (!visible(form)) return false;
          const passwordInput = form.querySelector("input[type='password']:not([disabled])");
          const emailInput = form.querySelector(
            "input[type='email']:not([disabled]), input[name*='email']:not([disabled])"
          );
          const identityInput = emailInput || form.querySelector(
            "input[autocomplete='username']:not([disabled]), input[name*='user']:not([disabled]), input[name*='login']:not([disabled])"
          );
          const submitControl = form.querySelector(
            "button[type='submit'], input[type='submit']"
          );
          const formLabel = normalize(
            [
              form.innerText,
              form.textContent,
              form.getAttribute("aria-label"),
              form.getAttribute("action"),
            ]
              .filter(Boolean)
              .join(" ")
          );
          const hasAuthPurpose =
            authPathPattern.test(form.getAttribute("action") || "") ||
            loginTerms.some((term) => formLabel.includes(term));
          return Boolean(
            submitControl &&
              ((passwordInput && identityInput) ||
                (hasAuthPurpose && (passwordInput || emailInput)))
          );
        });

        const authLinkPattern = /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|join|auth)(?:\/|$|[?#])/i;
        const accountPathPattern = /(?:^|\/)(?:settings|account\/settings|my-account|me)(?:\/|$|[?#])/i;
        const authElements = Array.from(
          document.querySelectorAll(
            "button, a[href], [role='button'], input[type='button'], input[type='submit']"
          )
        )
          .filter(visible)
          .map((element) => ({
            label: normalize(
              [
                element.innerText,
                element.textContent,
                element.getAttribute("aria-label"),
                element.getAttribute("title"),
                element.value,
              ]
                .filter(Boolean)
                .join(" ")
            ),
            href: normalize(element.getAttribute("href")),
          }))
          .filter(({ label, href }) => label || href);

        const authActionCount = authElements.filter(({ label, href }) =>
          loginTerms.some((term) => label.includes(term)) || authLinkPattern.test(href)
        ).length;
        // Public profile links are common on signed-out pages, so only explicit
        // account and sign-out actions count as evidence of an active account.
        const loggedInIndicatorCount = authElements.filter(({ label, href }) =>
          loggedInTerms.some((term) => label.includes(term)) || accountPathPattern.test(href)
        ).length;
        const pageText = normalize(document.body?.innerText || "");
        const hasExpiredText = expiredTerms.some((term) => pageText.includes(term));
        const urlLooksAuth = authPathPattern.test(
          `${location.pathname}${location.search}${location.hash}`
        );

        let score = 0;
        const reasons = [];
        if (urlLooksAuth) {
          score += 3;
          reasons.push("auth-url");
        }
        if (passwordInputs.length) {
          score += 5;
          reasons.push("password-input");
        }
        if (authForms.length) {
          score += 3;
          reasons.push("auth-form");
        }
        if (emailInputs.length && (passwordInputs.length || authForms.length)) {
          score += 1;
          reasons.push("email-input");
        }
        if (authActionCount) {
          score += Math.min(authActionCount, 3);
          reasons.push(`auth-actions:${authActionCount}`);
        }
        if (hasExpiredText) {
          score += 4;
          reasons.push("expired-text");
        }
        if (loggedInIndicatorCount) {
          score -= Math.min(loggedInIndicatorCount, 2) * 2;
          reasons.push(`logged-in-indicators:${loggedInIndicatorCount}`);
        }

        const hasLoggedOutSignal = Boolean(
          passwordInputs.length ||
            authForms.length ||
            authActionCount ||
            hasExpiredText ||
            urlLooksAuth
        );
        const hasLoggedInSignal = loggedInIndicatorCount > 0;
        const hasInteractiveAuthForm = authForms.length > 0;
        const looksLoggedOut = Boolean(
          !hasLoggedInSignal &&
            (hasExpiredText ||
              hasInteractiveAuthForm ||
              (urlLooksAuth && (passwordInputs.length > 0 || authActionCount > 0)))
        );

        return {
          looksLoggedOut,
          hasLoggedOutSignal,
          hasLoggedInSignal,
          score,
          reasons,
          authActionCount,
          passwordInputCount: passwordInputs.length,
          authFormCount: authForms.length,
          loggedInIndicatorCount,
          hasExpiredText,
          urlLooksAuth,
          href: location.href,
        };
      },
    });
    return result?.result || { looksLoggedOut: false, score: 0, reasons: ["no-result"] };
  } catch (_) {
    return {
      looksLoggedOut: false,
      score: 0,
      reasons: ["inspect-error"],
    };
  }
};

const urlsHaveRelatedHosts = (left, right) => {
  try {
    const leftHost = normalizeDomain(new URL(left).hostname);
    const rightHost = normalizeDomain(new URL(right).hostname);
    return (
      Boolean(leftHost) &&
      Boolean(rightHost) &&
      (leftHost === rightHost ||
        leftHost.endsWith(`.${rightHost}`) ||
        rightHost.endsWith(`.${leftHost}`))
    );
  } catch (_) {
    return false;
  }
};

const SESSION_INSPECTION_INITIAL_DELAY_MS = 100;
const SESSION_INSPECTION_CONFIRM_DELAY_MS = 250;
const EXTERNAL_CHANGE_INSPECTION_CHECKPOINTS_MS = [100, 500, 1400];

const inspectLoadedSession = async (
  tabId,
  expectedUrl,
  initialUrl = null,
  evidenceReason = "unknown"
) => {
  let completedUrl = initialUrl || null;
  let authCheck = null;
  const startedAt = Date.now();

  const initialTab = await chrome.tabs.get(tabId).catch(() => null);
  if (initialTab?.url) completedUrl = initialTab.url;
  let initialIsWebPage = false;
  try {
    initialIsWebPage = /^https?:$/.test(new URL(completedUrl || "").protocol);
  } catch (_) {}
  const initialHostMatches = Boolean(
    initialIsWebPage && (!expectedUrl || urlsHaveRelatedHosts(completedUrl, expectedUrl))
  );
  if (!initialIsWebPage || !initialHostMatches) {
    return {
      invalidSession: true,
      authCheck: null,
      completedUrl: completedUrl || null,
    };
  }

  const inspectAt = async (checkpointMs) => {
    const remainingDelay = Math.max(0, checkpointMs - (Date.now() - startedAt));
    if (remainingDelay) await sleep(remainingDelay);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) completedUrl = tab.url;

    let isWebPage = false;
    try {
      isWebPage = /^https?:$/.test(new URL(completedUrl || "").protocol);
    } catch (_) {}

    authCheck = isWebPage
      ? await inspectTabAuthState(tabId)
      : { looksLoggedOut: false, score: 0, reasons: ["non-web-page"] };
    let expectedHostMatches = false;
    try {
      expectedHostMatches = !expectedUrl || urlsHaveRelatedHosts(completedUrl, expectedUrl);
    } catch (_) {}
    return {
      invalidSession: !isWebPage || !expectedHostMatches || Boolean(authCheck?.looksLoggedOut),
      authCheck,
      completedUrl: completedUrl || null,
    };
  };

  if (evidenceReason === "external-removal") {
    let result = null;
    let consecutiveLoggedOutChecks = 0;
    for (const checkpoint of EXTERNAL_CHANGE_INSPECTION_CHECKPOINTS_MS) {
      result = await inspectAt(checkpoint);
      if (!result.completedUrl || !urlsHaveRelatedHosts(result.completedUrl, expectedUrl)) {
        return result;
      }
      consecutiveLoggedOutChecks = result.authCheck?.looksLoggedOut
        ? consecutiveLoggedOutChecks + 1
        : 0;
      if (consecutiveLoggedOutChecks >= 2) return result;
    }
    return result;
  }

  const initialResult = await inspectAt(SESSION_INSPECTION_INITIAL_DELAY_MS);
  const needsConfirmation = Boolean(
    initialResult.authCheck?.looksLoggedOut ||
      hasProbableLoggedOutSignal(initialResult.authCheck)
  );
  if (!needsConfirmation) {
    return initialResult;
  }
  return inspectAt(SESSION_INSPECTION_INITIAL_DELAY_MS + SESSION_INSPECTION_CONFIRM_DELAY_MS);
};

const verifyAppliedSession = async (tabId, expectedUrl = null, evidenceReason = "unknown") => {
  if (!tabId) {
    return {
      invalidSession: false,
      authCheck: null,
      completedUrl: null,
    };
  }
  const completePromise = waitForTabComplete(tabId);
  await chrome.tabs.reload(tabId);
  let completedUrl = await completePromise;
  if (!completedUrl) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    completedUrl = tab?.url || null;
  }
  return inspectLoadedSession(tabId, expectedUrl, completedUrl, evidenceReason);
};

const buildCookieSetDetails = (cookie, fallbackDomain) => {
  const details = {
    url: buildCookieUrl(cookie, fallbackDomain),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
  };
  if (!cookie.hostOnly && cookie.domain) {
    details.domain = cookie.domain;
  }
  if (cookie.expirationDate) {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }
  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }
  return details;
};

const isCookieExpired = (cookie, now = Date.now()) => {
  const expirationDate = Number(cookie?.expirationDate);
  return (
    Number.isFinite(expirationDate) &&
    expirationDate > 0 &&
    expirationDate <= now / 1000 + COOKIE_EXPIRY_SAFETY_WINDOW_SECONDS
  );
};

const writeCookieSnapshot = async (cookies, fallbackDomain) => {
  const failures = [];
  let applied = 0;
  const uniqueCookies = dedupeCookies(cookies || []);
  const restorableCookies = uniqueCookies.filter((cookie) => !isCookieExpired(cookie));
  const skippedExpired = uniqueCookies.length - restorableCookies.length;
  const writeCookie = async (cookie) => {
    const expectation = rememberExpectedCookieMutation(cookie, "set");
    try {
      const writtenCookie = await chrome.cookies.set(buildCookieSetDetails(cookie, fallbackDomain));
      if (!writtenCookie) {
        forgetExpectedCookieMutation(expectation);
        return { applied: false, failure: { name: cookie.name, message: "Cookie was not accepted" } };
      }
      return { applied: true, failure: null };
    } catch (error) {
      forgetExpectedCookieMutation(expectation);
      return {
        applied: false,
        failure: { name: cookie.name, message: error?.message || String(error) },
      };
    }
  };

  for (let index = 0; index < restorableCookies.length; index += COOKIE_WRITE_BATCH_SIZE) {
    const batch = restorableCookies.slice(index, index + COOKIE_WRITE_BATCH_SIZE);
    const results = await Promise.all(batch.map(writeCookie));
    for (const result of results) {
      if (result.applied) applied += 1;
      if (result.failure) failures.push(result.failure);
    }
  }
  return { applied, failures, skippedExpired };
};

const restoreCookieSnapshot = async (domain, cookies, url, tabId) => {
  try { await clearSiteCookies(domain, url, tabId); } catch (_) {}
  try { await writeCookieSnapshot(cookies, domain); } catch (_) {}
};

const restoreSessionSnapshot = async (domain, cookies, siteData, url, tabId) => {
  await restoreCookieSnapshot(domain, cookies, url, tabId);
  try { await clearSiteData(url); } catch (_) {}
  try { await clearTabSiteStorage(tabId, url); } catch (_) {}
  try { await applySiteStorage(tabId, siteData, url); } catch (_) {}
};

const updateAppliedSessionState = async (
  domain,
  id,
  { active, url = null, tabId = null, refreshCookies = false } = {}
) => {
  const normalizedDomain = normalizeDomain(domain);
  const state = await getState();
  const domainState = state.domains[normalizedDomain];
  const entry = domainState?.entries?.find((item) => item.id === id);
  if (!entry) return null;

  let changed = false;
  if (active) {
    if (refreshCookies) {
      const previousSnapshot = {
        cookies: entry.cookies,
        siteData: entry.siteData,
        originUrl: entry.originUrl,
        signature: entry.signature,
      };
      let snapshotRefreshed = false;
      const [freshCookiesResult, freshSiteDataResult] = await Promise.allSettled([
        collectCookiesForDomain(normalizedDomain, url, tabId),
        captureSiteStorage(tabId),
      ]);
      if (freshCookiesResult.status === "fulfilled") {
        const freshCookies = freshCookiesResult.value;
        if (freshCookies.length <= MAX_COOKIES_PER_SNAPSHOT) {
          entry.cookies = freshCookies.map(toStorableCookie);
          snapshotRefreshed = true;
        }
      }

      if (freshSiteDataResult.status === "fulfilled") {
        const freshSiteData = freshSiteDataResult.value;
        const expectedOrigin = normalizeHttpOrigin(
          url || entry.originUrl || entry.siteData?.origin,
          normalizedDomain
        );
        const capturedOrigin = freshSiteData?.origin
          ? normalizeHttpOrigin(freshSiteData.origin, normalizedDomain)
          : null;
        if (
          freshSiteData &&
          !freshSiteData.tooLarge &&
          capturedOrigin &&
          (!expectedOrigin || capturedOrigin === expectedOrigin)
        ) {
          entry.siteData = normalizeSiteData(
            freshSiteData,
            normalizedDomain,
            capturedOrigin
          );
          entry.originUrl = capturedOrigin;
          snapshotRefreshed = true;
        }
      }

      if (snapshotRefreshed) {
        entry.signature = signatureFromCookies(entry.cookies, entry.siteData);
        if (
          jsonByteLength(entry) > MAX_SNAPSHOT_BYTES ||
          jsonByteLength(serializeStateForExport(state)) > MAX_TOTAL_STATE_BYTES
        ) {
          entry.cookies = previousSnapshot.cookies;
          entry.siteData = previousSnapshot.siteData;
          entry.originUrl = previousSnapshot.originUrl;
          entry.signature = previousSnapshot.signature;
        } else {
          domainState.entries = domainState.entries.filter((item) => {
            if (item.id === entry.id) return true;
            const itemSignature =
              item.signature || signatureFromCookies(item.cookies, item.siteData);
            return itemSignature !== entry.signature;
          });
          changed = true;
        }
      }
    }
    changed = setActiveSession(state, normalizedDomain, id) || changed;
  } else {
    changed = clearActiveSession(state, normalizedDomain) || changed;
  }

  if (changed) {
    await setState(state);
  }
  return {
    changed,
    domainState: buildDomainStateSnapshot(state, normalizedDomain),
  };
};

const toSessionMetadata = (entry) => ({
  id: entry.id,
  label: entry.label,
  createdAt: entry.createdAt,
});

const toSessionMetadataList = (entries) =>
  (Array.isArray(entries) ? entries : []).map(toSessionMetadata);

const buildDomainStateSnapshot = (state, domain) => {
  const normalizedDomain = normalizeDomain(domain);
  const domainState = state?.domains?.[normalizedDomain];
  const entries = domainState?.entries || [];
  const activeSessionId = getActiveSessionId(domainState);
  const currentSessionIds =
    activeSessionId && entries.some((entry) => entry.id === activeSessionId)
      ? [activeSessionId]
      : [];
  return {
    domain: normalizedDomain,
    requestedDomain: normalizedDomain,
    entriesDomain: normalizedDomain,
    usingDomainHint: false,
    entries: toSessionMetadataList(entries),
    currentSessionIds,
  };
};

const listMetadataForDomain = async (domain, tabId) => {
  const normalizedDomain = normalizeDomain(domain);
  const index = await getStateMetadataIndex();
  const entries = index.domains[normalizedDomain]?.entries || [];
  const hint = await getRecentTabDomainHint(tabId, normalizedDomain, index);
  const hintedEntries = hint ? index.domains[hint.domain]?.entries || [] : [];

  if (hint?.reason === "post_logout_redirect" && hintedEntries.length) {
    return {
      domain: normalizedDomain,
      requestedDomain: normalizedDomain,
      entriesDomain: hint.domain,
      usingDomainHint: true,
      domainHintReason: hint.reason,
      entries: hintedEntries,
      currentSessionIds: [],
      verificationPending: true,
    };
  }

  if (entries.length) {
    return {
      domain: normalizedDomain,
      requestedDomain: normalizedDomain,
      entriesDomain: normalizedDomain,
      usingDomainHint: false,
      entries,
      currentSessionIds: [],
      verificationPending: true,
    };
  }

  if (hint && hintedEntries.length) {
    return {
      domain: normalizedDomain,
      requestedDomain: normalizedDomain,
      entriesDomain: hint.domain,
      usingDomainHint: true,
      domainHintReason: hint.reason,
      entries: hintedEntries,
      currentSessionIds: [],
      verificationPending: true,
    };
  }

  return {
    domain: normalizedDomain,
    requestedDomain: normalizedDomain,
    entriesDomain: normalizedDomain,
    usingDomainHint: false,
    entries: [],
    currentSessionIds: [],
    verificationPending: true,
  };
};

const findLiveSession = async (
  entries,
  domain,
  url,
  tabId,
  activeSessionId = null
) => {
  const normalizedDomain = normalizeDomain(domain);
  const numericTabId = Number(tabId);
  const expectedOrigin = normalizeHttpOrigin(url, normalizedDomain);
  if (
    !normalizedDomain ||
    !expectedOrigin ||
    !Number.isInteger(numericTabId) ||
    numericTabId <= 0 ||
    !Array.isArray(entries) ||
    !entries.length
  ) {
    return { verified: false, sessionId: null };
  }

  let liveCookies;
  let capturedSiteData;
  try {
    [liveCookies, capturedSiteData] = await Promise.all([
      collectCookiesForDomain(normalizedDomain, url, numericTabId),
      captureSiteStorage(numericTabId),
    ]);
  } catch (_) {
    return { verified: false, sessionId: null };
  }

  const capturedOrigin = capturedSiteData?.origin
    ? normalizeHttpOrigin(capturedSiteData.origin, normalizedDomain)
    : null;
  if (
    !capturedSiteData ||
    capturedSiteData.tooLarge ||
    !capturedOrigin ||
    capturedOrigin !== expectedOrigin
  ) {
    return { verified: false, sessionId: null };
  }

  const liveSiteData = normalizeSiteData(
    capturedSiteData,
    normalizedDomain,
    capturedOrigin
  );
  const match = matchLiveSession(
    entries,
    liveCookies,
    liveSiteData,
    activeSessionId
  );

  return {
    verified: true,
    sessionId: match.entry?.id || null,
    matchType: match.matchType,
  };
};

const resolveDomainState = async (state, domain, url, tabId) => {
  const normalizedDomain = normalizeDomain(domain);
  const domainState = state.domains[normalizedDomain];
  const entries = domainState?.entries || [];
  let stateChanged = false;
  const activeSessionId = getActiveSessionId(domainState);
  let currentSessionIds = [];

  if (activeSessionId && !entries.some((entry) => entry.id === activeSessionId)) {
    stateChanged = clearActiveSession(state, normalizedDomain, activeSessionId) || stateChanged;
  }

  const [liveSession, hint] = await Promise.all([
    findLiveSession(entries, normalizedDomain, url, tabId, activeSessionId),
    getRecentTabDomainHint(tabId, normalizedDomain, state),
    clearLegacySessionMarkerCookie(normalizedDomain, url || null),
  ]);
  if (liveSession.verified) {
    if (liveSession.sessionId) {
      currentSessionIds = [liveSession.sessionId];
      stateChanged =
        setActiveSession(state, normalizedDomain, liveSession.sessionId) || stateChanged;
    } else {
      stateChanged = clearActiveSession(state, normalizedDomain) || stateChanged;
    }
  }

  if (stateChanged) {
    await setState(state);
  }

  // A post_logout_redirect hint takes top priority: the user just logged out from
  // the hinted domain and the browser redirected them here. We show the hinted
  // domain's sessions even when the current domain has sessions of its own.
  if (hint && hint.reason === "post_logout_redirect") {
    const hintedDomainState = state.domains[hint.domain];
    const hintedEntries = hintedDomainState?.entries || [];
    if (hintedEntries.length) {
      return {
        domain: normalizedDomain,
        entries: toSessionMetadataList(hintedEntries),
        currentSessionIds: [],
        requestedDomain: normalizedDomain,
        entriesDomain: hint.domain,
        usingDomainHint: true,
        domainHintReason: hint.reason,
      };
    }
  }

  // Return the current domain's own sessions if any exist.
  // NOTE: We deliberately do NOT clear the hint here. The hint should only be
  // consumed (cleared) when the hinted session is successfully applied.
  if (entries.length) {
    return {
      domain: normalizedDomain,
      entries: toSessionMetadataList(entries),
      currentSessionIds,
      requestedDomain: normalizedDomain,
      entriesDomain: normalizedDomain,
      usingDomainHint: false,
    };
  }

  // Try any remaining hint (non-post_logout reason).
  if (hint) {
    const hintedDomainState = state.domains[hint.domain];
    const hintedEntries = hintedDomainState?.entries || [];
    if (hintedEntries.length) {
      return {
        domain: normalizedDomain,
        entries: toSessionMetadataList(hintedEntries),
        currentSessionIds: [],
        requestedDomain: normalizedDomain,
        entriesDomain: hint.domain,
        usingDomainHint: true,
        domainHintReason: hint.reason,
      };
    }
  }

  return {
    domain: normalizedDomain,
    entries: toSessionMetadataList(entries),
    currentSessionIds,
    requestedDomain: normalizedDomain,
    entriesDomain: normalizedDomain,
    usingDomainHint: false,
  };
};

const saveDomainCookies = async (domain, label, url, tabId, { markCurrent = false } = {}) => {
  if (!domain) throw createServiceError("ERR_INVALID_DOMAIN");
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain || (url && !normalizeHttpOrigin(url, normalizedDomain))) {
    throw createServiceError("ERR_INVALID_DOMAIN");
  }
  const [cookiesClean, siteData, state] = await Promise.all([
    collectCookiesForDomain(normalizedDomain, url, tabId),
    captureSiteStorage(tabId),
    getState(),
  ]);
  if (siteData?.tooLarge) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }
  if (siteData?.origin && !normalizeHttpOrigin(siteData.origin, normalizedDomain)) {
    throw createServiceError("ERR_INVALID_DOMAIN");
  }
  if (!cookiesClean.length && !hasMeaningfulSiteData(siteData)) {
    throw createServiceError("ERR_NO_USABLE_SESSION");
  }
  const signature = signatureFromCookies(cookiesClean, siteData);
  let originUrl = null;
  if (siteData?.origin) {
    originUrl = siteData.origin;
  } else if (url) {
    try {
      originUrl = new URL(url).origin;
    } catch (_) {
      originUrl = null;
    }
  }

  const domainState = ensureDomainState(state, normalizedDomain);

  const entries = domainState.entries || [];
  const existingEntry = entries.find((item) => {
    const existingSignature =
      item.signature || signatureFromCookies(item.cookies, item.siteData);
    return existingSignature === signature;
  });

  if (existingEntry) {
    let stateChanged = false;
    if (markCurrent) {
      stateChanged = setActiveSession(state, normalizedDomain, existingEntry.id) || stateChanged;
    }
    if (stateChanged) {
      await setState(state);
    }
    if (markCurrent) {
      await clearSessionInvalidationHint(normalizedDomain, existingEntry.id).catch(() => {});
    }
    await clearLegacySessionMarkerCookie(normalizedDomain, originUrl || url);
    return {
      entry: existingEntry,
      domainState: buildDomainStateSnapshot(state, normalizedDomain),
    };
  }

  const requestedLabel = String(label || "").trim();
  const entry = {
    id: createRandomId("manual"),
    label: (requestedLabel || `Guardado ${new Date().toLocaleString()}`).slice(0, MAX_LABEL_LENGTH),
    source: "manual",
    createdAt: Date.now(),
    signature,
    cookies: cookiesClean,
    siteData,
    originUrl,
  };
  if (cookiesClean.length > MAX_COOKIES_PER_SNAPSHOT || jsonByteLength(entry) > MAX_SNAPSHOT_BYTES) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }

  const filtered = entries.filter((e) => e.signature !== signature);

  domainState.entries = [entry, ...filtered].slice(0, MAX_ENTRIES_PER_DOMAIN);

  if (markCurrent) {
    setActiveSession(state, normalizedDomain, entry.id);
  }
  if (jsonByteLength(serializeStateForExport(state)) > MAX_TOTAL_STATE_BYTES) {
    throw createServiceError("ERR_STORAGE_LIMIT_REACHED");
  }
  await setState(state);
  void scheduleSessionLinkContextMenuRefresh();
  await clearLegacySessionMarkerCookie(normalizedDomain, originUrl || url);
  return {
    entry,
    domainState: buildDomainStateSnapshot(state, normalizedDomain),
  };
};

const applyCookieSet = async (domain, id, url, tabId) => {
  const normalizedDomain = normalizeDomain(domain);
  const state = await getState();
  const entries = state.domains[normalizedDomain]?.entries || [];
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw createServiceError("ERR_SAVED_SESSION_NOT_FOUND");

  const effectiveUrl =
    url || entry.originUrl || entry.siteData?.origin || null;
  if (!normalizeHttpOrigin(effectiveUrl, normalizedDomain)) {
    throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
  }

  const [currentSiteData, current] = await Promise.all([
    captureSiteStorage(tabId),
    collectCookiesForDomain(normalizedDomain, effectiveUrl, tabId),
  ]);
  if (currentSiteData?.tooLarge) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }
  let applied = 0;
  try {
    const tabStorageCleared = await clearTabSiteStorage(tabId, effectiveUrl);
    if (!tabStorageCleared) {
      throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
    }
    await clearSiteData(effectiveUrl);
    await clearSiteCookies(normalizedDomain, effectiveUrl, tabId);
    await clearLegacySessionMarkerCookie(normalizedDomain, effectiveUrl);

    const entryCookies = dedupeCookies(entry.cookies);
    const writeResult = await writeCookieSnapshot(entryCookies, normalizedDomain);
    applied = writeResult.applied;
    if (writeResult.failures.length) {
      throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
    }

    const storageApplied = await applySiteStorage(tabId, entry.siteData, effectiveUrl);
    if (!storageApplied) {
      throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
    }
  } catch (error) {
    await restoreSessionSnapshot(
      normalizedDomain,
      current,
      currentSiteData,
      effectiveUrl,
      tabId
    );
    throw error?.code === "ERR_COOKIE_CLEAR_FAILED"
      ? error
      : createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
  }

  const evidence = await getInvalidationEvidence(normalizedDomain, entry);
  const evidenceReason = evidence.reason;
  let verification;
  try {
    verification = await verifyAppliedSession(
      tabId,
      effectiveUrl,
      evidence.requiresExtendedVerification ? "external-removal" : evidenceReason
    );
  } catch (error) {
    await updateAppliedSessionState(normalizedDomain, id, { active: false, tabId });
    throw error;
  }
  const restorationStatus = "applied";
  const accessStatus = classifyRestoredSession(verification, evidenceReason);
  const invalidSession = accessStatus === "rejected";
  const sessionUnverified = accessStatus === "unconfirmed";
  const sessionUnknown = accessStatus === "unknown";
  const sessionConfirmed = accessStatus === "confirmed";
  const sessionUsable = sessionConfirmed || sessionUnknown;
  const stateUpdate = await updateAppliedSessionState(normalizedDomain, id, {
    active: sessionUsable,
    url: effectiveUrl,
    tabId,
    refreshCookies: sessionConfirmed,
  });
  const invalidationReason = invalidSession ? evidenceReason : null;
  const verificationReason = sessionUsable ? null : evidenceReason;
  if (sessionUsable && tabId) {
    await clearTabDomainHint(tabId, normalizedDomain);
  }
  if (sessionConfirmed) {
    await clearSessionInvalidationHint(normalizedDomain, id).catch(() => {});
  }
  return {
    applied,
    label: entry.label,
    restorationStatus,
    accessStatus,
    invalidSession,
    sessionUnverified,
    sessionUnknown,
    sessionConfirmed,
    sessionStatus: accessStatus,
    invalidationReason,
    verificationReason,
    completedUrl: verification.completedUrl,
    authCheck: verification.authCheck,
    domainState: stateUpdate?.domainState || null,
  };
};

const navigateAndApplyCookieSet = async (domain, id, tabId, targetUrlOverride = null) => {
  if (!tabId) {
    return applyCookieSet(domain, id, targetUrlOverride, null);
  }
  const state = await getState();

  // Resolve domain + entry, falling back to the hint list as a safety net.
  let resolvedDomain = normalizeDomain(domain);
  let entry = state.domains[resolvedDomain]?.entries?.find((item) => item.id === id);

  if (!entry) {
    const hint = await getRecentTabDomainHint(tabId, resolvedDomain, state);
    if (hint) {
      const hintEntry = state.domains[hint.domain]?.entries?.find((item) => item.id === id);
      if (hintEntry) {
        resolvedDomain = hint.domain;
        entry = hintEntry;
      }
    }
  }

  if (!entry) {
    throw createServiceError("ERR_SAVED_SESSION_NOT_FOUND");
  }

  const originUrl = entry.originUrl || entry.siteData?.origin || null;
  const targetBase = originUrl || `https://${resolvedDomain}`;
  const targetUrl = targetUrlOverride
    ? normalizeHttpTargetUrl(targetUrlOverride)
    : targetBase.endsWith("/")
      ? targetBase
      : `${targetBase}/`;
  const targetOrigin = normalizeHttpOrigin(targetUrl, resolvedDomain);
  const savedOrigin = entry.siteData?.origin
    ? normalizeHttpOrigin(entry.siteData.origin, resolvedDomain)
    : originUrl
      ? normalizeHttpOrigin(originUrl, resolvedDomain)
      : null;
  if (!targetUrl || !targetOrigin || (savedOrigin && savedOrigin !== targetOrigin)) {
    throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
  }
  const [currentTabInfo, currentCookies] = await Promise.all([
    chrome.tabs.get(tabId).catch(() => null),
    collectCookiesForDomain(resolvedDomain, targetUrl, tabId),
  ]);
  const isAlreadyOnTargetOrigin = urlHasSameOrigin(currentTabInfo?.url || "", targetUrl);
  const shouldReloadTarget = urlsHaveSameNavigationTarget(
    currentTabInfo?.url || "",
    targetUrl
  );
  const currentSiteData = isAlreadyOnTargetOrigin ? await captureSiteStorage(tabId) : null;
  if (currentSiteData?.tooLarge) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }

  // ── Phase 1: Write cookies BEFORE navigating ────────────────────────────────
  await clearSiteCookies(resolvedDomain, targetUrl, tabId);
  await clearLegacySessionMarkerCookie(resolvedDomain, targetUrl);

  const entryCookies = dedupeCookies(entry.cookies);
  const cookiesToRestore = entryCookies;

  const { applied, failures } = await writeCookieSnapshot(cookiesToRestore, resolvedDomain);

  if (failures.length) {
    await restoreCookieSnapshot(
      resolvedDomain,
      dedupeCookies(currentCookies),
      targetUrl,
      tabId
    );
    throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
  }

  // ── Phase 2: Prepare an isolated, tab-bound storage restore ───────────────────
  //
  // PAYLOAD TRANSPORT: a short-lived chrome.storage.session entry.
  //   inject_storage.js asks the worker for the payload. The worker validates
  //   sender.tab.id before returning it, so another tab cannot consume it.
  //   This avoids putting localStorage/sessionStorage data into the target URL.

  const siteData = entry.siteData;
  const CS_MAIN_ID   = `cs-storage-main-${tabId}`;
  const CS_BRIDGE_ID = `cs-storage-bridge-${tabId}`;
  const pendingStorageKey = `${PENDING_STORAGE_PREFIX}${tabId}_${Date.now()}`;
  const deliveryId = createRandomId("delivery");
  const deliveryToken = createRandomId("token");
  const storageAcknowledgement = createStorageAcknowledgement(deliveryId, deliveryToken, tabId);
  const pendingStorageArea = await getPendingStorageArea();
  await prunePendingStoragePayloads(pendingStorageArea);

  const cleanupInjection = async () => {
    try { await chrome.scripting.unregisterContentScripts({ ids: [CS_MAIN_ID, CS_BRIDGE_ID] }); } catch (_) {}
    try { await pendingStorageArea.remove(pendingStorageKey); } catch (_) {}
  };
  await cleanupInjection(); // remove leftover from a previous attempt

  try {
    await pendingStorageArea.set({
      [pendingStorageKey]: {
        deliveryId,
        token: deliveryToken,
        origin: targetOrigin,
        urlPrefix: targetUrl.split("#")[0],
        localStorage: siteData?.localStorage || {},
        sessionStorage: siteData?.sessionStorage || {},
        expiresAt: Date.now() + 2 * 60 * 1000,
      },
    });

    await chrome.scripting.registerContentScripts([
      {
        id: CS_MAIN_ID,
        js: ["inject_storage_main.js"],
        matches: [`${targetOrigin}/*`],
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: false,
      },
      {
        id: CS_BRIDGE_ID,
        js: ["inject_storage.js"],
        matches: [`${targetOrigin}/*`],
        runAt: "document_start",
        world: "ISOLATED",
        persistAcrossSessions: false,
      },
    ]);
  } catch (_) {
    storageAcknowledgement.cancel();
    await cleanupInjection();
    await restoreCookieSnapshot(
      resolvedDomain,
      dedupeCookies(currentCookies),
      targetUrl,
      tabId
    );
    throw createServiceError("ERR_APPLY_SAVED_SESSION_FAILED");
  }

  // ── Phase 3: Clear the previous account and stop its page scripts ─────────────
  await clearSiteData(targetUrl);
  if (isAlreadyOnTargetOrigin) {
    await clearTabSiteStorage(tabId, targetUrl);
  } else if (currentTabInfo?.url !== "about:blank") {
    try {
      const blankDone = waitForTabComplete(tabId, 3000);
      await chrome.tabs.update(tabId, { url: "about:blank" });
      await blankDone;
    } catch (_) {}
  }

  // ── Phase 4: Navigate and verify the resulting page ───────────────────────────
  let completedUrl = null;
  let navigationStarted = false;
  let storageApplied = false;
  try {
    const completePromise = waitForTabComplete(tabId, 12000);
    if (shouldReloadTarget) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }
    navigationStarted = true;
    completedUrl = await completePromise;

    if (!completedUrl) {
      try {
        const tab = await chrome.tabs.get(tabId);
        completedUrl = tab?.url || null;
      } catch (_) {}
    }
  } catch (_) {
    navigationStarted = false;
    storageAcknowledgement.cancel();
  } finally {
    storageApplied = await storageAcknowledgement.promise;
    await cleanupInjection();
  }

  const evidence =
    navigationStarted && storageApplied
      ? await getInvalidationEvidence(resolvedDomain, entry)
      : { reason: "unknown", requiresExtendedVerification: false };
  const evidenceReason = evidence.reason;
  const verification =
    navigationStarted && storageApplied
      ? await inspectLoadedSession(
          tabId,
          targetUrl,
          completedUrl,
          evidence.requiresExtendedVerification ? "external-removal" : evidenceReason
        )
      : {
          invalidSession: true,
          authCheck: null,
          completedUrl: completedUrl || targetUrl,
        };
  completedUrl = verification.completedUrl || completedUrl;
  const authCheck = verification.authCheck;
  const restorationStatus = navigationStarted && storageApplied ? "applied" : "failed";
  const restorationFailed = restorationStatus === "failed";
  const accessStatus = restorationFailed
    ? "unknown"
    : classifyRestoredSession(verification, evidenceReason);
  const invalidSession = accessStatus === "rejected";
  const sessionUnverified = accessStatus === "unconfirmed";
  const sessionUnknown = accessStatus === "unknown";
  const sessionConfirmed = accessStatus === "confirmed";
  const sessionOk = !restorationFailed && (sessionConfirmed || sessionUnknown);

  let stateUpdate = null;
  if (sessionOk) {
    stateUpdate = await updateAppliedSessionState(resolvedDomain, entry.id, {
      active: true,
      url: completedUrl || targetUrl,
      tabId,
      refreshCookies: sessionConfirmed,
    });
    await clearTabDomainHint(tabId, resolvedDomain);
    if (sessionConfirmed) {
      await clearSessionInvalidationHint(resolvedDomain, entry.id).catch(() => {});
    }
  } else {
    stateUpdate = await updateAppliedSessionState(
      resolvedDomain,
      entry.id,
      { active: false, tabId }
    );
    if (!navigationStarted || !storageApplied) {
      await restoreSessionSnapshot(
        resolvedDomain,
        currentCookies,
        currentSiteData,
        targetUrl,
        tabId
      );
    }
  }

  const invalidationReason = invalidSession ? evidenceReason : null;
  const verificationReason = sessionOk ? null : evidenceReason;
  return {
    applied,
    label: entry.label,
    restorationStatus,
    restorationFailed,
    accessStatus,
    invalidSession,
    sessionUnverified,
    sessionUnknown,
    sessionConfirmed,
    sessionStatus: accessStatus,
    invalidationReason,
    verificationReason,
    completedUrl: completedUrl || targetUrl,
    authCheck,
    domainState: stateUpdate?.domainState || null,
  };
};

const openLinkWithSavedSession = async (info) => {
  const selected = parseSessionLinkMenuEntryId(info?.menuItemId);
  const targetUrl = normalizeHttpTargetUrl(info?.linkUrl);
  if (!selected || !targetUrl) return;

  const selection = await runStateTask(async () => {
    const state = await getState();
    const entry = state.domains[selected.domain]?.entries?.find(
      (item) => item.id === selected.id
    );
    if (!entry) return null;
    const targetOrigin = normalizeHttpOrigin(targetUrl, selected.domain);
    const sessionOrigin = normalizeHttpOrigin(
      entry.siteData?.origin || entry.originUrl || `https://${selected.domain}`,
      selected.domain
    );
    if (!targetOrigin || targetOrigin !== sessionOrigin) return null;
    return { ...selected, targetUrl };
  });
  if (!selection) return;

  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (!Number.isInteger(tab?.id) || tab.id <= 0) return;
  try {
    await runStateTask(() =>
      navigateAndApplyCookieSet(
        selection.domain,
        selection.id,
        tab.id,
        selection.targetUrl
      )
    );
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    console.error("CookieSwapper could not open the link with the selected session", error?.code || "restore-failed");
  }
};

const clearSiteCookies = async (domain, url, tabId = null) => {
  const normalizedDomain = normalizeDomain(domain);
  const cookies = await collectCookiesForDomain(normalizedDomain, url, tabId);

  const removals = await Promise.allSettled(
    cookies.map(async (cookie) => {
      const removeDetails = {
        url: buildCookieUrl(cookie, normalizedDomain),
        name: cookie.name,
      };
      if (cookie.storeId) {
        removeDetails.storeId = cookie.storeId;
      }
      if (cookie.partitionKey) {
        removeDetails.partitionKey = cookie.partitionKey;
      }
      const expectation = rememberExpectedCookieMutation(cookie, "remove");
      try {
        const removedCookie = await chrome.cookies.remove(removeDetails);
        if (!removedCookie) forgetExpectedCookieMutation(expectation);
        return removedCookie;
      } catch (error) {
        forgetExpectedCookieMutation(expectation);
        throw error;
      }
    })
  );
  const removalRejected = removals.some((result) => result.status === "rejected");
  const ambiguousCookies = cookies.filter(
    (_, index) => removals[index]?.status === "fulfilled" && removals[index].value == null
  );
  let ambiguousCookieRemains = false;
  let verificationFailed = false;
  if (ambiguousCookies.length) {
    try {
      const ambiguousKeys = new Set(ambiguousCookies.map(cookieIdentityKey));
      const remainingCookies = await collectCookiesForDomain(normalizedDomain, url, tabId);
      ambiguousCookieRemains = remainingCookies.some((cookie) =>
        ambiguousKeys.has(cookieIdentityKey(cookie))
      );
    } catch (_) {
      verificationFailed = true;
    }
  }

  if (removalRejected || ambiguousCookieRemains || verificationFailed) {
    await writeCookieSnapshot(cookies, normalizedDomain);
    throw createServiceError("ERR_COOKIE_CLEAR_FAILED");
  }

  return cookies.map((cookie) => cookie.name);
};

const clearSiteData = async (url) => {
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    await chrome.browsingData.remove(
      { origins: [origin] },
      {
        localStorage: true,
      }
    );
    return true;
  } catch (_) {
    return false;
  }
};

const invalidateActiveSessionsForCookieChange = async (changeInfo) => {
  const changedCookie = changeInfo?.cookie
    ? toStorableCookie(changeInfo.cookie)
    : null;
  if (!changedCookie?.name) return false;

  // Websites routinely rotate session and anti-abuse cookies after a restore.
  // Keep the active candidate until the popup can reconcile the complete live
  // state; real removals still invalidate it immediately.
  if (!changeInfo.removed || changeInfo.cause === "overwrite") return false;

  const changedIdentity = cookieIdentityKey(changedCookie);
  const state = await getState();
  let stateChanged = false;
  const invalidatedSessions = [];

  Object.entries(state.domains || {}).forEach(([domain, domainState]) => {
    const activeSessionId = getActiveSessionId(domainState);
    if (!activeSessionId) return;
    const activeEntry = domainState.entries?.find(
      (entry) => entry.id === activeSessionId
    );
    if (!activeEntry) {
      stateChanged = clearActiveSession(state, domain, activeSessionId) || stateChanged;
      return;
    }

    const storedCookie = activeEntry.cookies?.find(
      (cookie) => cookieIdentityKey(cookie) === changedIdentity
    );
    if (!storedCookie) return;

    const cleared = clearActiveSession(state, domain, activeSessionId);
    if (cleared) {
      invalidatedSessions.push({ domain, sessionId: activeSessionId });
      stateChanged = true;
    }
  });

  if (stateChanged) {
    await setState(state);
    for (const { domain, sessionId } of invalidatedSessions) {
      await recordSessionInvalidationHint(domain, sessionId, changeInfo).catch(() => {});
    }
  }
  return stateChanged;
};

const pseudoLogout = async (domain, url, tabId) => {
  const [state, currentCookies, currentSiteData] = await Promise.all([
    getState(),
    collectCookiesForDomain(domain, url, tabId),
    captureSiteStorage(tabId),
  ]);
  if (currentSiteData?.tooLarge) {
    throw createServiceError("ERR_SESSION_TOO_LARGE");
  }
  await setTabDomainHint(tabId, domain, "post_logout_redirect");
  try {
    const removed = await clearSiteCookies(domain, url, tabId);
    const tabStorageCleared = await clearTabSiteStorage(tabId, url);
    if (!tabStorageCleared) {
      throw createServiceError("ERR_LOGOUT_FAILED");
    }
    await clearLegacySessionMarkerCookie(domain, url);
    await clearSiteData(url);
    if (clearActiveSession(state, domain)) {
      await setState(state);
    }
    return {
      removed,
      domainState: buildDomainStateSnapshot(state, domain),
    };
  } catch (error) {
    await restoreSessionSnapshot(domain, currentCookies, currentSiteData, url, tabId);
    await clearTabDomainHint(tabId, domain);
    throw error;
  }
};

const listEntriesForDomain = async (domain, url, tabId) => {
  const state = await getState();
  return resolveDomainState(state, domain, url, tabId);
};

const deleteEntry = async (domain, id) => {
  const normalizedDomain = normalizeDomain(domain);
  const state = await getState();
  const entries = state.domains[normalizedDomain]?.entries || [];
  const next = entries.filter((item) => item.id !== id);
  if (next.length === entries.length) {
    throw createServiceError("ERR_ENTRY_NOT_FOUND");
  }
  const domainState = ensureDomainState(state, normalizedDomain);
  domainState.entries = next;
  clearActiveSession(state, normalizedDomain, id);
  await setState(state);
  void scheduleSessionLinkContextMenuRefresh();
  await clearSessionInvalidationHint(normalizedDomain, id).catch(() => {});
  await clearLegacySessionMarkerCookie(normalizedDomain, null);
  return { removed: id, remaining: next.length };
};

const renameEntry = async (domain, id, label) => {
  const normalizedDomain = normalizeDomain(domain);
  const nextLabel = typeof label === "string" ? label.trim().slice(0, 64) : "";
  if (!nextLabel) {
    throw createServiceError("ERR_INVALID_NAME");
  }

  const state = await getState();
  const entries = state.domains[normalizedDomain]?.entries || [];
  const entryIndex = entries.findIndex((item) => item.id === id);
  if (entryIndex === -1) {
    throw createServiceError("ERR_ENTRY_NOT_FOUND");
  }

  const currentEntry = entries[entryIndex];
  state.domains[normalizedDomain].entries[entryIndex] = {
    ...currentEntry,
    label: nextLabel,
  };
  await setState(state);
  void scheduleSessionLinkContextMenuRefresh();
  return {
    id,
    label: nextLabel,
  };
};

const reorderEntries = async (domain, orderedIds) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    throw createServiceError("ERR_INVALID_DOMAIN");
  }

  const nextOrder = Array.isArray(orderedIds)
    ? orderedIds.filter((id) => typeof id === "string" && id)
    : [];
  if (!nextOrder.length) {
    throw createServiceError("ERR_INVALID_IMPORT_DATA");
  }

  const state = await getState();
  const domainState = ensureDomainState(state, normalizedDomain);
  const entries = Array.isArray(domainState.entries) ? domainState.entries : [];
  if (entries.length < 2) {
    return { ids: entries.map((entry) => entry.id) };
  }

  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  if (new Set(nextOrder).size !== nextOrder.length) {
    throw createServiceError("ERR_UNSUPPORTED_ACTION");
  }
  if (nextOrder.some((id) => !entryMap.has(id))) {
    throw createServiceError("ERR_ENTRY_NOT_FOUND");
  }

  const reordered = nextOrder.map((id) => entryMap.get(id));
  const remaining = entries.filter((entry) => !nextOrder.includes(entry.id));
  domainState.entries = [...reordered, ...remaining];
  await setState(state);
  void scheduleSessionLinkContextMenuRefresh();

  return { ids: domainState.entries.map((entry) => entry.id) };
};

const sendSiteReport = async (domain, note) => {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    throw createServiceError("ERR_INVALID_DOMAIN");
  }
  if (!REPORT_RELAY_URLS.length) {
    throw createServiceError("ERR_REPORT_NOT_CONFIGURED");
  }

  const body = JSON.stringify({
    domain: normalizedDomain,
    note: String(note || "").trim().slice(0, 1200),
  });

  for (const reportUrl of REPORT_RELAY_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(reportUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        return { sent: true };
      }
    } catch (_) {
    } finally {
      clearTimeout(timeout);
    }
  }

  throw createServiceError("ERR_REPORT_SEND_FAILED");
};

const buildReviewFeedbackReport = (rating, note) => {
  const normalizedRating = Number(rating);
  const normalizedNote = String(note || "").trim().slice(0, 1000);
  if (!Number.isInteger(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
    throw createServiceError("ERR_INVALID_REVIEW_FEEDBACK");
  }
  if (normalizedNote.length < 3) {
    throw createServiceError("ERR_INVALID_REVIEW_FEEDBACK");
  }
  return {
    domain: REVIEW_FEEDBACK_DOMAIN,
    note: `[CookieSwapper rating: ${normalizedRating}/5]\n${normalizedNote}`,
  };
};

const sendReviewFeedback = async (rating, note) => {
  const report = buildReviewFeedbackReport(rating, note);
  return sendSiteReport(report.domain, report.note);
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    const action = (message?.type || message?.action || "").toLowerCase();
    switch (action) {
      case "takependingstoragepayload": {
        return takePendingStoragePayload(sender, message);
      }
      case "confirmpendingstorageapplied": {
        return confirmPendingStorageApplied(sender, message);
      }
      case "getdomainmetadata": {
        return listMetadataForDomain(message.domain, message.tabId);
      }
      case "getdomainstate": {
        const domainState = await runStateTask(() =>
          listEntriesForDomain(
            message.domain,
            message.url,
            message.tabId
          )
        );
        return domainState;
      }
      case "savecurrentcookies": {
        const result = await runStateTask(() =>
          saveDomainCookies(
            message.domain,
            message.label,
            message.url,
            message.tabId,
            { markCurrent: Boolean(message.markCurrent) }
          )
        );
        return {
          ...toSessionMetadata(result.entry),
          domainState: result.domainState,
        };
      }
      case "applycookiesetnavigate": {
        const result = await runStateTask(() =>
          navigateAndApplyCookieSet(
            message.domain,
            message.id,
            message.tabId
          )
        );
        return result;
      }
      case "applycookieset": {
        const result = await runStateTask(() =>
          applyCookieSet(
            message.domain,
            message.id,
            message.url,
            message.tabId
          )
        );
        return result;
      }
      case "pseudologout": {
        const result = await runStateTask(() =>
          pseudoLogout(message.domain, message.url, message.tabId)
        );
        return result;
      }
      case "deletecookieset":
      case "deleteentry": {
        const result = await runStateTask(() => deleteEntry(message.domain, message.id));
        return result;
      }
      case "renamecookieset":
      case "renameentry": {
        const result = await runStateTask(() =>
          renameEntry(message.domain, message.id, message.label)
        );
        return result;
      }
      case "reordercookiesets":
      case "reorderentries": {
        const result = await runStateTask(() =>
          reorderEntries(message.domain, message.ids)
        );
        return result;
      }
      case "exportstate": {
        const state = await runStateTask(() => getState());
        return { version: 1, exportedAt: Date.now(), state: serializeStateForExport(state) };
      }
      case "importstate": {
        const normalized = normalizeImportedState(message.payload);
        if (!normalized) throw createServiceError("ERR_INVALID_IMPORT_DATA");
        await runStateTask(async () => {
          const current = await getState();
          const merged = mergeImportedState(current, normalized);
          if (jsonByteLength(serializeStateForExport(merged)) > MAX_TOTAL_STATE_BYTES) {
            throw createServiceError("ERR_STORAGE_LIMIT_REACHED");
          }
          await setState(merged);
          void scheduleSessionLinkContextMenuRefresh();
        });
        return { importedDomains: Object.keys(normalized.domains).length };
      }
      case "sendsitereport": {
        const result = await sendSiteReport(message.domain, message.note);
        return result;
      }
      case "sendreviewfeedback": {
        const result = await sendReviewFeedback(message.rating, message.note);
        return result;
      }
      default:
        throw createServiceError("ERR_UNSUPPORTED_ACTION");
    }
  };

  handler()
    .then((result) => sendResponse({ success: true, data: result }))
    .catch((error) =>
      sendResponse({
        success: false,
        error: error.message,
        errorCode: error?.code || "",
      })
    );

  return true;
});

chrome.contextMenus?.onClicked?.addListener((info) => {
  if (!parseSessionLinkMenuEntryId(info?.menuItemId)) return;
  void openLinkWithSavedSession(info).catch((error) => {
    console.error("CookieSwapper could not open the selected link", error?.code || "restore-failed");
  });
});

chrome.runtime.onInstalled?.addListener(() => {
  void scheduleSessionLinkContextMenuRefresh();
});

chrome.runtime.onStartup?.addListener(() => {
  void scheduleSessionLinkContextMenuRefresh();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabDomainHint(tabId).catch(() => {});
  pendingStorageAcknowledgements.forEach((pending) => {
    if (pending.tabId === tabId) pending.finish(false);
  });
  const keyPrefix = `${PENDING_STORAGE_PREFIX}${tabId}_`;
  void getPendingStorageArea()
    .then((area) =>
      area
        .get(null)
        .then((items) =>
          area.remove(Object.keys(items || {}).filter((key) => key.startsWith(keyPrefix)))
        )
    )
    .catch(() => {});
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!changeInfo?.cookie || isExpectedCookieMutation(changeInfo)) return;
  void runStateTask(() => invalidateActiveSessionsForCookieChange(changeInfo)).catch(() => {});
});
