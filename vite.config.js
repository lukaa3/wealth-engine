import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "./" makes the build work at https://<user>.github.io/<repo>/ without hard-coding the repo name.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
