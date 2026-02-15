import { defineConfig } from "vite";
import commonjs from "@rollup/plugin-commonjs";

export default defineConfig({
  plugins: [commonjs()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: "src/popup.ts",
        options: "src/options.ts",
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
        inlineDynamicImports: false,
      },
    },
    target: "esnext",
    minify: false,
  },
});
