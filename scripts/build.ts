import { $ } from "bun";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

await Bun.write(join(outdir, "binrec.d.ts"), await buildDeclarations());

// npm shows the README of the published folder on the package page.
for (const file of ["README.md", "LICENSE", "SECURITY.md"]) {
  await Bun.write(join(outdir, file), Bun.file(join(root, file)));
}
// The font binrec export draws videos with is bundled, so its license ships too.
await Bun.write(join(outdir, "FONT-LICENSE.txt"), Bun.file(join(root, "src", "video", "FONT-LICENSE.txt")));

await Bun.write(
  join(outdir, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      author: pkg.author,
      homepage: pkg.homepage,
      bugs: pkg.bugs,
      type: "module",
      module: "binrec.js",
      types: "./binrec.d.ts",
      exports: { ".": { types: "./binrec.d.ts", default: "./binrec.js" } },
      bin: { binrec: "binrec.js" },
      repository: pkg.repository,
      // The root package.json stays `private` so it is never published by
      // mistake; dist is published to npm as a public package.
      publishConfig: { registry: "https://registry.npmjs.org/", access: "public" },
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${join("dist", "binrec.js")}, binrec.d.ts, package.json, README.md, LICENSE, SECURITY.md and FONT-LICENSE.txt`);

/**
 * Emits declarations for index.ts with tsc and joins the modules it reaches
 * into one file, so dist/binrec.d.ts has no imports of ./src/*.ts. Only the
 * names index.ts exports stay exported.
 */
async function buildDeclarations() {
  const temp = await mkdtemp(join(tmpdir(), "binrec-dts-"));
  try {
    const out = join(temp, "out");
    const config = join(temp, "tsconfig.json");
    await Bun.write(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        files: [join(root, "index.ts")],
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: root,
          outDir: out,
          // @types/bun is looked up next to the config, which lives in the temp folder.
          typeRoots: [join(root, "node_modules", "@types")],
        },
      }),
    );
    await $`${join(root, "node_modules", ".bin", "tsc")} -p ${config}`.cwd(root);

    const localImport = /^(?:import|export)\b.*\bfrom "(\.\.?\/[^"]+)";$/;
    const modules: string[] = [];
    const visit = async (file: string) => {
      if (modules.includes(file)) return;
      modules.push(file); // reserve the spot so cycles stop here
      for (const line of (await Bun.file(file).text()).split("\n")) {
        const from = line.match(localImport)?.[1];
        if (from) await visit(resolve(dirname(file), from.replace(/\.ts$/, ".d.ts")));
      }
      modules.push(modules.splice(modules.indexOf(file), 1)[0]!); // dependencies first
    };
    const entry = join(out, "index.d.ts");
    await visit(entry);

    const entryText = await Bun.file(entry).text();
    if (entryText.includes(" as ")) throw new Error("build: renamed exports are not supported in index.ts");
    const publicNames = new Set(
      [...entryText.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap((m) =>
        m[1]!.split(",").map((name) => name.trim()).filter(Boolean),
      ),
    );

    // One block per top-level declaration, with the doc comment above it.
    const declaration = /^(export )?(?:declare )?(?:const|let|function|type|interface|class|enum) (\w+)/;
    const blocks = new Map<string, string>();
    for (const file of modules.filter((file) => file !== entry)) {
      let comment: string[] = [];
      let name: string | undefined;
      for (const line of (await Bun.file(file).text()).split("\n")) {
        if (!line || localImport.test(line) || line === "export {};") continue;
        const match = line.match(declaration);
        if (match) {
          name = match[2]!;
          if (blocks.has(name)) throw new Error(`build: ${name} is declared twice in the declarations`);
          const local = match[1] ? line.slice("export ".length) : line;
          blocks.set(name, [...comment, publicNames.has(name) ? `export ${local}` : local].join("\n"));
          comment = [];
        } else if (line.startsWith("/**") || comment.length) {
          comment.push(line);
        } else if (name) {
          blocks.set(name, `${blocks.get(name)}\n${line}`);
        }
      }
    }
    for (const name of publicNames) {
      if (!blocks.has(name)) throw new Error(`build: ${name} is exported by index.ts but not declared`);
    }

    // Keep the public names and the private ones they refer to, in source order.
    // Doc comments and property names such as `stats(): …` are not references.
    const keep = new Set(publicNames);
    for (const name of keep) {
      const code = blocks.get(name)!.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [other] of blocks) {
        if (other !== name && new RegExp(`\\b${other}\\b(?!\\??\\s*[:(])`).test(code)) keep.add(other);
      }
    }
    const kept = [...blocks].filter(([name]) => keep.has(name)).map(([, block]) => block);
    // Without `export {}` a .d.ts exports every top-level declaration, `create` included.
    return `${kept.join("\n\n")}\n\nexport {};\n`;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
