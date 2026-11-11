/** Honeypot (task 3.1): the static "Lumen Notes" site with three hidden injection variants. */
export {
  createHoneypot,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PREFIX,
  INJECTION_MARKER,
  INJECTION_TEXT,
  loadSite,
  normalizePrefix,
  resolveRequest,
  SITE_DIR,
  type HoneypotOptions,
  type Resolution,
} from "./server.js";
