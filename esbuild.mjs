import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode"],
  minify: true,
  sourcemap: true,
  target: "node20",
  logLevel: "info"
};

if (watch) {
  const ctx = await esbuild.context(shared);
  await ctx.watch();
  console.log("esbuild watching...");
} else {
  await esbuild.build(shared);
}
