import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  workers: 1,
  reporter: "list",
  timeout: 30_000,
});
