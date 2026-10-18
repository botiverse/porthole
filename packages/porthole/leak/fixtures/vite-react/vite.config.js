import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The leak suite's Vite + React fixture (P081): built once and committed as out/ (npm install,
// then npx vite build --outDir out). Relative URLs (base "./"): the build is served under its
// version's own address (/v/3/, or a frame's), never at an origin's root.
export default defineConfig({ base: "./", plugins: [react()], build: { assetsInlineLimit: 0, outDir: "out" } });
