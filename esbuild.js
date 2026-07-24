// Bundles the VS Code extension entry (extension/extension.ts + core/) into
// dist/extension.js. `vscode` is provided by the host and must stay external.
// Also copies the tree-sitter wasm runtime + grammars into dist/wasm so the
// bundled extension can load them at runtime.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Grammars shipped with the extension (must exist in tree-sitter-wasms/out).
const GRAMMARS = ["python", "javascript", "typescript", "tsx", "java", "go", "rust", "ruby", "c", "cpp"];

function copyWasm() {
  const outDir = path.join(__dirname, "dist", "wasm");
  fs.mkdirSync(outDir, { recursive: true });
  const wtsDir = path.dirname(require.resolve("web-tree-sitter/package.json"));
  fs.copyFileSync(path.join(wtsDir, "tree-sitter.wasm"), path.join(outDir, "tree-sitter.wasm"));
  const grammarSrc = path.dirname(require.resolve("tree-sitter-wasms/package.json")) + "/out";
  for (const g of GRAMMARS) {
    const file = `tree-sitter-${g}.wasm`;
    const src = path.join(grammarSrc, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, file));
    else console.warn(`grammar missing, skipped: ${file}`);
  }
  console.log(`copied tree-sitter wasm + ${GRAMMARS.length} grammars → dist/wasm`);
}

async function main() {
  copyWasm();
  const ctx = await esbuild.context({
    entryPoints: ["extension/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: !production,
    minify: production,
    external: ["vscode"],
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
