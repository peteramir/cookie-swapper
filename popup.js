const els = {
  domain: document.getElementById("domainLabel"),
  list: document.getElementById("cookieList"),
  empty: document.getElementById("emptyState"),
  saveBtn: document.getElementById("saveBtn"),
  themeToggle: document.getElementById("themeToggle"),
  reportIssueBtn: document.getElementById("reportIssueBtn"),
  settingsToggle: document.getElementById("settingsToggle"),
  langSelect: document.getElementById("langSelect"),
  langSelectValue: document.getElementById("langSelectValue"),
  langDropdown: document.getElementById("langDropdown"),
  labelInput: document.getElementById("labelInput"),
  quickStart: document.getElementById("quickStart"),
  quickStartEyebrow: document.getElementById("quickStartEyebrow"),
  quickStartTitle: document.getElementById("quickStartTitle"),
  quickStartList: document.getElementById("quickStartList"),
  quickStartDismiss: document.getElementById("quickStartDismiss"),
  savedSmall: document.getElementById("savedSmall"),
  savedContextHint: document.getElementById("savedContextHint"),
  mainView: document.getElementById("mainView"),
  settingsView: document.getElementById("settingsView"),
  settingsBack: document.getElementById("settingsBack"),
  settingsTitle: document.getElementById("settingsTitle"),
  settingsLangLabel: document.getElementById("settingsLangLabel"),
  settingsDataLabel: document.getElementById("settingsDataLabel"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  savePanelEyebrow: document.getElementById("savePanelEyebrow"),
  saveModeControl: document.getElementById("saveModeControl"),
  saveModeKeep: document.getElementById("saveModeKeep"),
  saveModeClean: document.getElementById("saveModeClean"),
  saveNotice: document.getElementById("saveNotice"),
  logoutBtn: document.getElementById("logoutBtn"),
  logoutBtnText: document.getElementById("logoutBtnText"),
  logoutHint: document.getElementById("logoutHint"),
  modalRoot: document.getElementById("modalRoot"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalFeedback: document.getElementById("modalFeedback"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalField: document.getElementById("modalField"),
  modalFieldLabel: document.getElementById("modalFieldLabel"),
  modalInput: document.getElementById("modalInput"),
  modalTextarea: document.getElementById("modalTextarea"),
  modalActions: document.getElementById("modalActions"),
  modalCancelBtn: document.getElementById("modalCancelBtn"),
  modalConfirmBtn: document.getElementById("modalConfirmBtn"),
  reviewPromptRoot: document.getElementById("reviewPromptRoot"),
  reviewPromptClose: document.getElementById("reviewPromptClose"),
  reviewPromptEyebrow: document.getElementById("reviewPromptEyebrow"),
  reviewPromptTitle: document.getElementById("reviewPromptTitle"),
  reviewPromptBody: document.getElementById("reviewPromptBody"),
  reviewStars: document.getElementById("reviewStars"),
  reviewPromptFollowup: document.getElementById("reviewPromptFollowup"),
  reviewFeedbackLabel: document.getElementById("reviewFeedbackLabel"),
  reviewFeedbackTextarea: document.getElementById("reviewFeedbackTextarea"),
  reviewPromptDisclosure: document.getElementById("reviewPromptDisclosure"),
  reviewPromptStatus: document.getElementById("reviewPromptStatus"),
  reviewFeedbackBtn: document.getElementById("reviewFeedbackBtn"),
};

let currentDomain = null;
let currentTabId = null;
let currentTabUrl = null;
let themePreference = "light";
let currentLang = "en";
let translationsCache = {};

const loadTranslations = async (lang) => {
  const folder = lang === "zh" ? "zh_CN" : lang;
  try {
    const url = chrome.runtime.getURL(`_locales/${folder}/messages.json`);
    const res = await fetch(url);
    const data = await res.json();
    translationsCache = {};
    Object.entries(data).forEach(([key, value]) => {
      translationsCache[key] = value.message;
    });
  } catch (_) {}
};

let saveMode = "keep";
let busyAction = "";
let busyTarget = null;
let listCache = [];
let currentSessionIdsCache = [];
let currentEntriesDomain = null;
let usingDomainHint = false;
let refreshRequestId = 0;
let modalState = null;
let openSessionMenuKey = null;
let isLangDropdownOpen = false;
let completingOnboardingSteps = new Set();
let dragState = null;
const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024;
const SAVE_MODE_KEY = "cookieSwapperSaveMode";
const ONBOARDING_KEY = "cookieSwapperOnboarding";
const REVIEW_PROMPT_KEY = "cookieSwapperReviewPrompt";
const REVIEW_PROMPT_MIN_DAYS = 3;
const REVIEW_PROMPT_MAX_DISMISSALS = 2;
const REVIEW_PROMPT_CLOSE_DELAY_MS = 4000;
const REVIEW_STORE_URL =
  "https://chromewebstore.google.com/detail/cookieswapper-multi-accou/nocgfcdljpbdmnobnhbkpomhmojlphlc/reviews";
const REVIEW_FEEDBACK_DOMAIN = "review-feedback.cookieswapper.aminox.dev";
const REFRESH_INVALIDATING_ACTIONS = new Set([
  "save",
  "apply",
  "apply-here",
  "logout",
  "import",
  "delete",
  "rename",
]);
const ONBOARDING_STEPS = [
  {
    id: "savedFirstSession",
    titleKey: "quickStepSaveTitle",
    bodyKey: "quickStepSaveBody",
  },
  {
    id: "openedSavedSession",
    titleKey: "quickStepOpenTitle",
    bodyKey: "quickStepOpenBody",
  },
  {
    id: "openedSettings",
    titleKey: "quickStepSettingsTitle",
    bodyKey: "quickStepSettingsBody",
  },
];
let onboardingState = {
  savedFirstSession: false,
  openedSavedSession: false,
  openedSettings: false,
  dismissed: false,
};
let reviewPromptState = null;
let reviewPromptRating = 0;
let reviewPromptHoverRating = 0;
let reviewPromptCloseReady = false;
let reviewPromptSending = false;
let reviewPromptCloseTimer = null;

const SERVICE_ERROR_MESSAGES = {
  ERR_INVALID_DOMAIN: "errorInvalidDomain",
  ERR_NO_USABLE_SESSION: "errorNoUsableSession",
  ERR_SAVED_SESSION_NOT_FOUND: "errorSavedSessionNotFound",
  ERR_APPLY_SAVED_SESSION_FAILED: "errorApplySavedSessionFailed",
  ERR_INVALID_TAB: "errorInvalidTab",
  ERR_ENTRY_NOT_FOUND: "errorEntryNotFound",
  ERR_INVALID_NAME: "errorInvalidName",
  ERR_INVALID_IMPORT_DATA: "importInvalid",
  ERR_UNSUPPORTED_ACTION: "errorUnsupportedAction",
  ERR_REPORT_NOT_CONFIGURED: "errorReportNotConfigured",
  ERR_REPORT_SEND_FAILED: "errorReportFailed",
  ERR_INVALID_REVIEW_FEEDBACK: "reviewFeedbackInvalid",
  ERR_SESSION_TOO_LARGE: "errorSessionTooLarge",
  ERR_STORAGE_WRITE_FAILED: "errorStorageWriteFailed",
  ERR_STORAGE_LIMIT_REACHED: "errorStorageLimitReached",
  ERR_COOKIE_CLEAR_FAILED: "errorCookieClearFailed",
  ERR_LOGOUT_FAILED: "errorLogoutFailed",
};

const t = (key) => {
  return translationsCache[key] || key;
};

const languageLabels = {
  en: "English",
  es: "Español",
  zh: "中文",
};

const normalizeOnboardingState = (state) => {
  const next = state && typeof state === "object" ? { ...state } : {};
  return {
    savedFirstSession: Boolean(next.savedFirstSession),
    openedSavedSession: Boolean(next.openedSavedSession),
    openedSettings: Boolean(next.openedSettings),
    dismissed: Boolean(next.dismissed),
  };
};

const isOnboardingComplete = (state = onboardingState) =>
  ONBOARDING_STEPS.every((step) => Boolean(state[step.id]));

const persistOnboardingState = async () => {
  await chrome.storage.local.set({ [ONBOARDING_KEY]: onboardingState });
};

const getLocalDayKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeReviewPromptState = (state) => {
  const source = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const openDays = Array.from(
    new Set(
      (Array.isArray(source.openDays) ? source.openDays : []).filter(
        (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      )
    )
  )
    .sort()
    .slice(-31);
  const successfulActionCount = Math.max(0, Math.floor(Number(source.successfulActionCount) || 0));
  const dismissals = Math.min(
    REVIEW_PROMPT_MAX_DISMISSALS,
    Math.max(0, Math.floor(Number(source.dismissals) || 0))
  );
  return {
    openDays,
    hasSavedSession: source.hasSavedSession === true,
    hasSwappedSession: source.hasSwappedSession === true,
    successfulActionCount,
    dismissals,
    nextPromptActionCount: Math.max(0, Math.floor(Number(source.nextPromptActionCount) || 0)),
    completed: source.completed === true,
  };
};

const persistReviewPromptState = async () => {
  if (!reviewPromptState) return;
  await chrome.storage.local.set({ [REVIEW_PROMPT_KEY]: reviewPromptState });
};

const loadReviewPromptState = async (storedData = null) => {
  const data = storedData || await chrome.storage.local.get(REVIEW_PROMPT_KEY);
  reviewPromptState = normalizeReviewPromptState(data[REVIEW_PROMPT_KEY]);
};

const recordReviewPopupOpen = async () => {
  if (!reviewPromptState || reviewPromptState.completed) return;
  const today = getLocalDayKey();
  if (reviewPromptState.openDays.includes(today)) return;
  reviewPromptState.openDays = [...reviewPromptState.openDays, today].sort().slice(-31);
  await persistReviewPromptState();
};

const recordReviewSuccessfulAction = async (kind) => {
  if (!reviewPromptState || reviewPromptState.completed) return;
  reviewPromptState.successfulActionCount += 1;
  if (kind === "save") reviewPromptState.hasSavedSession = true;
  if (kind === "swap") reviewPromptState.hasSwappedSession = true;
  await persistReviewPromptState();
};

const isReviewPromptEligible = () => {
  if (
    !reviewPromptState ||
    reviewPromptState.completed ||
    reviewPromptState.dismissals >= REVIEW_PROMPT_MAX_DISMISSALS
  ) {
    return false;
  }
  if (
    reviewPromptState.openDays.length < REVIEW_PROMPT_MIN_DAYS ||
    !reviewPromptState.hasSavedSession ||
    !reviewPromptState.hasSwappedSession
  ) {
    return false;
  }
  if (reviewPromptState.dismissals === 1) {
    return (
      reviewPromptState.nextPromptActionCount > 0 &&
      reviewPromptState.successfulActionCount >= reviewPromptState.nextPromptActionCount
    );
  }
  return true;
};

const setReviewPromptStatus = (text = "", kind = "") => {
  if (!els.reviewPromptStatus) return;
  els.reviewPromptStatus.textContent = text;
  if (kind) els.reviewPromptStatus.dataset.kind = kind;
  else delete els.reviewPromptStatus.dataset.kind;
};

const renderReviewPrompt = () => {
  if (!els.reviewPromptRoot) return;
  const hasRating = reviewPromptRating >= 1 && reviewPromptRating <= 5;
  if (els.reviewPromptEyebrow) els.reviewPromptEyebrow.textContent = t("reviewPromptEyebrow");
  if (els.reviewPromptTitle) {
    els.reviewPromptTitle.textContent = !hasRating
      ? t("reviewPromptTitle")
      : reviewPromptRating <= 3
        ? t("reviewPromptFeedbackTitle")
        : t("reviewPromptThanksTitle");
  }
  if (els.reviewPromptBody) {
    els.reviewPromptBody.textContent = !hasRating
      ? t("reviewPromptBody")
      : reviewPromptRating <= 3
        ? t("reviewPromptFeedbackBody")
        : t("reviewPromptThanksBody");
  }
  if (els.reviewPromptClose) {
    els.reviewPromptClose.title = t("reviewPromptClose");
    els.reviewPromptClose.setAttribute("aria-label", t("reviewPromptClose"));
  }
  if (els.reviewStars) {
    els.reviewStars.setAttribute("aria-label", t("reviewPromptStarsLabel"));
    els.reviewStars.classList.toggle("is-previewing", reviewPromptHoverRating > 0);
    els.reviewStars.querySelectorAll("[data-review-rating]").forEach((button) => {
      const rating = Number(button.dataset.reviewRating);
      const selected = rating === reviewPromptRating;
      button.classList.toggle("is-selected", rating <= reviewPromptRating);
      button.classList.toggle(
        "is-previewed",
        reviewPromptHoverRating > 0 && rating <= reviewPromptHoverRating
      );
      button.setAttribute("aria-checked", selected ? "true" : "false");
      button.setAttribute(
        "aria-label",
        fillTemplate(t("reviewPromptStarLabel"), { rating })
      );
      button.disabled = reviewPromptSending;
    });
  }
  if (els.reviewPromptFollowup) {
    els.reviewPromptFollowup.hidden = !hasRating || reviewPromptRating >= 4;
  }
  if (els.reviewFeedbackLabel) els.reviewFeedbackLabel.textContent = t("reviewFeedbackLabel");
  if (els.reviewFeedbackTextarea) {
    els.reviewFeedbackTextarea.placeholder = t("reviewFeedbackPlaceholder");
    els.reviewFeedbackTextarea.disabled = reviewPromptSending;
  }
  if (els.reviewPromptDisclosure) {
    els.reviewPromptDisclosure.textContent = t("reviewPromptDisclosure");
  }
  if (els.reviewFeedbackBtn) {
    els.reviewFeedbackBtn.textContent = reviewPromptSending
      ? t("reviewFeedbackSending")
      : t("reviewFeedbackButton");
    els.reviewFeedbackBtn.disabled = reviewPromptSending || !hasRating;
  }
};

const setReviewPromptOpen = (isOpen) => {
  if (!els.reviewPromptRoot) return;
  els.reviewPromptRoot.hidden = !isOpen;
  document.body.dataset.modal = isOpen ? "true" : "false";
};

const openReviewPrompt = () => {
  if (!els.reviewPromptRoot || !isReviewPromptEligible()) return;
  reviewPromptRating = 0;
  reviewPromptHoverRating = 0;
  reviewPromptSending = false;
  reviewPromptCloseReady = false;
  if (els.reviewFeedbackTextarea) els.reviewFeedbackTextarea.value = "";
  if (els.reviewPromptFollowup) els.reviewPromptFollowup.hidden = true;
  if (els.reviewPromptClose) els.reviewPromptClose.hidden = true;
  setReviewPromptStatus();
  renderReviewPrompt();
  setReviewPromptOpen(true);
  clearTimeout(reviewPromptCloseTimer);
  reviewPromptCloseTimer = window.setTimeout(() => {
    reviewPromptCloseReady = true;
    if (els.reviewPromptClose) els.reviewPromptClose.hidden = false;
  }, REVIEW_PROMPT_CLOSE_DELAY_MS);
  requestAnimationFrame(() => {
    els.reviewStars?.querySelector("[data-review-rating]")?.focus();
  });
};

const closeReviewPrompt = () => {
  clearTimeout(reviewPromptCloseTimer);
  reviewPromptCloseTimer = null;
  setReviewPromptOpen(false);
};

const dismissReviewPrompt = async () => {
  if (!reviewPromptState || !reviewPromptCloseReady || reviewPromptSending) return;
  closeReviewPrompt();
  reviewPromptState.dismissals = Math.min(
    REVIEW_PROMPT_MAX_DISMISSALS,
    reviewPromptState.dismissals + 1
  );
  if (reviewPromptState.dismissals === 1) {
    reviewPromptState.nextPromptActionCount = reviewPromptState.successfulActionCount + 1;
  }
  await persistReviewPromptState();
};

const selectReviewRating = (rating) => {
  const normalized = Math.floor(Number(rating));
  if (reviewPromptSending || normalized < 1 || normalized > 5) return;
  reviewPromptRating = normalized;
  setReviewPromptStatus();
  renderReviewPrompt();
  if (normalized >= 4) {
    void openChromeWebStoreReview();
  }
};

const previewReviewRating = (rating) => {
  const normalized = Math.floor(Number(rating));
  const nextRating = normalized >= 1 && normalized <= 5 ? normalized : 0;
  if (reviewPromptHoverRating === nextRating) return;
  reviewPromptHoverRating = nextRating;
  renderReviewPrompt();
};

const completeReviewPrompt = async () => {
  reviewPromptState.completed = true;
  await persistReviewPromptState();
};

const openChromeWebStoreReview = async () => {
  if (!reviewPromptState || reviewPromptRating < 1 || reviewPromptSending) return;
  reviewPromptSending = true;
  renderReviewPrompt();
  try {
    await completeReviewPrompt();
    await chrome.tabs.create({ url: REVIEW_STORE_URL });
    closeReviewPrompt();
  } catch (_) {
    reviewPromptState.completed = false;
    await persistReviewPromptState().catch(() => {});
    reviewPromptSending = false;
    renderReviewPrompt();
    setReviewPromptStatus(t("reviewStoreFailed"), "error");
  }
};

const sendReviewFeedback = async () => {
  if (!reviewPromptState || reviewPromptRating < 1 || reviewPromptSending) return;
  const note = String(els.reviewFeedbackTextarea?.value || "").trim();
  if (note.length < 3) {
    setReviewPromptStatus(t("reviewFeedbackRequired"), "error");
    els.reviewFeedbackTextarea?.focus();
    return;
  }
  reviewPromptSending = true;
  setReviewPromptStatus();
  renderReviewPrompt();
  try {
    try {
      await sendMessage({
        type: "sendReviewFeedback",
        rating: reviewPromptRating,
        note,
      });
    } catch (error) {
      if (error.code !== "ERR_UNSUPPORTED_ACTION") throw error;
      await sendMessage({
        type: "sendSiteReport",
        domain: REVIEW_FEEDBACK_DOMAIN,
        note: `[CookieSwapper rating: ${reviewPromptRating}/5]\n${note}`,
      });
    }
    await completeReviewPrompt();
    closeReviewPrompt();
    await showTransientSuccessModal({
      title: t("reviewFeedbackSuccess"),
      body: t("reviewFeedbackSuccessBody"),
    });
  } catch (error) {
    reviewPromptSending = false;
    renderReviewPrompt();
    setReviewPromptStatus(error.message || t("errorReportFailed"), "error");
  }
};

const maybeShowReviewPrompt = () => {
  if (isReviewPromptEligible()) openReviewPrompt();
};

const sendMessage = (payload) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response) return reject(new Error(t("serviceUnavailable")));
      if (!response.success) {
        const messageKey = SERVICE_ERROR_MESSAGES[response.errorCode];
        const error = new Error(messageKey ? t(messageKey) : response.error || t("unknownError"));
        error.code = response.errorCode || "";
        return reject(error);
      }
      resolve(response.data);
    });
  });

