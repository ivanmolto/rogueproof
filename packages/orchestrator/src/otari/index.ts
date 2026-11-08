/**
 * The only Otari gateway in the repo. Will hold the keys per role,
 * set the end user, capture Otari-* headers, normalise the seven outcomes,
 * bound retries and record redacted request/response pairs.
 * Empty until "Route all LLM calls through otari.ai".
 */
export const MODULE = "otari" as const;
