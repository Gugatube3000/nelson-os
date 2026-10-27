import { z } from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { procoreApiCall } from "../api/client.js";
import { buildDescription } from "./description-builder.js";
import { enrichParamDescription } from "./param-descriptions.js";
import { buildAnnotations, buildTitle } from "./annotation-builder.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "..", "..", "data", "tools-manifest.json");
function buildZodType(param, moduleName) {
    const desc = enrichParamDescription(param.name, param.description, moduleName, param.source);
    let zodType;
    switch (param.type) {
        case "number":
            zodType = z.number().describe(desc);
            break;
        case "boolean":
            zodType = z.boolean().describe(desc);
            break;
        case "array":
            zodType = z.array(z.unknown()).describe(desc);
            break;
        case "object":
            zodType = z.record(z.unknown()).describe(desc);
            break;
        default:
            if (param.enum && param.enum.length > 0 && param.enum.length <= 20) {
                const enumValues = param.enum.map(String);
                zodType = z
                    .enum(enumValues)
                    .describe(desc);
            }
            else {
                zodType = z.string().describe(desc);
            }
    }
    if (!param.required) {
        zodType = zodType.optional();
    }
    return zodType;
}
function createToolHandler(entry) {
    return async (args) => {
        const pathParams = {};
        const queryParams = {};
        const bodyObj = {};
        for (const param of entry.params) {
            const value = args[param.name];
            if (value === undefined || value === null)
                continue;
            switch (param.source) {
                case "path":
                    pathParams[param.name] = String(value);
                    break;
                case "query":
                    queryParams[param.name] = value;
                    break;
                case "body":
                    bodyObj[param.name] = value;
                    break;
            }
            // Identifier that Procore expects in the URL *and* the payload.
            if (param.alsoBody && param.source !== "body") {
                bodyObj[param.name] = value;
            }
        }
        let body;
        if (Object.keys(bodyObj).length > 0) {
            body = entry.bodyWrapper ? { [entry.bodyWrapper]: bodyObj } : bodyObj;
        }
        try {
            const response = await procoreApiCall({
                method: entry.method,
                path: entry.path,
                pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
                queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
                body,
            });
            const parts = [];
            parts.push(response.status >= 200 && response.status < 300
                ? `Status: ${response.status} OK`
                : `Status: ${response.status}`);
            const dataStr = JSON.stringify(response.data, null, 2);
            if (dataStr.length > 50000) {
                parts.push(`\nResponse (truncated):\n${dataStr.slice(0, 50000)}\n... (truncated)`);
            }
            else {
                parts.push(`\nResponse:\n${dataStr}`);
            }
            if (response.pagination) {
                const p = response.pagination;
                parts.push(`\nPagination: page ${p.current_page}, ${p.per_page}/page`);
                if (p.total !== undefined)
                    parts.push(`Total: ${p.total}`);
                if (p.has_next)
                    parts.push(`More pages available — use page=${p.current_page + 1}`);
            }
            if (response.rate_limit && response.rate_limit.remaining < 20) {
                parts.push(`\nRate limit: ${response.rate_limit.remaining}/${response.rate_limit.limit} remaining`);
            }
            return { content: [{ type: "text", text: parts.join("\n") }] };
        }
        catch (err) {
            return {
                content: [
                    { type: "text", text: `Error: ${err.message}` },
                ],
                isError: true,
            };
        }
    };
}
export function registerAutoTools(server) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    }
    catch {
        console.error("Failed to load tools manifest. Run 'npm run generate' first.");
        return 0;
    }
    let registered = 0;
    for (const entry of manifest) {
        const shape = {};
        // Include all path params (required) + first 30 query/body params
        const pathP = entry.params.filter((p) => p.source === "path");
        const otherP = entry.params.filter((p) => p.source !== "path");
        const selectedParams = [...pathP, ...otherP.slice(0, 30)];
        for (const param of selectedParams) {
            const safeName = param.name
                .replace(/\[/g, "__")
                .replace(/\]/g, "")
                .replace(/\./g, "_");
            // The manifest already collapses duplicates; this guard keeps a stray
            // collision from silently replacing an earlier param's schema.
            if (shape[safeName])
                continue;
            shape[safeName] = buildZodType({ ...param, name: safeName }, entry.module);
        }
        // Only advertise pagination where the endpoint actually returns a
        // collection. Offering page/per_page on a singleton GET made the schema
        // corroborate a "paginated array" claim that was never true.
        if (entry.method === "GET" && entry.returnsCollection) {
            if (!shape.page) {
                shape.page = z
                    .number()
                    .optional()
                    .describe("Page number for paginated results (default: 1, 1-indexed)");
            }
            if (!shape.per_page) {
                shape.per_page = z
                    .number()
                    .optional()
                    .describe("Number of items per page (default: 100, max: 100)");
            }
        }
        const description = buildDescription(entry);
        const annotations = buildAnnotations(entry.method, entry.toolName, entry.summary, entry.deprecated);
        try {
            server.registerTool(entry.toolName, {
                title: buildTitle(entry.summary, entry.deprecated),
                description,
                inputSchema: shape,
                annotations,
            }, createToolHandler(entry));
            registered++;
        }
        catch (err) {
            console.error(`Failed to register tool ${entry.toolName}: ${err.message}`);
        }
    }
    return registered;
}