const fillTemplate = (template, values = {}) =>
  String(template || "").replace(/\{(\w+)\}/g, (_, key) => `${values[key] ?? ""}`);

const setModalOpen = (isOpen) => {
  if (!els.modalRoot) return;
  els.modalRoot.hidden = !isOpen;
  document.body.dataset.modal = isOpen ? "true" : "false";
};

const renderModalBody = (text, emphasis = []) => {
  const body = String(text || "");
  const phrases = emphasis.filter((phrase) => typeof phrase === "string" && phrase);
  els.modalBody.replaceChildren();

  if (!phrases.length) {
    els.modalBody.textContent = body;
    return;
  }

  let cursor = 0;
  while (cursor < body.length) {
    let nextIndex = -1;
    let nextPhrase = "";

    for (const phrase of phrases) {
      const index = body.indexOf(phrase, cursor);
      if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
        nextIndex = index;
        nextPhrase = phrase;
      }
    }

    if (nextIndex === -1) {
      els.modalBody.append(document.createTextNode(body.slice(cursor)));
      break;
    }

    if (nextIndex > cursor) {
      els.modalBody.append(document.createTextNode(body.slice(cursor, nextIndex)));
    }
    const strong = document.createElement("strong");
    strong.textContent = nextPhrase;
    els.modalBody.append(strong);
    cursor = nextIndex + nextPhrase.length;
  }
};

