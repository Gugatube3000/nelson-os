export function buildVersionSiblingNote(entry) {
    const siblings = entry.versionSiblings;
    if (!siblings || siblings.length === 0)
        return "";
    const others = siblings
        .map((s) => `${s.toolName} (${s.version})`)
        .join(", ");
    return `Procore also exposes this operation as ${others}; prefer the highest API version unless a caller specifically needs an older one's shape.`;
}
