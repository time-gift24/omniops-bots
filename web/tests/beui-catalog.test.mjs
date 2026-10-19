import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import ts from "typescript"

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const vendor = resolve(web, "vendor/beui-templates")
const sha256 = content => createHash("sha256").update(content).digest("hex")
const packageJson = JSON.parse(await readFile(resolve(web, "package.json"), "utf8"))
const manifest = JSON.parse(await readFile(resolve(vendor, "manifest.json"), "utf8"))

async function exists(path) {
  return stat(path).then(result => result.isFile(), () => false)
}

async function resolveLocal(path) {
  for (const candidate of [path, ...[".ts", ".tsx", ".js", ".jsx", ".json", ".css"].map(extension => path + extension), ...[".ts", ".tsx"].map(extension => resolve(path, "index" + extension))]) {
    if (await exists(candidate)) return candidate
  }
}

function imports(file, content) {
  const modules = []
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) modules.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) modules.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true))
  return modules
}

test("beUI catalog retains every mirror file and verifies all installed source hashes", async () => {
  const entries = new Map(manifest.files.map(entry => [entry.path, entry]))
  assert.equal(entries.size, manifest.files.length, "Manifest paths must be unique")
  assert.equal(manifest.files.filter(entry => entry.originalMirrorSha256).length, 772, "All 772 original mirror files must remain present")
  for (const entry of entries.values()) {
    const path = resolve(vendor, entry.path)
    assert(path.startsWith(vendor + sep), `Invalid catalog path: ${entry.path}`)
    const content = await readFile(path)
    assert.equal(sha256(content), entry.installedSha256, `Source drift: ${entry.path}`)
  }
  const scan = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (/\.(?:ts|tsx|css)$/.test(entry.name)) assert(entries.has(relative(vendor, path).split(sep).join("/")), `Untracked vendor source: ${path}`)
    }
  }
  await scan(vendor)
})

test("all beUI modules resolve local sources and declare real external dependencies", async () => {
  for (const entry of manifest.files.filter(entry => /\.(?:ts|tsx)$/.test(entry.path))) {
    const path = resolve(vendor, entry.path)
    for (const module of imports(path, await readFile(path, "utf8"))) {
      if (module.startsWith("@beui-template/") || module.startsWith(".")) {
        const target = module.startsWith(".") ? resolve(dirname(path), module) : resolve(vendor, module.slice("@beui-template/".length))
        assert(target.startsWith(vendor + sep), `Vendor import escapes its catalog: ${module}`)
        assert(await resolveLocal(target), `${entry.path}: missing ${module}`)
      } else {
        assert(!module.startsWith("@/"), `${entry.path}: product alias leaked into vendor source`)
        const name = module.startsWith("@") ? module.split("/").slice(0, 2).join("/") : module.split("/")[0]
        assert(packageJson.dependencies[name], `${entry.path}: undeclared ${name}`)
        assert(import.meta.resolve(module), `${entry.path}: unavailable ${module}`)
      }
    }
  }
})

test("beUI public assets match their recorded sources and adaptations", async () => {
  assert.equal(manifest.assets.length, 3)
  for (const asset of manifest.assets) {
    assert(asset.publicPath.startsWith("/") && !asset.publicPath.includes(".."))
    assert.equal(new URL(asset.url).origin, "https://pro.beui.dev")
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/)
    assert.equal(sha256(await readFile(resolve(web, "public", asset.publicPath.slice(1)))), asset.installedSha256, `Asset drift: ${asset.publicPath}`)
  }
})
