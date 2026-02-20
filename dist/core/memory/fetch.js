import fs from 'node:fs';
import { getEntryByCode } from './index.js';
export function fetchByCode(code) {
    const entry = getEntryByCode(code);
    if (!entry)
        return undefined;
    if (!fs.existsSync(entry.path)) {
        console.warn(`Integrity warning: file missing for ${code} at ${entry.path}`);
        return undefined;
    }
    const content = fs.readFileSync(entry.path, 'utf-8');
    return { entry, content };
}
