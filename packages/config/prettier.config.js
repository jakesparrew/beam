/** Shared Prettier preset (`@beam/config/prettier`). */
const config = {
  printWidth: 110,
  singleQuote: false,
  trailingComma: "all",
  semi: true,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindFunctions: ["cn", "cva", "clsx"],
};

export default config;
