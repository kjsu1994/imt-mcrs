import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Mapped cloud drives do not support Windows native realpath used by worker imports.
  resolve: { preserveSymlinks: true },
  base: "./",
});
