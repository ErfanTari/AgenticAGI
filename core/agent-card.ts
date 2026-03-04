import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllSkills } from './skills/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_PATH = path.join(__dirname, '..', 'agent-card.json');

export interface AgentCapabilities {
  memory: {
    notebooks: string[];
    relationships: boolean;
    versioned: boolean;
    hybrid_search: boolean;
  };
  skills: string[];
  planning: {
    max_steps: number;
    retry: boolean;
    verification: boolean;
    episodic_memory: boolean;
  };
}

export interface AgentCard {
  name: string;
  version: string;
  description: string;
  endpoint: string;
  protocol: string;
  capabilities: AgentCapabilities;
  identity: {
    local_first: boolean;
    model: string;
    owner: string;
  };
}

const DEFAULT_CARD: AgentCard = {
  name: 'AgenticAGI',
  version: '0.10.0',
  description: 'Local-first personal AI agent with structured memory system',
  endpoint: 'http://localhost:3000',
  protocol: 'a2a/1.0',
  capabilities: {
    memory: {
      notebooks: ['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN'],
      relationships: true,
      versioned: true,
      hybrid_search: true,
    },
    skills: [],
    planning: { max_steps: 8, retry: true, verification: true, episodic_memory: true },
  },
  identity: { local_first: true, model: 'configurable', owner: 'user' },
};

export function getAgentCard(): AgentCard {
  // BUG-8 fix: return default card if file is missing rather than throwing
  try {
    const raw = fs.readFileSync(CARD_PATH, 'utf-8');
    return JSON.parse(raw) as AgentCard;
  } catch {
    return { ...DEFAULT_CARD, capabilities: { ...DEFAULT_CARD.capabilities, skills: [] } };
  }
}

export function updateAgentCard(): void {
  try {
    const card = getAgentCard();
    const skills = getAllSkills().map(s => s.name);
    card.capabilities.skills = skills;
    fs.writeFileSync(CARD_PATH, JSON.stringify(card, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[agent-card] Failed to update agent card:', err);
  }
}
