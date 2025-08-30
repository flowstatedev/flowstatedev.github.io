import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";
import {
  defineConfig
} from "eslint/config";

export default defineConfig([
  jsdoc.configs['flat/recommended'],
  {
  files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      js,
      jsdoc
    },
    extends: ["js/recommended"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "module"
    }
  },
]);