import { defineConfig } from "blume";
import occludeLive from "./live-integration.mjs";

export default defineConfig({
  title: "occlude",
  description: "Plotter-native creative coding: the pen is the medium.",
  content: {
    root: "../../docs",
    include: ["index.mdx", "reference/**/*.mdx", "examples/**/*.mdx"],
  },
  deployment: { base: "/docs" },
  integrations: [occludeLive()],
  theme: { mode: "system" },
});
