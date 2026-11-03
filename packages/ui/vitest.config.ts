import { beamVitest } from "@beam/config";
import react from "@vitejs/plugin-react";
import { defineConfig, mergeConfig } from "vitest/config";

// Components render in jsdom (DR-9 preset with jsdom).
export default defineConfig(mergeConfig(beamVitest({ jsdom: true }), { plugins: [react()] }));
