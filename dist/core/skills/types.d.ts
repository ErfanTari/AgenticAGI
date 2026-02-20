import type { Intent } from '../types.js';
export interface Skill {
    name: string;
    description: string;
    intents: Intent[];
}