const syncModal = () => {
  if (!modalState) return;
  if (els.modalFeedback) {
    els.modalFeedback.hidden = modalState.feedbackKind !== "success";
  }
  els.modalTitle.textContent = modalState.title || "";
  renderModalBody(modalState.body, modalState.bodyEmphasis);
  els.modalCancelBtn.textContent = modalState.cancelText || t("modalCancel");
  els.modalConfirmBtn.textContent = modalState.confirmText || t("modalRenameConfirm");
  els.modalConfirmBtn.classList.toggle("is-danger", modalState.tone === "danger");
  if (els.modalActions) {
    els.modalActions.hidden = modalState.hideActions === true;
  }
  if (els.modalCancelBtn) {
    els.modalCancelBtn.hidden = modalState.hideCancel === true;
  }

  if (modalState.kind === "prompt") {
    els.modalField.hidden = false;
    els.modalFieldLabel.textContent = modalState.fieldLabel || "";
    const isMultiline = modalState.fieldType === "textarea";
    if (els.modalInput) {
      els.modalInput.hidden = isMultiline;
      els.modalInput.value = isMultiline ? "" : modalState.value || "";
      els.modalInput.placeholder = isMultiline ? "" : modalState.placeholder || "";
      if (modalState.maxLength && !isMultiline) {
        els.modalInput.maxLength = modalState.maxLength;
      } else {
        els.modalInput.maxLength = 64;
      }
    }
    if (els.modalTextarea) {
      els.modalTextarea.hidden = !isMultiline;
      els.modalTextarea.value = isMultiline ? modalState.value || "" : "";
      els.modalTextarea.placeholder = isMultiline ? modalState.placeholder || "" : "";
      if (modalState.maxLength && isMultiline) {
        els.modalTextarea.maxLength = modalState.maxLength;
      } else {
        els.modalTextarea.maxLength = 1200;
      }
    }
  } else {
    els.modalField.hidden = true;
    els.modalInput.value = "";
    els.modalInput.placeholder = "";
    if (els.modalTextarea) {
      els.modalTextarea.value = "";
      els.modalTextarea.placeholder = "";
      els.modalTextarea.hidden = true;
    }
  }
};

const closeModal = (result = null) => {
  if (!modalState) return;
  const state = modalState;
  modalState = null;
  setModalOpen(false);
  els.modalInput.value = "";
  if (els.modalTextarea) {
    els.modalTextarea.value = "";
  }
  els.modalConfirmBtn.classList.remove("is-danger");
  state.resolve(result);
  if (state.previousFocus && typeof state.previousFocus.focus === "function") {
    try {
      state.previousFocus.focus();
    } catch (_) {}
  }
};

const openConfirmModal = (config) =>
  new Promise((resolve) => {
    modalState = {
      kind: "confirm",
      cancelText: t("modalCancel"),
      ...config,
      resolve,
      previousFocus: document.activeElement,
    };
    syncModal();
    setModalOpen(true);
    requestAnimationFrame(() => {
      els.modalConfirmBtn?.focus();
    });
  });

const openPromptModal = (config) =>
  new Promise((resolve) => {
    modalState = {
      kind: "prompt",
      cancelText: t("modalCancel"),
      ...config,
      resolve,
      previousFocus: document.activeElement,
    };
    syncModal();
    setModalOpen(true);
    requestAnimationFrame(() => {
      if (config.fieldType === "textarea") {
        els.modalTextarea?.focus();
        els.modalTextarea?.setSelectionRange?.(els.modalTextarea.value.length, els.modalTextarea.value.length);
      } else {
        els.modalInput?.focus();
        els.modalInput?.select();
      }
    });
  });

const showErrorModal = (message) =>
  openConfirmModal({
    title: "CookieSwapper",
    body: String(message || t("unknownError")),
    confirmText: t("modalInvalidSessionConfirm"),
    hideCancel: true,
    tone: "danger",
  });

const showTransientSuccessModal = ({ title, body, duration = 1400 }) =>
  new Promise((resolve) => {
    modalState = {
      kind: "confirm",
      title,
      body,
      hideActions: true,
      hideCancel: true,
      feedbackKind: "success",
      resolve,
      previousFocus: document.activeElement,
    };
    syncModal();
    setModalOpen(true);
    window.setTimeout(() => {
      if (modalState) {
        closeModal(true);
      }
    }, duration);
  });

const showInvalidSessionModal = async (result = null) => {
  const isExternalChange = result?.invalidationReason === "external-change";
  const bodyKey = isExternalChange
    ? "modalInvalidSessionExternalBody"
    : "modalInvalidSessionBody";
  await openConfirmModal({
    title: t("modalInvalidSessionTitle"),
    body: t(bodyKey),
    bodyEmphasis: isExternalChange
      ? [t("modalInvalidSessionExternalCauseEmphasis")]
      : [],
    confirmText: t("modalInvalidSessionConfirm"),
    hideCancel: true,
  });
};

const showUnverifiedSessionModal = async (result = null) => {
  const isExternalChange = result?.verificationReason === "external-change";
  await openConfirmModal({
    title: t("modalUnverifiedSessionTitle"),
    body: t(
      isExternalChange
        ? "modalUnverifiedSessionExternalBody"
        : "modalUnverifiedSessionBody"
    ),
    confirmText: t("modalInvalidSessionConfirm"),
    hideCancel: true,
  });
};

const renderRestoredDomainState = async (result, domain) => {
  if (!renderDomainStateSnapshot(result?.domainState, {
    fallbackDomain: domain,
    url: result?.completedUrl,
  })) {
    await refresh();
  }
};

const presentSessionRestoreResult = async (result, domain) => {
  await renderRestoredDomainState(result, domain);

  if (result?.restorationFailed || result?.restorationStatus === "failed") {
    await showErrorModal(t("errorApplySavedSessionFailed"));
    return "failed";
  }

  const accessStatus = result?.accessStatus || result?.sessionStatus;
  if (result?.invalidSession || accessStatus === "rejected") {
    await showInvalidSessionModal(result);
    return "rejected";
  }
  if (result?.sessionUnverified || accessStatus === "unconfirmed") {
    await showUnverifiedSessionModal(result);
    return "unconfirmed";
  }
  if (accessStatus === "unknown") {
    if (result?.verificationReason === "external-change") {
      await showUnverifiedSessionModal(result);
    }
    return "unknown";
  }

  return "confirmed";
};

const submitModal = () => {
  if (!modalState) return;
  if (modalState.kind === "prompt") {
    closeModal(modalState.fieldType === "textarea" ? els.modalTextarea.value : els.modalInput.value);
    return;
  }
  closeModal(true);
};

const parseDomainFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!/^https?:/.test(parsed.protocol)) return null;
    return parsed.hostname;
  } catch (_) {
    return null;
  }
};

const detectCurrentDomain = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return { domain: null, tabId: null, url: null };
  return { domain: parseDomainFromUrl(tab.url), tabId: tab.id, url: tab.url };
};

