import { readdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const vendor = resolve(web, "vendor/beui-templates")
const input = {}

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      input[relative(vendor, path).replace(/\.(?:ts|tsx)$/, "")] = path
    }
  }
}

await collect(vendor)
if (!Object.keys(input).length) throw new Error("beUI template catalog is empty")
await build({
  root: web,
  configFile: resolve(web, "vite.config.ts"),
  build: {
    write: false,
    emptyOutDir: false,
    minify: false,
    reportCompressedSize: false,
    rollupOptions: { input },
  },
})
console.log(`Validated bundling for all ${Object.keys(input).length} beUI source modules`)
