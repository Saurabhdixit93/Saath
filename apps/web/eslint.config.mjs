import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "public/sw.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended
);