const isBusy = () => Boolean(busyAction);

const describeBusyTarget = (button) => {
  if (!(button instanceof Element)) return null;
  return {
    elementId: button.id || "",
    action: button.dataset.action || "",
    id: button.dataset.id || "",
    domain: button.dataset.domain || "",
  };
};

const matchesBusyTarget = (button) => {
  if (!(button instanceof Element) || !busyTarget) return false;
  if (busyTarget.elementId) return button.id === busyTarget.elementId;
  return Boolean(
    busyTarget.action &&
      button.dataset.action === busyTarget.action &&
      button.dataset.id === busyTarget.id &&
      button.dataset.domain === busyTarget.domain
  );
};

const syncBusyIndicator = () => {
  document.querySelectorAll("button.is-loading").forEach((button) => {
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  });
  if (!busyTarget) return;
  const target = Array.from(document.querySelectorAll("button")).find(matchesBusyTarget);
  if (!target) return;
  target.classList.add("is-loading");
  target.setAttribute("aria-busy", "true");
};

const updateButtonsState = () => {
  const disabled = !currentDomain || isBusy();
  els.saveBtn.disabled = disabled;
  if (els.logoutBtn) els.logoutBtn.disabled = disabled;
  if (els.exportBtn) els.exportBtn.disabled = isBusy();
  if (els.importBtn) els.importBtn.disabled = isBusy();
  if (els.langSelect) els.langSelect.disabled = isBusy();
  if (els.saveModeKeep) els.saveModeKeep.disabled = isBusy();
  if (els.saveModeClean) els.saveModeClean.disabled = isBusy();
  if (els.importFile) els.importFile.disabled = isBusy();
  document.body.dataset.busy = isBusy() ? "true" : "false";
  renderReportAction();
  syncBusyIndicator();
};

const renderLangDropdown = () => {
  if (els.langSelect) {
    els.langSelect.setAttribute("aria-expanded", isLangDropdownOpen ? "true" : "false");
    els.langSelect.setAttribute("aria-label", t("settingsLangLabel"));
  }
  if (els.langSelectValue) {
    els.langSelectValue.textContent = languageLabels[currentLang] || languageLabels.en;
  }
  if (els.langDropdown) {
    els.langDropdown.hidden = !isLangDropdownOpen;
    els.langDropdown
      .querySelectorAll("[data-lang-option]")
      .forEach((option) => {
        const isSelected = option.dataset.langOption === currentLang;
        option.classList.toggle("is-selected", isSelected);
        option.setAttribute("aria-selected", isSelected ? "true" : "false");
        option.tabIndex = isLangDropdownOpen ? 0 : -1;
      });
  }
};

const closeLangDropdown = () => {
  if (!isLangDropdownOpen) return;
  isLangDropdownOpen = false;
  renderLangDropdown();
};

const toggleLangDropdown = () => {
  if (!els.langSelect || isBusy()) return;
  isLangDropdownOpen = !isLangDropdownOpen;
  renderLangDropdown();
};

const renderReportAction = () => {
  if (els.reportIssueBtn) {
    els.reportIssueBtn.setAttribute("aria-label", t("reportIssueTitle"));
    els.reportIssueBtn.title = t("reportIssueTitle");
    els.reportIssueBtn.disabled = isBusy() || !currentDomain;
  }
};

const focusLangOption = (lang = currentLang) => {
  const option = els.langDropdown?.querySelector(`[data-lang-option="${lang}"]`);
  option?.focus();
};

const getLocaleForLang = () => {
  if (currentLang === "es") return "es-ES";
  if (currentLang === "zh") return "zh-CN";
  return "en-US";
};

const formatTimestamp = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return new Date(numeric).toLocaleString(getLocaleForLang(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getSessionMenuKey = (domain, id) => `${domain || ""}::${id || ""}`;

const createMenuIcon = (type) => {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "menu-item-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  if (type === "apply-here") {
    path.setAttribute("d", "M12 20V13.25M12 13.25a4.25 4.25 0 1 0 0-8.5a4.25 4.25 0 0 0 0 8.5Z");
  } else if (type === "open") {
    path.setAttribute("d", "M7 17 17 7M9 7h8v8");
  } else if (type === "rename") {
    path.setAttribute("d", "M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5Z M13.5 7l3.5 3.5");
  } else {
    path.setAttribute("d", "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.5 12h7");
  }
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  icon.appendChild(path);
  return icon;
};

const createOpenIcon = () => {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "open-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 17 17 7M9 7h8v8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.9");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  icon.appendChild(path);
  return icon;
};

const closeSessionMenu = ({ render = true } = {}) => {
  if (!openSessionMenuKey) return;
  openSessionMenuKey = null;
  if (render) {
    renderList(listCache, currentSessionIdsCache);
  }
};

const toggleSessionMenu = (domain, id) => {
  const nextKey = getSessionMenuKey(domain, id);
  openSessionMenuKey = openSessionMenuKey === nextKey ? null : nextKey;
  renderList(listCache, currentSessionIdsCache);
};

const renderOnboarding = () => {
  if (!els.quickStart || !els.quickStartList) return;

  const pendingSteps = ONBOARDING_STEPS.filter((step) => !onboardingState[step.id]);
  const shouldShow = !onboardingState.dismissed && pendingSteps.length > 0;
  els.quickStart.hidden = !shouldShow;
  if (!shouldShow) return;

  els.quickStartList.innerHTML = "";
  pendingSteps.forEach((step) => {
    const item = document.createElement("li");
    item.className = "quickstart-item";
    item.dataset.stepId = step.id;

    const check = document.createElement("button");
    check.className = "quickstart-check";
    check.type = "button";
    check.dataset.stepId = step.id;
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", "false");
    check.setAttribute("aria-label", t(step.titleKey));

    const checkIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    checkIcon.setAttribute("class", "quickstart-check-icon");
    checkIcon.setAttribute("viewBox", "0 0 24 24");
    checkIcon.setAttribute("aria-hidden", "true");

    const checkPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    checkPath.setAttribute("d", "M6.5 12.5 10.2 16 17.5 8.8");
    checkPath.setAttribute("fill", "none");
    checkPath.setAttribute("stroke", "currentColor");
    checkPath.setAttribute("stroke-width", "2.1");
    checkPath.setAttribute("stroke-linecap", "round");
    checkPath.setAttribute("stroke-linejoin", "round");
    checkIcon.appendChild(checkPath);
    check.appendChild(checkIcon);

    const copy = document.createElement("div");
    copy.className = "quickstart-copy";

    const title = document.createElement("div");
    title.className = "quickstart-step-title";
    title.textContent = t(step.titleKey);

    const body = document.createElement("div");
    body.className = "quickstart-step-body";
    body.textContent = t(step.bodyKey);

    copy.appendChild(title);
    copy.appendChild(body);
    item.appendChild(check);
    item.appendChild(copy);
    els.quickStartList.appendChild(item);
  });
};

const syncOnboardingState = async ({ entries = null } = {}) => {
  let changed = false;
  const next = normalizeOnboardingState(onboardingState);

  if (Array.isArray(entries) && entries.length && !next.savedFirstSession) {
    next.savedFirstSession = true;
    changed = true;
  }

  if (isOnboardingComplete(next) && !next.dismissed) {
    next.dismissed = true;
    changed = true;
  }

  if (changed) {
    onboardingState = next;
    await persistOnboardingState();
  }

  renderOnboarding();
};

const markOnboardingStep = async (stepId) => {
  if (!stepId) return;
  if (completingOnboardingSteps.has(stepId)) return;

  const next = normalizeOnboardingState(onboardingState);
  if (next[stepId]) {
    renderOnboarding();
    return;
  }

  completingOnboardingSteps.add(stepId);

  const item = els.quickStartList?.querySelector(`.quickstart-item[data-step-id="${stepId}"]`);
  const check = item?.querySelector(".quickstart-check");
  if (item && !els.quickStart?.hidden) {
    item.classList.add("is-completing");
    if (check) {
      check.setAttribute("aria-checked", "true");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 220));
  }

  next[stepId] = true;
  if (isOnboardingComplete(next)) {
    next.dismissed = true;
  }

  onboardingState = next;
  await persistOnboardingState();
  completingOnboardingSteps.delete(stepId);
  renderOnboarding();
};

const dismissOnboarding = async () => {
  const next = normalizeOnboardingState(onboardingState);
  if (next.dismissed) {
    renderOnboarding();
    return;
  }

  next.dismissed = true;
  onboardingState = next;
  await persistOnboardingState();
  renderOnboarding();
};

