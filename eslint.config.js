// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Boundary rules (CLAUDE.md, "Otari and models"):
 * - packages/orchestrator/src/otari/ is the only module that may import the
 *   OpenAI-compatible SDK or reference api.otari.ai.
 * - No other provider SDK may be imported anywhere, including src/otari/.
 * - scenarios/ never imports anything Otari-specific (or the orchestrator).
 * - apps/dashboard never calls Otari; it proxies to the orchestrator.
 */
const OTARI_MODULE = "packages/orchestrator/src/otari/**";

const providerSdks = [
  { name: "@anthropic-ai/sdk", message: "Every model call goes through otari.ai; no provider SDKs." },
  { name: "@google/generative-ai", message: "Every model call goes through otari.ai; no provider SDKs." },
  { name: "@google/genai", message: "Every model call goes through otari.ai; no provider SDKs." },
  { name: "@mistralai/mistralai", message: "Every model call goes through otari.ai; no provider SDKs." },
  { name: "groq-sdk", message: "Every model call goes through otari.ai; no provider SDKs." },
  { name: "cohere-ai", message: "Every model call goes through otari.ai; no provider SDKs." },
];
const openaiPath = {
  name: "openai",
  message: "Only packages/orchestrator/src/otari/ may import the OpenAI-compatible SDK.",
};
const openaiPattern = {
  group: ["openai/*"],
  message: "Only packages/orchestrator/src/otari/ may import the OpenAI-compatible SDK.",
};
// Matches the host in string and template literals only. It catches mistakes
// (a stray fetch to the gateway outside the otari module), not deliberate
// evasion such as concatenation; test/boundaries.test.ts states the intent.
const otariUrlMessage = "Only packages/orchestrator/src/otari/ may reference the Otari API host.";
const otariUrlSyntax = [
  { selector: "Literal[value=/api\\.otari\\.ai/]", message: otariUrlMessage },
  { selector: "TemplateElement[value.raw=/api\\.otari\\.ai/]", message: otariUrlMessage },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "vendor/**",
      "runs/**",
      "shared/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-imports": ["error", { paths: [openaiPath, ...providerSdks], patterns: [openaiPattern] }],
      "no-restricted-syntax": ["error", ...otariUrlSyntax],
    },
  },
  {
    // The single Otari gateway: may import openai and name api.otari.ai.
    files: [OTARI_MODULE],
    rules: {
      "no-restricted-imports": ["error", { paths: providerSdks }],
      "no-restricted-syntax": "off",
    },
  },
  {
    // Reusable attack fixtures: no Otari, no orchestrator, no model SDKs.
    files: ["scenarios/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [openaiPath, ...providerSdks],
          patterns: [
            openaiPattern,
            {
              group: ["@rogueproof/orchestrator", "@rogueproof/orchestrator/*", "**/orchestrator/**", "**/otari/**", "*otari*", "@otari/*"],
              message: "scenarios/ must not import anything Otari-specific or the orchestrator.",
            },
          ],
        },
      ],
    },
  },
  {
    // The dashboard proxies to the orchestrator; it never reaches the Otari module.
    files: ["apps/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [openaiPath, ...providerSdks],
          patterns: [
            openaiPattern,
            {
              group: ["**/otari/**", "@rogueproof/orchestrator/*otari*"],
              message: "apps/dashboard never calls Otari; proxy to the orchestrator.",
            },
          ],
        },
      ],
    },
  },
);
