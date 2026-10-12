import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/content.ts", "src/background.ts", "src/options.ts"],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
});

await cp("static", "dist", { recursive: true });
console.log("Built to dist/");