const adjustOpenMenuPosition = () => {
  if (!openSessionMenuKey) return;
  const openMenuPanel = document.querySelector(".menu-panel:not([hidden])");
  if (!openMenuPanel) return;

  const menuTrigger = openMenuPanel.previousElementSibling;
  if (!menuTrigger) return;

  const triggerRect = menuTrigger.getBoundingClientRect();
  const menuHeight = openMenuPanel.offsetHeight || 140;

  // Check if there is enough space above the trigger in the entire viewport (popup window)
  const spaceAboveInViewport = triggerRect.top;

  openMenuPanel.style.position = "fixed";
  openMenuPanel.style.top = "auto";
  openMenuPanel.style.left = "auto";
  openMenuPanel.style.zIndex = "1000";

  if (spaceAboveInViewport < menuHeight + 16) {
    // Open downward if it would go off the top of the viewport
    openMenuPanel.style.bottom = "auto";
    openMenuPanel.style.top = `${triggerRect.bottom + 8}px`;
    openMenuPanel.style.right = `${window.innerWidth - triggerRect.right}px`;
  } else {
    // Default: Open upward
    openMenuPanel.style.bottom = `${window.innerHeight - triggerRect.top + 8}px`;
    openMenuPanel.style.top = "auto";
    openMenuPanel.style.right = `${window.innerWidth - triggerRect.right}px`;
  }
};

const renderList = (
  entries = [],
  currentSessionIds = currentSessionIdsCache,
  entriesDomain = currentEntriesDomain || currentDomain
) => {
  listCache = Array.isArray(entries) ? entries : [];
  currentSessionIdsCache = Array.isArray(currentSessionIds) ? currentSessionIds : [];
  currentEntriesDomain = entriesDomain || currentDomain || null;
  const currentSessionIdSet = new Set(currentSessionIdsCache);

  els.list.innerHTML = "";

  if (!listCache.length) {
    els.empty.style.display = "";
    return;
  }

  if (
    openSessionMenuKey &&
    !listCache.some((entry) => getSessionMenuKey(currentEntriesDomain, entry.id) === openSessionMenuKey)
  ) {
    openSessionMenuKey = null;
  }

  els.empty.style.display = "none";
  listCache.forEach((entry) => {
    const row = document.createElement("li");
    row.className = "session-row";
    row.dataset.id = entry.id;
    row.dataset.domain = currentEntriesDomain || "";
    if (listCache.length > 1) {
      row.draggable = true;
    }

    const isCurrentSession = currentSessionIdSet.has(entry.id);
    if (isCurrentSession) {
      row.classList.add("is-current-session");
      row.title = t("currentSessionTag");
      row.setAttribute("aria-label", `${entry.label || t("defaultLabel")} - ${t("currentSessionTag")}`);
    }

    const dragHandle = document.createElement("div");
    dragHandle.className = "session-drag-handle";
    dragHandle.tabIndex = -1;
    dragHandle.dataset.dragHandle = "true";
    dragHandle.title = t("reorderHandle");
    dragHandle.setAttribute("aria-label", t("reorderHandle"));
    dragHandle.innerHTML = `
      <svg class="drag-handle-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="9" cy="7" r="1.35" fill="currentColor"></circle>
        <circle cx="15" cy="7" r="1.35" fill="currentColor"></circle>
        <circle cx="9" cy="12" r="1.35" fill="currentColor"></circle>
        <circle cx="15" cy="12" r="1.35" fill="currentColor"></circle>
        <circle cx="9" cy="17" r="1.35" fill="currentColor"></circle>
        <circle cx="15" cy="17" r="1.35" fill="currentColor"></circle>
      </svg>
    `;

    const info = document.createElement("div");
    info.className = "session-info";

    const label = document.createElement("div");
    label.className = "session-name";
    label.textContent = entry.label || t("defaultLabel");

    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = formatTimestamp(entry.createdAt);

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const applyBtn = document.createElement("button");
    applyBtn.className = "session-open";
    applyBtn.dataset.action = "apply";
    applyBtn.dataset.id = entry.id;
    applyBtn.dataset.domain = currentEntriesDomain || "";
    applyBtn.type = "button";
    applyBtn.disabled = isBusy();
    applyBtn.title = t("applyBtn");
    applyBtn.setAttribute("aria-label", t("applyBtn"));
    applyBtn.appendChild(createOpenIcon());

    const applyText = document.createElement("span");
    applyText.className = "sr-only";
    applyText.textContent = t("applyBtn");
    applyBtn.appendChild(applyText);

    const menuShell = document.createElement("div");
    menuShell.className = "menu-shell";

    const menuTrigger = document.createElement("button");
    menuTrigger.className = "menu-trigger";
    menuTrigger.dataset.action = "toggle-menu";
    menuTrigger.dataset.id = entry.id;
    menuTrigger.dataset.domain = currentEntriesDomain || "";
    menuTrigger.type = "button";
    menuTrigger.disabled = isBusy();
    menuTrigger.title = t("moreActions");
    menuTrigger.setAttribute("aria-label", t("moreActions"));
    menuTrigger.setAttribute("aria-haspopup", "menu");
    menuTrigger.setAttribute(
      "aria-expanded",
      openSessionMenuKey === getSessionMenuKey(currentEntriesDomain, entry.id) ? "true" : "false"
    );
    menuTrigger.innerHTML = `
      <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5.5" r="1.8" fill="currentColor"></circle>
        <circle cx="12" cy="12" r="1.8" fill="currentColor"></circle>
        <circle cx="12" cy="18.5" r="1.8" fill="currentColor"></circle>
      </svg>
    `;

    const menuPanel = document.createElement("div");
    menuPanel.className = "menu-panel";
    menuPanel.hidden = openSessionMenuKey !== getSessionMenuKey(currentEntriesDomain, entry.id);

    const applyHereBtn = document.createElement("button");
    applyHereBtn.className = "menu-item";
    applyHereBtn.dataset.action = "apply-here";
    applyHereBtn.dataset.id = entry.id;
    applyHereBtn.dataset.domain = currentEntriesDomain || "";
    applyHereBtn.type = "button";
    applyHereBtn.disabled = isBusy() || !currentTabUrl || currentEntriesDomain !== currentDomain;
    applyHereBtn.appendChild(createMenuIcon("apply-here"));
    applyHereBtn.append(document.createTextNode(t("applyHereBtn")));

    const renameBtn = document.createElement("button");
    renameBtn.className = "menu-item";
    renameBtn.dataset.action = "rename";
    renameBtn.dataset.id = entry.id;
    renameBtn.dataset.domain = currentEntriesDomain || "";
    renameBtn.dataset.label = entry.label || "";
    renameBtn.type = "button";
    renameBtn.disabled = isBusy();
    renameBtn.appendChild(createMenuIcon("rename"));
    renameBtn.append(document.createTextNode(t("renameBtn")));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "menu-item is-danger";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.id = entry.id;
    deleteBtn.dataset.domain = currentEntriesDomain || "";
    deleteBtn.type = "button";
    deleteBtn.disabled = isBusy();
    deleteBtn.appendChild(createMenuIcon("delete"));
    deleteBtn.append(document.createTextNode(t("deleteBtn")));

    menuPanel.appendChild(applyHereBtn);
    menuPanel.appendChild(renameBtn);
    menuPanel.appendChild(deleteBtn);
    menuShell.appendChild(menuTrigger);
    menuShell.appendChild(menuPanel);

    info.appendChild(label);
    info.appendChild(meta);

    actions.appendChild(applyBtn);
    actions.appendChild(menuShell);

    row.appendChild(dragHandle);
    row.appendChild(info);
    row.appendChild(actions);
    els.list.appendChild(row);
  });
  syncBusyIndicator();
  adjustOpenMenuPosition();
};

const canReorderSessions = (entriesDomain = currentEntriesDomain) =>
  !isBusy() && Array.isArray(listCache) && listCache.length > 1 && Boolean(entriesDomain);

const snapshotListRects = () =>
  new Map(
    Array.from(els.list?.querySelectorAll?.(".session-row[data-id]") || []).map((row) => [
      row.dataset.id,
      row.getBoundingClientRect(),
    ])
  );

const animateListReorder = (beforeRects) => {
  if (!beforeRects?.size) return;
  const rows = Array.from(els.list?.querySelectorAll?.(".session-row[data-id]") || []);
  
  rows.forEach((row) => {
    const previous = beforeRects.get(row.dataset.id);
    if (!previous) return;
    const next = row.getBoundingClientRect();
    const deltaY = previous.top - next.top;
    if (deltaY !== 0) {
      row.style.transition = "none";
      row.style.transform = `translateY(${deltaY}px)`;
    }
  });

  if (els.list) {
    const _ = els.list.offsetHeight;
  }

  rows.forEach((row) => {
    row.style.transition = "";
    row.style.transform = "";
  });
};

const reorderEntriesByIds = (entries, orderedIds) => {
  const entryMap = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
  const reordered = [];
  orderedIds.forEach((id) => {
    const entry = entryMap.get(id);
    if (entry) {
      reordered.push(entry);
      entryMap.delete(id);
    }
  });
  return [...reordered, ...entryMap.values()];
};

const clearDragPreview = () => {
  Array.from(els.list?.querySelectorAll?.(".session-row") || []).forEach((row) => {
    row.classList.remove("is-dragging");
  });
};

const syncDragPreview = () => {
  clearDragPreview();
  if (!dragState?.draggedId) return;
  const draggedRow = els.list?.querySelector?.(`.session-row[data-id="${dragState.draggedId}"]`);
  draggedRow?.classList.add("is-dragging");
};

