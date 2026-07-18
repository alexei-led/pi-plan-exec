import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import {
  EXEC_ACTION,
  EXTERNAL_OPERATION_STATE,
  OPERATION_KIND,
  OPERATION_RECOVERY,
  OPERATION_SERVICE,
  RUN_STAGE,
  RUN_STATUS,
} from "./src/types.ts";

const DOMAIN_VALUE_PATTERN = [...new Set(
  [
    EXEC_ACTION,
    EXTERNAL_OPERATION_STATE,
    OPERATION_KIND,
    OPERATION_RECOVERY,
    OPERATION_SERVICE,
    RUN_STAGE,
    RUN_STATUS,
  ].flatMap((domain) => Object.values(domain)),
)]
  .sort((left, right) => right.length - left.length)
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    ignores: ["node_modules/", ".pi-subagents/"],
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/types.ts"],
    rules: {
      "no-magic-numbers": [
        "error",
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          enforceConst: true,
          detectObjects: true,
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `:matches(BinaryExpression, SwitchCase) > Literal[value=/^(${DOMAIN_VALUE_PATTERN})$/]`,
          message:
            "Use the canonical plan-exec domain constant instead of a raw persisted value.",
        },
      ],
    },
  },
);
