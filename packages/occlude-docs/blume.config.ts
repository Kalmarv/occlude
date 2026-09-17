import { defineConfig } from "blume";
import occludeLive from "./live-integration.mjs";

export default defineConfig({
  title: "occlude",
  description: "Plotter-native creative coding: the pen is the medium.",
  content: {
    root: "../../docs",
    include: ["index.md", "reference/**/*.md", "examples/**/*.md"],
  },
  deployment: { base: "/docs" },
  integrations: [occludeLive()],
  theme: { mode: "system" },
});