const refresh = async (tabContext = null) => {
  const requestId = ++refreshRequestId;
  const { domain, tabId, url } = tabContext || await detectCurrentDomain();
  if (requestId !== refreshRequestId) return;
  currentDomain = domain;
  currentTabId = tabId;
  currentTabUrl = url;
  els.domain.textContent = currentDomain || t("domainUnavailable");
  updateButtonsState();

  if (!currentDomain) {
    currentSessionIdsCache = [];
    currentEntriesDomain = null;
    usingDomainHint = false;
    closeSessionMenu({ render: false });
    renderList([]);
    if (els.savedContextHint) {
      els.savedContextHint.hidden = true;
      els.savedContextHint.textContent = "";
    }
    return;
  }

  const request = {
    domain: currentDomain,
    url: currentTabUrl,
    tabId: currentTabId,
  };
  const metadataPromise = sendMessage({
    type: "getDomainMetadata",
    ...request,
  }).then(
    (data) => ({ data }),
    () => ({ data: null })
  );
  const exactStatePromise = sendMessage({
    type: "getDomainState",
    ...request,
  }).then(
    (data) => ({ data, error: null }),
    (error) => ({ data: null, error })
  );

  const metadataResult = await metadataPromise;
  if (
    requestId === refreshRequestId &&
    metadataResult.data
  ) {
    renderDomainStateSnapshot(metadataResult.data, { fallbackDomain: domain });
  }

  const exactResult = await exactStatePromise;
  if (requestId !== refreshRequestId) return;
  if (exactResult.error) throw exactResult.error;
  const exactState = exactResult.data;
  renderDomainStateSnapshot(exactState, { fallbackDomain: domain });
  const safeEntries = Array.isArray(exactState?.entries) ? exactState.entries : [];
  void syncOnboardingState({ entries: safeEntries });
};

const renderDomainStateSnapshot = (snapshot, { fallbackDomain = null, url = null } = {}) => {
  if (!snapshot || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.currentSessionIds)) {
    return false;
  }

  let pageDomain = fallbackDomain || snapshot.domain || currentDomain;
  if (url) {
    try {
      pageDomain = new URL(url).hostname || pageDomain;
      currentTabUrl = url;
    } catch (_) {}
  }
  currentDomain = pageDomain;
  currentSessionIdsCache = snapshot.currentSessionIds;
  currentEntriesDomain = snapshot.entriesDomain || snapshot.domain || pageDomain;
  usingDomainHint = Boolean(currentEntriesDomain && currentEntriesDomain !== currentDomain);
  els.domain.textContent = currentDomain || t("domainUnavailable");
  updateButtonsState();
  renderList(snapshot.entries, currentSessionIdsCache, currentEntriesDomain);
  if (els.savedContextHint) {
    els.savedContextHint.hidden = !usingDomainHint;
    els.savedContextHint.textContent = usingDomainHint
      ? fillTemplate(t("savedContextHint"), { domain: currentEntriesDomain })
      : "";
  }
  return true;
};

const resolveTheme = (value) => {
  return value === "dark" ? "dark" : "light";
};

const applyTheme = () => {
  const resolved = resolveTheme(themePreference);
  document.documentElement.setAttribute("data-theme", resolved);
  if (els.themeToggle) {
    els.themeToggle.setAttribute("aria-pressed", resolved === "dark" ? "true" : "false");
  }
};

const renderSaveMode = () => {
  if (els.saveModeControl) {
    els.saveModeControl.dataset.mode = saveMode === "clean" ? "clean" : "keep";
  }
  if (els.saveModeKeep) {
    els.saveModeKeep.classList.toggle("is-active", saveMode === "keep");
  }
  if (els.saveModeClean) {
    els.saveModeClean.classList.toggle("is-active", saveMode === "clean");
  }
  if (els.saveNotice) {
    els.saveNotice.textContent =
      saveMode === "clean" ? t("saveNoticeClean") : t("saveNoticeKeep");
  }
};

const setSaveMode = async (mode, { persist = true } = {}) => {
  saveMode = mode === "clean" ? "clean" : "keep";
  if (persist) {
    await chrome.storage.local.set({ [SAVE_MODE_KEY]: saveMode });
  }
  renderSaveMode();
};

const setBusy = (action = "", trigger = null) => {
  if (REFRESH_INVALIDATING_ACTIONS.has(action)) refreshRequestId += 1;
  busyAction = action;
  busyTarget = action ? describeBusyTarget(trigger) : null;
  updateButtonsState();
  if (busyTarget?.action !== "apply-here") {
    closeSessionMenu({ render: false });
  }
  renderList(listCache, currentSessionIdsCache);
};

const runBusyAction = async (action, task, trigger = null) => {
  if (isBusy()) return;
  setBusy(action, trigger);
  try {
    return await task();
  } finally {
    setBusy("");
  }
};

const loadTheme = async (storedData = null) => {
  const data = storedData || await chrome.storage.local.get("cookieSwapperTheme");
  themePreference = data.cookieSwapperTheme === "dark" ? "dark" : "light";
  applyTheme();
};

const loadLang = async (storedData = null) => {
  const data = storedData || await chrome.storage.local.get("cookieSwapperLang");
  const storedLang = data.cookieSwapperLang;
  currentLang = storedLang === "es" || storedLang === "zh" ? storedLang : "en";
  await loadTranslations(currentLang);
};

const loadSaveMode = async (storedData = null) => {
  const data = storedData || await chrome.storage.local.get(SAVE_MODE_KEY);
  saveMode = data[SAVE_MODE_KEY] === "clean" ? "clean" : "keep";
  renderSaveMode();
};

const loadOnboarding = async (storedData = null) => {
  const data = storedData || await chrome.storage.local.get(ONBOARDING_KEY);
  onboardingState = normalizeOnboardingState(data[ONBOARDING_KEY]);
};

const applyTranslations = () => {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : currentLang;
  if (els.quickStartEyebrow) els.quickStartEyebrow.textContent = t("quickStartEyebrow");
  if (els.quickStartTitle) els.quickStartTitle.textContent = t("quickStartTitle");
  if (els.quickStartDismiss) {
    els.quickStartDismiss.title = t("quickStartDismiss");
    els.quickStartDismiss.setAttribute("aria-label", t("quickStartDismiss"));
  }
  els.savePanelEyebrow.textContent = t("savePanelEyebrow");
  els.savedSmall.textContent = t("savedSmall");
  if (els.savedContextHint) {
    els.savedContextHint.hidden = !usingDomainHint;
    els.savedContextHint.textContent = usingDomainHint
      ? fillTemplate(t("savedContextHint"), { domain: currentEntriesDomain || "" })
      : "";
  }
  const emptyText = document.getElementById("emptyStateText");
  if (emptyText) emptyText.textContent = t("empty");
  els.saveBtn.textContent = t("saveBtn");
  els.labelInput.placeholder = t("labelPlaceholder");
  els.saveModeKeep.textContent = t("saveModeKeep");
  els.saveModeClean.textContent = t("saveModeClean");
  if (els.langSelect) {
    els.langSelect.setAttribute("aria-label", t("settingsLangLabel"));
  }
  if (els.settingsTitle) els.settingsTitle.textContent = t("settingsTitle");
  if (els.settingsLangLabel) els.settingsLangLabel.textContent = t("settingsLangLabel");
  if (els.settingsDataLabel) els.settingsDataLabel.textContent = t("settingsDataLabel");
  if (els.settingsToggle) {
    els.settingsToggle.title = t("settingsTitle");
    els.settingsToggle.setAttribute("aria-label", t("settingsTitle"));
  }
  renderReportAction();
  if (els.settingsBack) {
    els.settingsBack.title = t("settingsBack");
    els.settingsBack.setAttribute("aria-label", t("settingsBack"));
  }
  if (els.themeToggle) {
    els.themeToggle.title = t("themeToggle");
    els.themeToggle.setAttribute("aria-label", t("themeToggle"));
  }
  if (els.exportBtn) els.exportBtn.textContent = t("exportBtn");
  if (els.importBtn) els.importBtn.textContent = t("importBtn");
  if (els.logoutBtn) {
    els.logoutBtn.setAttribute("aria-label", t("logoutBtn"));
  }
  if (els.logoutBtnText) els.logoutBtnText.textContent = t("logoutBtn");
  if (els.logoutHint) els.logoutHint.textContent = t("logoutHint");
  if (modalState) syncModal();
  renderReviewPrompt();
  renderSaveMode();
  renderLangDropdown();
  renderList(listCache, currentSessionIdsCache);
  renderOnboarding();
  if (!currentDomain) {
    els.domain.textContent = t("domainUnavailable");
  }
};

const setLang = async (lang) => {
  currentLang = lang === "es" || lang === "zh" ? lang : "en";
  await chrome.storage.local.set({ cookieSwapperLang: currentLang });
  await loadTranslations(currentLang);
  applyTranslations();
  if (currentDomain) {
    await refresh();
  } else {
    renderList([]);
  }
};

