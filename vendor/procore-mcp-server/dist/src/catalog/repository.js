import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
// When compiled: dist/src/catalog/ → need ../../../data to reach project root
const DATA_DIR = join(__dirname, "..", "..", "..", "data");
let catalogCache = null;
let categoriesCache = null;
export function loadCatalog() {
    if (catalogCache)
        return catalogCache;
    const raw = readFileSync(join(DATA_DIR, "catalog.json"), "utf8");
    catalogCache = JSON.parse(raw);
    return catalogCache;
}
export function loadCategories() {
    if (categoriesCache)
        return categoriesCache;
    const raw = readFileSync(join(DATA_DIR, "categories.json"), "utf8");
    categoriesCache = JSON.parse(raw);
    return categoriesCache;
}
export function loadEndpointDetail(operationId) {
    try {
        const raw = readFileSync(join(DATA_DIR, "endpoint-details", `${operationId}.json`), "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function findByOperationId(operationId) {
    const catalog = loadCatalog();
    return catalog.find((e) => e.operationId === operationId);
}
