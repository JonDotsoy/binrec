import { chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "dist");

const pkg = await Bun.file(join(root, "package.json")).json();

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "index.ts")],
  outdir,
  naming: "binrec.js",
  target: "bun",
  format: "esm",
  banner: "#!/usr/bin/env bun",
  define: { BINREC_BUNDLED: "true" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod(join(outdir, "binrec.js"), 0o755);

await Bun.write(
  join(outdir, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      type: "module",
      module: "binrec.js",
      exports: { ".": "./binrec.js" },
      bin: { binrec: "binrec.js" },
      repository: { type: "git", url: "git+https://github.com/JonDotsoy/binrec.git" },
      // The root package.json stays `private` so it is never published by
      // mistake; dist is published as a restricted package on GitHub Packages.
      publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" },
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${join("dist", "binrec.js")} and ${join("dist", "package.json")}`);
