import { getMemoryMode, setMemoryMode } from './memory-mode.js';

export function setMemoryDisabled(disabled: boolean): void {
  setMemoryMode(disabled ? 'disabled' : 'enabled');
}

export function isMemoryDisabled(): boolean {
  return getMemoryMode() === 'disabled';
}
