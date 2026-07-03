import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and leaves the console alone.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5180, strictPort: true },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
  },
});
