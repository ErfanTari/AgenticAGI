export type MemoryMode = 'enabled' | 'disabled';

let _memoryMode: MemoryMode = 'enabled';

export function getMemoryMode(): MemoryMode { return _memoryMode; }
export function setMemoryMode(mode: MemoryMode): void { _memoryMode = mode; }
export function _resetMemoryMode(): void { _memoryMode = 'enabled'; }