const handleSave = async (trigger = els.saveBtn) => {
  if (!currentDomain) return;
  if (saveMode === "clean") {
    const confirmed = await openConfirmModal({
      title: t("modalCleanSaveTitle"),
      body: t("modalCleanSaveBody"),
      confirmText: t("modalCleanSaveConfirm"),
    });
    if (!confirmed) return;
  }

  try {
    await runBusyAction("save", async () => {
      let label = els.labelInput.value.trim();
      if (!label) {
        label = t("defaultLabel");
      }

      const result = await sendMessage({
        type: "saveCurrentCookies",
        domain: currentDomain,
        label,
        url: currentTabUrl,
        tabId: currentTabId,
        markCurrent: saveMode === "keep",
      });

      if (saveMode === "clean") {
        const logoutResult = await sendMessage({
          type: "pseudoLogout",
          domain: currentDomain,
          url: currentTabUrl,
          tabId: currentTabId,
        });
        if (!renderDomainStateSnapshot(logoutResult?.domainState, {
          fallbackDomain: currentDomain,
        })) {
          await refresh();
        }
      } else {
        if (!renderDomainStateSnapshot(result?.domainState, { fallbackDomain: currentDomain })) {
          await refresh();
        }
      }

      await Promise.all([
        markOnboardingStep("savedFirstSession"),
        recordReviewSuccessfulAction("save"),
      ]);
      els.labelInput.value = "";
      if (saveMode === "clean") {
        if (currentTabId) {
          await chrome.tabs.reload(currentTabId);
        }
      }
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleApplyForDomain = async (domain, id, trigger = null) => {
  if (!domain || !id) return;
  try {
    await runBusyAction("apply", async () => {
      const result = await sendMessage({
        type: "applyCookieSetNavigate",
        domain,
        id,
        tabId: currentTabId,
      });
      const outcome = await presentSessionRestoreResult(result, domain);
      if (outcome !== "confirmed") return;
      await Promise.all([
        markOnboardingStep("openedSavedSession"),
        recordReviewSuccessfulAction("swap"),
      ]);
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleApplyHere = async (id, domain = currentDomain, trigger = null) => {
  if (!domain || !currentTabUrl || !id) return;
  try {
    await runBusyAction("apply-here", async () => {
      const result = await sendMessage({
        type: "applyCookieSet",
        domain,
        id,
        url: currentTabUrl,
        tabId: currentTabId,
      });
      const outcome = await presentSessionRestoreResult(result, domain);
      if (outcome !== "confirmed") return;
      await Promise.all([
        markOnboardingStep("openedSavedSession"),
        recordReviewSuccessfulAction("swap"),
      ]);
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleLogout = async (trigger = els.logoutBtn) => {
  if (!currentDomain) return;
  const hasSavedCurrentSession = currentSessionIdsCache.length > 0;
  if (!hasSavedCurrentSession) {
    const confirmed = await openConfirmModal({
      title: t("modalLogoutTitle"),
      body: t("modalLogoutBody"),
      confirmText: t("modalLogoutConfirm"),
      tone: "danger",
    });
    if (!confirmed) return;
  }
  try {
    await runBusyAction("logout", async () => {
      const result = await sendMessage({
        type: "pseudoLogout",
        domain: currentDomain,
        url: currentTabUrl,
        tabId: currentTabId,
      });
      if (!renderDomainStateSnapshot(result?.domainState, {
        fallbackDomain: currentDomain,
      })) {
        await refresh();
      }
      if (currentTabId) {
        await chrome.tabs.reload(currentTabId);
      }
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleExport = async (trigger = els.exportBtn) => {
  const confirmed = await openConfirmModal({
    title: t("exportWarningTitle"),
    body: t("exportWarningBody"),
    confirmText: t("exportWarningConfirm"),
  });
  if (!confirmed) return;
  try {
    await runBusyAction("export", async () => {
      const data = await sendMessage({ type: "exportState" });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cookieswapper-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleImportFile = async (file, trigger = els.importBtn) => {
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    await showErrorModal(t("importTooLarge"));
    return;
  }
  try {
    await runBusyAction("import", async () => {
      const text = await file.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new Error(t("importInvalid"));
      }
      await sendMessage({ type: "importState", payload });
      await refresh();
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleReportSite = async (trigger = els.reportIssueBtn) => {
  if (isBusy()) return;
  if (!currentDomain) {
    await showErrorModal(t("errorInvalidDomain"));
    return;
  }
  const note = await openPromptModal({
    title: t("reportIssueTitle"),
    body: fillTemplate(t("reportIssueBody"), { domain: currentDomain }),
    fieldLabel: t("reportIssueLabel"),
    placeholder: t("reportIssuePlaceholder"),
    confirmText: t("reportIssueConfirm"),
    fieldType: "textarea",
    maxLength: 1200,
  });
  if (note === null) return;
  try {
    await runBusyAction("report-site", async () => {
      await sendMessage({
        type: "sendSiteReport",
        domain: currentDomain,
        note: String(note || "").trim(),
      });
      await showTransientSuccessModal({
        title: t("reportIssueSuccess"),
        body: t("reportIssueSuccessBody"),
      });
    }, trigger);
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleDelete = async (domain, id) => {
  if (!domain || !id) return;
  closeSessionMenu({ render: false });
  const entry = (domain === currentEntriesDomain ? listCache : [])?.find((item) => item.id === id);
  const label = entry?.label || t("defaultLabel");
  const confirmed = await openConfirmModal({
    title: t("modalDeleteTitle"),
    body: fillTemplate(t("modalDeleteBody"), { label }),
    confirmText: t("modalDeleteConfirm"),
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await runBusyAction("delete", async () => {
      await sendMessage({ type: "deleteCookieSet", domain, id });
      await refresh();
    });
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleRename = async (domain, id, currentLabel = "") => {
  if (!domain || !id) return;
  closeSessionMenu({ render: false });
  const nextRaw = await openPromptModal({
    title: t("modalRenameTitle"),
    body: t("modalRenameBody"),
    fieldLabel: t("modalRenameLabel"),
    value: currentLabel || t("defaultLabel"),
    confirmText: t("modalRenameConfirm"),
  });
  if (nextRaw === null) return;

  const trimmed = nextRaw.trim().slice(0, 64);
  const nextLabel = trimmed || t("defaultLabel");
  const previousLabel = (currentLabel || t("defaultLabel")).trim();
  if (nextLabel === previousLabel) return;

  try {
    await runBusyAction("rename", async () => {
      await sendMessage({
        type: "renameCookieSet",
        domain,
        id,
        label: nextLabel,
      });
      await refresh();
    });
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const toggleTheme = async () => {
  if (isBusy()) return;
  const next = resolveTheme(themePreference) === "dark" ? "light" : "dark";
  themePreference = next;
  await chrome.storage.local.set({ cookieSwapperTheme: next });
  applyTheme();
};

const handleLangChange = async (lang) => {
  if (!lang || isBusy()) return;
  closeLangDropdown();
  await setLang(lang);
};

const openSettings = () => {
  if (!els.settingsView || !els.mainView) return;
  closeSessionMenu({ render: false });
  closeLangDropdown();
  els.settingsView.classList.remove("hidden");
  els.mainView.classList.add("hidden");
  void markOnboardingStep("openedSettings");
};

const closeSettings = () => {
  if (!els.settingsView || !els.mainView) return;
  closeLangDropdown();
  els.settingsView.classList.add("hidden");
  els.mainView.classList.remove("hidden");
};

const toggleSettings = () => {
  if (!els.settingsView || !els.mainView) return;
  if (els.settingsView.classList.contains("hidden")) {
    openSettings();
  } else {
    closeSettings();
  }
};

const handleListClick = (event) => {
  if (isBusy()) return;

  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;

  const { action, id, label, domain } = actionTarget.dataset;
  const targetDomain = domain || currentDomain;

  if (action === "toggle-menu") {
    toggleSessionMenu(targetDomain, id);
    return;
  }

  if (action === "apply") {
    closeSessionMenu({ render: false });
    void handleApplyForDomain(targetDomain, id, actionTarget);
    return;
  }

  if (action === "apply-here") {
    void handleApplyHere(id, targetDomain, actionTarget);
    return;
  }

  closeSessionMenu({ render: false });

  if (action === "rename") {
    void handleRename(targetDomain, id, label || "");
    return;
  }

  if (action === "delete") {
    void handleDelete(targetDomain, id);
  }
};

const handleListDragStart = (event) => {
  const row = event.target.closest(".session-row[data-id]");
  if (!row || !canReorderSessions(row.dataset.domain)) {
    event.preventDefault();
    return;
  }

  closeSessionMenu({ render: false });
  dragState = {
    draggedId: row.dataset.id,
    domain: row.dataset.domain || currentEntriesDomain || currentDomain,
    overId: row.dataset.id,
    placement: "after",
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.dropEffect = "move";
    event.dataTransfer.setData("text/plain", row.dataset.id);
    try {
      event.dataTransfer.setDragImage(row, 24, Math.min(row.offsetHeight / 2, 28));
    } catch (_) {}
  }
  setTimeout(() => {
    syncDragPreview();
  }, 0);
};

const handleListDragOver = (event) => {
  if (!dragState?.draggedId) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  const draggedRow = els.list?.querySelector?.(`.session-row[data-id="${dragState.draggedId}"]`);
  if (!draggedRow) return;

  const allRows = Array.from(els.list?.querySelectorAll?.(".session-row[data-id]") || []);
  if (allRows.length < 2) return;

  let targetRow = null;
  let placement = "after";

  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    if (r.dataset.id === dragState.draggedId) continue;
    const rect = r.getBoundingClientRect();
    if (event.clientY <= rect.top + rect.height / 2) {
      targetRow = r;
      placement = "before";
      break;
    }
    targetRow = r;
    placement = "after";
  }

  if (!targetRow) return;

  const refNode = placement === "before" ? targetRow : targetRow.nextElementSibling;
  if (refNode !== draggedRow) {
    const beforeRects = snapshotListRects();
    els.list.insertBefore(draggedRow, refNode);
    animateListReorder(beforeRects);
  }

  dragState.overId = targetRow.dataset.id;
  dragState.placement = placement;
  syncDragPreview();
};

const finishListDrag = () => {
  dragState = null;
  clearDragPreview();
};

const handleListDrop = async (event) => {
  if (!dragState?.draggedId || !dragState.domain) {
    finishListDrag();
    return;
  }

  event.preventDefault();
  const { draggedId, overId, placement, domain } = dragState;
  finishListDrag();

  if (!overId || draggedId === overId) return;

  const nextIds = Array.from(els.list?.querySelectorAll?.(".session-row[data-id]") || []).map(
    (row) => row.dataset.id
  );
  const currentIds = listCache.map((entry) => entry.id);
  if (nextIds.join("|") === currentIds.join("|")) return;

  const beforeRects = snapshotListRects();
  refreshRequestId += 1;
  listCache = reorderEntriesByIds(listCache, nextIds);
  renderList(listCache, currentSessionIdsCache, currentEntriesDomain);
  animateListReorder(beforeRects);

  try {
    await sendMessage({
      type: "reorderCookieSets",
      domain,
      ids: nextIds,
    });
  } catch (_) {
    await refresh().catch(() => {});
    await showErrorModal(t("reorderFailed"));
    return;
  }

  try {
    await refresh();
  } catch (error) {
    await showErrorModal(error.message);
  }
};

const handleDocumentClick = (event) => {
  if (openSessionMenuKey && !event.target.closest(".menu-shell")) {
    closeSessionMenu();
  }
  if (isLangDropdownOpen && !event.target.closest(".select-shell")) {
    closeLangDropdown();
  }
};

const handleScroll = () => {
  if (openSessionMenuKey) {
    closeSessionMenu();
  }
};

const handleQuickStartClick = (event) => {
  const check = event.target.closest(".quickstart-check");
  if (!check || isBusy()) return;

  const { stepId } = check.dataset;
  if (!stepId) return;

  void markOnboardingStep(stepId);
};

const handleDocumentKeydown = (event) => {
  if (els.reviewPromptRoot && !els.reviewPromptRoot.hidden) {
    if (event.key === "Escape" && reviewPromptCloseReady && !reviewPromptSending) {
      event.preventDefault();
      void dismissReviewPrompt();
    }
    return;
  }
  if (modalState) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(null);
    }
    if (event.key === "Enter" && modalState.kind === "prompt" && event.target === els.modalInput) {
      event.preventDefault();
      submitModal();
    }
    return;
  }

  if (event.key === "Escape" && openSessionMenuKey) {
    closeSessionMenu();
  }
  if (event.key === "Escape" && isLangDropdownOpen) {
    if (document.activeElement?.closest?.(".select-shell")) {
      els.langSelect?.focus();
    }
    closeLangDropdown();
    return;
  }
  if (!isBusy() && event.target === els.langSelect && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    if (!isLangDropdownOpen) {
      isLangDropdownOpen = true;
      renderLangDropdown();
    }
    focusLangOption();
    return;
  }
  if (isLangDropdownOpen && event.target?.matches?.("[data-lang-option]")) {
    const options = Array.from(els.langDropdown?.querySelectorAll("[data-lang-option]") || []);
    const currentIndex = options.indexOf(event.target);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      options[(currentIndex + 1) % options.length]?.focus();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      options[(currentIndex - 1 + options.length) % options.length]?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      options[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      options[options.length - 1]?.focus();
      return;
    }
    if (event.key === "Tab") {
      closeLangDropdown();
    }
  }
};

const init = async () => {
  setModalOpen(false);
  setReviewPromptOpen(false);
  if (els.modalField) {
    els.modalField.hidden = true;
  }

  if (els.modalBackdrop) {
    els.modalBackdrop.addEventListener("click", () => {
      closeModal(null);
    });
  }
  if (els.modalCancelBtn) {
    els.modalCancelBtn.addEventListener("click", () => {
      closeModal(null);
    });
  }
  if (els.modalConfirmBtn) {
    els.modalConfirmBtn.addEventListener("click", () => {
      submitModal();
    });
  }
  if (els.reviewPromptClose) {
    els.reviewPromptClose.addEventListener("click", () => {
      void dismissReviewPrompt();
    });
  }
  if (els.reviewStars) {
    els.reviewStars.addEventListener("pointermove", (event) => {
      const button = event.target.closest("[data-review-rating]");
      previewReviewRating(button?.dataset.reviewRating);
    });
    els.reviewStars.addEventListener("pointerleave", () => {
      previewReviewRating(0);
    });
    els.reviewStars.addEventListener("click", (event) => {
      const button = event.target.closest("[data-review-rating]");
      if (button) selectReviewRating(button.dataset.reviewRating);
    });
    els.reviewStars.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const buttons = Array.from(els.reviewStars.querySelectorAll("[data-review-rating]"));
      const currentIndex = Math.max(0, buttons.indexOf(document.activeElement));
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(currentIndex + direction + buttons.length) % buttons.length];
      event.preventDefault();
      next?.focus();
    });
  }
  if (els.reviewFeedbackBtn) {
    els.reviewFeedbackBtn.addEventListener("click", () => {
      void sendReviewFeedback();
    });
  }
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("scroll", handleScroll, true);

  els.list.addEventListener("click", handleListClick);
  els.list.addEventListener("dragstart", handleListDragStart);
  els.list.addEventListener("dragover", handleListDragOver);
  els.list.addEventListener("drop", (event) => {
    void handleListDrop(event);
  });
  els.list.addEventListener("dragend", finishListDrag);
  if (els.quickStartList) {
    els.quickStartList.addEventListener("click", handleQuickStartClick);
  }

  els.saveBtn.addEventListener("click", () => {
    void handleSave(els.saveBtn);
  });
  els.labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSave(els.saveBtn);
    }
  });
  els.themeToggle.addEventListener("click", () => {
    void toggleTheme();
  });
  if (els.settingsToggle) els.settingsToggle.addEventListener("click", toggleSettings);
  if (els.reportIssueBtn) {
    els.reportIssueBtn.addEventListener("click", () => {
      void handleReportSite(els.reportIssueBtn);
    });
  }
  if (els.settingsBack) els.settingsBack.addEventListener("click", closeSettings);
  if (els.langSelect) {
    els.langSelect.addEventListener("click", () => {
      toggleLangDropdown();
    });
  }
  if (els.langDropdown) {
    els.langDropdown.addEventListener("click", (event) => {
      const option = event.target.closest("[data-lang-option]");
      if (!option || isBusy()) return;
      void handleLangChange(option.dataset.langOption);
    });
  }
  if (els.exportBtn) els.exportBtn.addEventListener("click", () => {
    void handleExport(els.exportBtn);
  });
  if (els.importBtn) {
    els.importBtn.addEventListener("click", () => {
      if (!isBusy() && els.importFile) els.importFile.click();
    });
  }
  if (els.importFile) {
    els.importFile.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      void handleImportFile(file, els.importBtn);
      event.target.value = "";
    });
  }
  if (els.saveModeKeep) {
    els.saveModeKeep.addEventListener("click", () => {
      if (!isBusy()) void setSaveMode("keep");
    });
  }
  if (els.saveModeClean) {
    els.saveModeClean.addEventListener("click", () => {
      if (!isBusy()) void setSaveMode("clean");
    });
  }
  if (els.logoutBtn) {
    els.logoutBtn.addEventListener("click", () => {
      void handleLogout(els.logoutBtn);
    });
  }
  if (els.quickStartDismiss) {
    els.quickStartDismiss.addEventListener("click", () => {
      void dismissOnboarding();
    });
  }
  const [storedData, tabContext] = await Promise.all([
    chrome.storage.local.get([
      "cookieSwapperTheme",
      "cookieSwapperLang",
      SAVE_MODE_KEY,
      ONBOARDING_KEY,
      REVIEW_PROMPT_KEY,
    ]),
    detectCurrentDomain(),
  ]);
  await Promise.all([
    loadTheme(storedData),
    loadLang(storedData),
    loadSaveMode(storedData),
    loadOnboarding(storedData),
    loadReviewPromptState(storedData),
  ]);
  const reviewOpenPromise = recordReviewPopupOpen().catch(() => {});
  applyTranslations();

  try {
    await refresh(tabContext);
  } catch (error) {
    await showErrorModal(error.message);
  }
  await reviewOpenPromise;
  maybeShowReviewPrompt();
};

init().catch((error) => {
  console.error(error);
  void showErrorModal(error.message);
});
