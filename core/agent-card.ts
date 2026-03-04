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

export function getAgentCard(): AgentCard {
  const raw = fs.readFileSync(CARD_PATH, 'utf-8');
  return JSON.parse(raw) as AgentCard;
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
