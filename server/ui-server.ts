import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { createServer, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import 'dotenv/config.js';

import { LLM_CONFIG, PLANNER_CONFIG, EXECUTOR_CONFIG } from '../config/agent.config.js';
import { processMessage, startAgent, stopAgent } from '../core/agent.js';
import { getFallbackLLMProfile, getPrimaryLLMProfile, getAnthropicCloudProfile, type LLMProfile, withLLMRuntime } from '../core/llm.js';
import { initDatabase } from '../core/memory/mod.js';
import { loadActivePlanEX, type PlanEXEntry } from '../core/memory/plan-ex.js';
import { loadWorkingMemory } from '../core/memory/working-memory.js';
import { memoryAgent } from '../core/memory/memory-agent.js';
import { transparency, type TransparencyEvent, type TransparencyEventEnvelope } from '../core/transparency.js';
import { setMemoryMode, getMemoryMode } from '../core/memory-mode.js';
import type { TaskMilestone, TaskPlan, TaskStep } from '../core/schemas.js';
import type { Message } from '../core/types.js';

type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'set_provider_mode'; mode: ProviderMode }
  | { type: 'set_local_model'; model: string }
  | { type: 'set_cloud_model'; model: string }
  | { type: 'set_memory_mode'; mode: 'enabled' | 'disabled' }
  | { type: 'ping' }
  | { type: 'refresh_models' }
  | { type: 'stop_chat' };

type ProviderMode = 'local' | 'cloud';
type CloudModelId = 'gemini' | 'claude' | 'gemma-4-26b' | 'gemma-4-31b';
type ProviderStatus = {
  mode: ProviderMode;
  primaryLabel: string;
  fallbackLabel?: string;
  availableModes: ProviderMode[];
  activeCloudModel?: CloudModelId;
  availableCloudModels?: CloudModelId[];
};

type NodeStatus = 'pending' | 'running' | 'done' | 'failed';

interface PlanStepSnapshot {
  id: string;
  description: string;
  skill: string;
  status: NodeStatus;
  elapsedMs?: number;
}

interface PlanMilestoneSnapshot {
  id: string;
  title: string;
  description: string;
  completionCriteria: string;
  status: NodeStatus;
  steps: PlanStepSnapshot[];
}

interface PlanSnapshot {
  goal: string;
  complexity: string;
  createdAt?: string;
  milestones: PlanMilestoneSnapshot[];
}

type ServerMessage =
  | { type: 'agent_reply'; text: string; intent?: string }
  | { type: 'transparency'; event: string; payload: unknown; ts: number }
  | { type: 'plan_update'; plan: PlanSnapshot }
  | { type: 'step_update'; stepId: string; status: 'running' | 'done' | 'failed'; elapsed?: number }
  | { type: 'milestone_update'; milestoneId: string; status: 'running' | 'done' | 'failed' }
  | { type: 'provider_status'; provider: ProviderStatus }
  | { type: 'memory_mode_status'; mode: 'enabled' | 'disabled' }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'models_refreshed'; localModelIds: string[]; envCount: number; lmStudioCount: number }
  | { type: 'models_refresh_error'; message: string }
  | { type: 'trace_tree'; requestId: string; root: TraceNode }
  | { type: 'span_event'; requestId: string; spanId: string; label: string; parentSpanId?: string; durationMs?: number; status?: string }
  | { type: 'stop_ack'; stopped: boolean; requestId?: string; reason?: string };

interface TraceNode {
  spanId: string;
  label: string;
  parentSpanId?: string;
  startedAt: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'aborted';
  children: TraceNode[];
}

class TraceBuilder {
  private nodes = new Map<string, TraceNode>();
  private rootId: string | undefined;

  ingest(event: TransparencyEventEnvelope): void {
    if (event.type === 'span_start') {
      const d = event.data as { spanId: string; parentSpanId?: string; label: string; ts: number };
      const node: TraceNode = {
        spanId: d.spanId,
        label: d.label,
        parentSpanId: d.parentSpanId,
        startedAt: d.ts,
        children: [],
      };
      this.nodes.set(d.spanId, node);
      if (!d.parentSpanId) this.rootId = d.spanId;
    } else if (event.type === 'span_end') {
      const d = event.data as { spanId: string; durationMs: number; status: 'ok' | 'error' | 'aborted' };
      const node = this.nodes.get(d.spanId);
      if (node) {
        node.durationMs = d.durationMs;
        node.status = d.status;
      }
    }
  }

  buildTree(): TraceNode | undefined {
    if (!this.rootId) return undefined;
    for (const node of this.nodes.values()) {
      if (node.parentSpanId) {
        const parent = this.nodes.get(node.parentSpanId);
        if (parent && !parent.children.find(c => c.spanId === node.spanId)) {
          parent.children.push(node);
        }
      }
    }
    return this.nodes.get(this.rootId);
  }

  reset(): void {
    this.nodes.clear();
    this.rootId = undefined;
  }
}


interface ClientConnection {
  socket: Duplex;
  history: Message[];
  processing: boolean;
  receiveBuffer: Buffer;
  providerMode: ProviderMode;
  traceBuilder: TraceBuilder;
  currentRequestId: string | undefined;
}

interface ParsedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  bytesConsumed: number;
}

interface UiServerState {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  projectRoot: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.env.UI_PROJECT_ROOT
  ? path.resolve(process.env.UI_PROJECT_ROOT)
  : path.resolve(__dirname, '..');
const UI_CONTROL_DIR = process.env.UI_CONTROL_DIR
  ? path.resolve(process.env.UI_CONTROL_DIR)
  : path.join(PROJECT_ROOT, '.ui-control');
const UI_STATE_PATH = path.join(UI_CONTROL_DIR, 'ui-server-state.json');
const INDEX_HTML_PATH = path.resolve(__dirname, '../public/index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
const UI_HOST = '127.0.0.1';
const configuredStartupPort = Number.parseInt(process.env.UI_START_PORT ?? '3009', 10);
const STARTUP_PORT = Number.isFinite(configuredStartupPort) && configuredStartupPort > 0
  ? configuredStartupPort
  : 3009;
const MAX_PORT = STARTUP_PORT + 9;
const STARTUP_ACTIVE_PLAN_WINDOW_MS = 5000;
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set<ClientConnection>();
const activeRequests = new Map<ClientConnection, { controller: AbortController }>();
const startupTime = Date.now();
let lastPlanSnapshot: PlanSnapshot | null = null;
const localPrimaryProfile = getPrimaryLLMProfile();
const geminiCloudProfile = getFallbackLLMProfile();
const anthropicCloudProfile = getAnthropicCloudProfile();

// Debug: log which profiles are available
console.log('[startup] Profiles loaded:');
console.log('  Local:', localPrimaryProfile?.model ?? 'NOT CONFIGURED');
console.log('  Gemini:', geminiCloudProfile?.model ?? 'NOT CONFIGURED');
console.log('  Anthropic:', anthropicCloudProfile?.model ?? 'NOT CONFIGURED');

// Track which cloud model is active per-server (shared across connections)
let activeCloudModel: CloudModelId = geminiCloudProfile ? 'gemini' : (anthropicCloudProfile ? 'claude' : 'gemini');

const GEMMA_MODEL_IDS: Record<'gemma-4-26b' | 'gemma-4-31b', string> = {
  'gemma-4-26b': 'gemma-4-26b-a4b-it',
  'gemma-4-31b': 'gemma-4-31b-it',
};

function getActiveCloudProfile(): LLMProfile | null {
  if (activeCloudModel === 'claude') return anthropicCloudProfile;
  if (activeCloudModel === 'gemma-4-26b' || activeCloudModel === 'gemma-4-31b') {
    if (!geminiCloudProfile) return null;
    return { ...geminiCloudProfile, model: GEMMA_MODEL_IDS[activeCloudModel] };
  }
  return geminiCloudProfile;
}

function getAvailableCloudModels(): CloudModelId[] {
  const models: CloudModelId[] = [];
  if (geminiCloudProfile) models.push('gemini', 'gemma-4-26b', 'gemma-4-31b');
  if (anthropicCloudProfile) models.push('claude');
  return models;
}

function cloneProfile(profile: LLMProfile | null, label: string): LLMProfile | null {
  if (!profile) return null;
  return { ...profile, label };
}

function getAvailableProviderModes(): ProviderMode[] {
  const modes: ProviderMode[] = [];
  if (localPrimaryProfile) modes.push('local');
  if (getActiveCloudProfile()) modes.push('cloud');
  return modes;
}

function getDefaultProviderMode(): ProviderMode {
  return localPrimaryProfile ? 'local' : 'cloud';
}

function getProviderRuntime(mode: ProviderMode) {
  const cloudProfile = getActiveCloudProfile();
  if (mode === 'cloud' && cloudProfile) {
    return {
      primary: cloneProfile(cloudProfile, 'cloud-primary'),
      fallback: cloneProfile(localPrimaryProfile, 'local-fallback'),
    };
  }

  return {
    primary: cloneProfile(localPrimaryProfile, 'local-primary'),
    fallback: cloneProfile(cloudProfile, 'cloud-fallback'),
  };
}

function describeProfile(profile: LLMProfile | null): string {
  if (!profile) return 'Unavailable';
  return `${profile.model}`;
}

function getProviderStatus(mode: ProviderMode): ProviderStatus {
  const runtime = getProviderRuntime(mode);
  return {
    mode,
    primaryLabel: describeProfile(runtime.primary),
    fallbackLabel: runtime.fallback ? describeProfile(runtime.fallback) : undefined,
    availableModes: getAvailableProviderModes(),
    activeCloudModel,
    availableCloudModels: getAvailableCloudModels(),
  };
}

function sendProviderStatus(connection: ClientConnection) {
  sendJson(connection, {
    type: 'provider_status',
    provider: getProviderStatus(connection.providerMode),
  });
}

function writeResponse(res: ServerResponse, statusCode: number, body: string, contentType: string) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function shouldAutoOpenBrowser(): boolean {
  return process.env.UI_AUTO_OPEN_BROWSER !== 'false';
}

function persistUiState(port: number) {
  const state: UiServerState = {
    pid: process.pid,
    port,
    url: `http://${UI_HOST}:${port}`,
    startedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
  };

  try {
    fs.mkdirSync(UI_CONTROL_DIR, { recursive: true });
    fs.writeFileSync(UI_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.warn('[ui] Failed to persist UI state:', error);
  }
}

function clearUiState() {
  try {
    const existing = JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf-8')) as Partial<UiServerState>;
    if (typeof existing.pid === 'number' && existing.pid !== process.pid) return;
  } catch (error) {
    const ioError = error as NodeJS.ErrnoException;
    if (ioError.code === 'ENOENT') return;
  }

  try {
    fs.rmSync(UI_STATE_PATH, { force: true });
  } catch (error) {
    console.warn('[ui] Failed to clear UI state:', error);
  }
}

function serveIndex(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeResponse(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'GET') res.end(INDEX_HTML);
    else res.end();
    return;
  }

  if (url.pathname === '/health') {
    writeResponse(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  writeResponse(res, 404, 'Not Found', 'text/plain; charset=utf-8');
}

function sendFrame(socket: Duplex, payload: Buffer | string, opcode = 0x1) {
  if (socket.destroyed) return;

  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  let header: Buffer;

  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }

  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, body]));
}

function sendJson(connection: ClientConnection, message: ServerMessage) {
  try {
    sendFrame(connection.socket, JSON.stringify(message));
  } catch {
    // Connection may be closing. Ignore UI transport errors.
  }
}

function readFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  let offset = 2;
  let payloadLength = secondByte & 0x7f;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error('Large websocket frames are not supported');
    payloadLength = low;
    offset += 8;
  }

  const masked = (secondByte & 0x80) !== 0;
  let mask: Buffer | null = null;

  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));

  if (masked && mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return {
    opcode: firstByte & 0x0f,
    fin: (firstByte & 0x80) !== 0,
    payload,
    bytesConsumed: offset + payloadLength,
  };
}

function getPlanMilestones(plan: TaskPlan): TaskMilestone[] {
  if (plan.milestones && plan.milestones.length > 0) return plan.milestones;
  return [{
    id: 'milestone_1',
    goalIds: (plan.goals ?? []).map(goal => goal.id),
    title: 'Complete task',
    description: plan.goal,
    completionCriteria: plan.steps.at(-1)?.description ?? plan.goal,
    steps: plan.steps,
  }];
}

function createStepSnapshot(step: TaskStep): PlanStepSnapshot {
  return {
    id: step.id,
    description: step.description,
    skill: step.skill,
    status: 'pending',
  };
}

function taskPlanToSnapshot(plan: TaskPlan): PlanSnapshot {
  return {
    goal: plan.goal,
    complexity: plan.complexity ?? 'LOW',
    createdAt: plan.createdAt,
    milestones: getPlanMilestones(plan).map(milestone => ({
      id: milestone.id,
      title: milestone.title,
      description: milestone.description,
      completionCriteria: milestone.completionCriteria,
      status: 'pending',
      steps: milestone.steps.map(createStepSnapshot),
    })),
  };
}

function planExToSnapshot(planEx: PlanEXEntry): PlanSnapshot {
  return {
    goal: planEx.goal || planEx.task_name,
    complexity: 'RESUME',
    createdAt: planEx.started,
    milestones: planEx.milestones.map((milestone, index) => {
      const completed = milestone.done || planEx.completed_milestone_ids?.includes(milestone.id) === true;
      const running = !completed && index === planEx.current_milestone;
      return {
        id: milestone.id,
        title: milestone.name,
        description: milestone.name,
        completionCriteria: planEx.next_action || milestone.name,
        status: completed ? 'done' : running ? 'running' : 'pending',
        steps: [],
      };
    }),
  };
}

function updateStepSnapshot(plan: PlanSnapshot | null, stepId: string, status: NodeStatus, elapsed?: number) {
  if (!plan) return;
  for (const milestone of plan.milestones) {
    const step = milestone.steps.find(item => item.id === stepId);
    if (!step) continue;
    step.status = status;
    if (typeof elapsed === 'number') step.elapsedMs = elapsed;
    return;
  }
}

function updateMilestoneSnapshot(plan: PlanSnapshot | null, milestoneId: string, status: NodeStatus) {
  if (!plan) return;
  const milestone = plan.milestones.find(item => item.id === milestoneId);
  if (milestone) milestone.status = status;
}

function handleTransparencyEvent(connection: ClientConnection, event: TransparencyEvent, envelope?: TransparencyEventEnvelope) {
  const ts = Date.now();
  sendJson(connection, {
    type: 'transparency',
    event: event.type,
    payload: event.data,
    ts,
  });

  // ── Trace v2: feed span events into TraceBuilder ──────────────────────────────
  if (event.type === 'span_start' || event.type === 'span_end') {
    const env = envelope ?? (event as TransparencyEventEnvelope);
    const requestId = env.requestId ?? connection.currentRequestId ?? 'unknown';

    if (event.type === 'span_start') {
      const d = event.data as { spanId: string; parentSpanId?: string; label: string; ts: number };
      if (!d.parentSpanId) {
        // Root span — reset builder for new request
        connection.traceBuilder.reset();
        connection.currentRequestId = requestId;
      }
      connection.traceBuilder.ingest(env);
      sendJson(connection, {
        type: 'span_event',
        requestId,
        spanId: d.spanId,
        label: d.label,
        parentSpanId: d.parentSpanId,
      });
    } else {
      connection.traceBuilder.ingest(env);
      const d = event.data as { spanId: string; durationMs: number; status: 'ok' | 'error' | 'aborted' };
      // Check if this ends the root span
      const tree = connection.traceBuilder.buildTree();
      if (tree && tree.spanId === d.spanId && tree.durationMs !== undefined) {
        sendJson(connection, {
          type: 'trace_tree',
          requestId: connection.currentRequestId ?? requestId,
          root: tree,
        });
      }
      sendJson(connection, {
        type: 'span_event',
        requestId,
        spanId: d.spanId,
        label: '',
        durationMs: d.durationMs,
        status: d.status,
      });
    }
    return;
  }

  if (event.type === 'plan') {
    lastPlanSnapshot = taskPlanToSnapshot(event.data);
    sendJson(connection, {
      type: 'plan_update',
      plan: lastPlanSnapshot,
    });
    return;
  }

  if (event.type === 'step_start') {
    updateStepSnapshot(lastPlanSnapshot, event.data.step.id, 'running');
    sendJson(connection, {
      type: 'step_update',
      stepId: event.data.step.id,
      status: 'running',
    });
    return;
  }

  if (event.type === 'step_result') {
    const status = event.data.result.success ? 'done' : 'failed';
    updateStepSnapshot(lastPlanSnapshot, event.data.step.id, status, event.data.ms);
    sendJson(connection, {
      type: 'step_update',
      stepId: event.data.step.id,
      status,
      elapsed: event.data.ms,
    });
    return;
  }

  if (event.type === 'milestone_start') {
    updateMilestoneSnapshot(lastPlanSnapshot, event.data.id, 'running');
    sendJson(connection, {
      type: 'milestone_update',
      milestoneId: event.data.id,
      status: 'running',
    });
    return;
  }

  if (event.type === 'milestone_result') {
    const status = event.data.success ? 'done' : 'failed';
    updateMilestoneSnapshot(lastPlanSnapshot, event.data.id, status);
    sendJson(connection, {
      type: 'milestone_update',
      milestoneId: event.data.id,
      status,
    });
    return;
  }

  // ── QueryLoop synthetic plan diagram ─────────────────────────────────────────

  if (event.type === 'query_loop_start') {
    lastPlanSnapshot = {
      goal: event.data.goal,
      complexity: 'LOW',
      createdAt: new Date().toISOString(),
      milestones: [{
        id: 'query_loop',
        title: 'QueryLoop',
        description: event.data.goal,
        completionCriteria: 'Complete when model emits plain-text response.',
        status: 'running',
        steps: [],
      }],
    };
    sendJson(connection, { type: 'plan_update', plan: lastPlanSnapshot });
    return;
  }

  if (event.type === 'query_loop_skill_call') {
    if (lastPlanSnapshot?.milestones[0]) {
      const stepId = 'ql_step_' + (lastPlanSnapshot.milestones[0].steps.length + 1);
      lastPlanSnapshot.milestones[0].steps.push({
        id: stepId,
        description: JSON.stringify(event.data.input).slice(0, 80),
        skill: event.data.skill,
        status: 'running',
      });
      sendJson(connection, { type: 'plan_update', plan: lastPlanSnapshot });
    }
    return;
  }

  if (event.type === 'query_loop_skill_result') {
    if (lastPlanSnapshot?.milestones[0]?.steps.length) {
      const steps = lastPlanSnapshot.milestones[0].steps;
      const lastStep = steps[steps.length - 1];
      lastStep.status = event.data.success ? 'done' : 'failed';
      sendJson(connection, {
        type: 'step_update',
        stepId: lastStep.id,
        status: lastStep.status,
      });
    }
    return;
  }

  if (event.type === 'query_loop_end') {
    if (lastPlanSnapshot?.milestones[0]) {
      const reason = event.data.reason;
      const status: NodeStatus = (reason === 'no_action' || reason === 'goal_complete') ? 'done' : 'failed';
      lastPlanSnapshot.milestones[0].status = status;
      sendJson(connection, {
        type: 'milestone_update',
        milestoneId: 'query_loop',
        status,
      });
    }
  }
}

async function handleRefreshModels(connection: ClientConnection) {
  const envModels = (process.env.LOCAL_MODELS ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);

  let lmStudioModels: string[] = [];
  const endpoint = LLM_CONFIG.endpoint;
  if (endpoint) {
    try {
      const baseUrl = new URL(endpoint).origin;
      const res = await fetch(`${baseUrl}/v1/models`);
      if (res.ok) {
        const data = await res.json() as { data?: { id: string }[] };
        lmStudioModels = (data.data ?? []).map(m => m.id).filter(Boolean);
      }
    } catch {
      // LM Studio not running or unreachable — just skip
    }
  }

  const combined = [...new Set([...envModels, ...lmStudioModels])];
  sendJson(connection, {
    type: 'models_refreshed',
    localModelIds: combined,
    envCount: envModels.length,
    lmStudioCount: lmStudioModels.length,
  });
  console.log(`[ui] Models refreshed: ${envModels.length} env, ${lmStudioModels.length} LM Studio`);
}

async function handleChat(connection: ClientConnection, text: string) {
  if (connection.processing) {
    sendJson(connection, {
      type: 'error',
      message: 'The agent is already processing a message.',
    });
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  connection.processing = true;
  const controller = new AbortController();
  activeRequests.set(connection, { controller });
  const unsubscribe = transparency.on(event => handleTransparencyEvent(connection, event, event as TransparencyEventEnvelope));

  try {
    const runtime = getProviderRuntime(connection.providerMode);
    if (!runtime.primary) {
      throw new Error('No configured primary model is available for the selected mode.');
    }

    const reply = await withLLMRuntime(runtime, async () =>
      processMessage(trimmed, connection.history, { signal: controller.signal }),
    );
    connection.history.push({ role: 'user', content: trimmed });
    connection.history.push({ role: 'assistant', content: reply.reply });
    if (connection.history.length > 12) connection.history.splice(0, 2);

    sendJson(connection, {
      type: 'agent_reply',
      text: reply.reply,
      intent: reply.intent,
    });
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === 'AbortError') {
      sendJson(connection, { type: 'agent_reply', text: '[stopped]', intent: 'aborted' });
    } else {
      sendJson(connection, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    unsubscribe();
    const current = activeRequests.get(connection);
    if (current?.controller === controller) activeRequests.delete(connection);
    connection.processing = false;
  }
}

function handleStopChat(connection: ClientConnection): void {
  const active = activeRequests.get(connection);
  if (!active) {
    sendJson(connection, { type: 'stop_ack', stopped: false, reason: 'no_active_request' });
    return;
  }
  active.controller.abort();
  sendJson(connection, { type: 'stop_ack', stopped: true });
}

function handleClientMessage(connection: ClientConnection, raw: string) {
  let parsed: ClientMessage;
  try {
    parsed = JSON.parse(raw) as ClientMessage;
  } catch {
    sendJson(connection, { type: 'error', message: 'Invalid client message.' });
    return;
  }

  if (parsed.type === 'ping') {
    sendJson(connection, { type: 'pong' });
    return;
  }

  if (parsed.type === 'set_provider_mode') {
    const availableModes = getAvailableProviderModes();
    if (!availableModes.includes(parsed.mode)) {
      sendJson(connection, { type: 'error', message: `Provider mode '${parsed.mode}' is not configured.` });
      return;
    }
    connection.providerMode = parsed.mode;
    sendProviderStatus(connection);
    return;
  }

  if (parsed.type === 'set_memory_mode') {
    const newMode = parsed.mode === 'disabled' ? 'disabled' : 'enabled';
    setMemoryMode(newMode);
    for (const c of clients) sendJson(c, { type: 'memory_mode_status', mode: newMode });
    console.log('[ui] Memory mode switched to:', newMode);
    return;
  }

  if (parsed.type === 'set_local_model') {
    const model = parsed.model.trim();
    if (!model) {
      sendJson(connection, { type: 'error', message: 'Model name cannot be empty.' });
      return;
    }
    // Mutate live configs — LM Studio loads the model on next API call
    LLM_CONFIG.model = model;
    PLANNER_CONFIG.model = model;
    EXECUTOR_CONFIG.model = model;
    // Update snapshot so provider_status reflects the new model name
    if (localPrimaryProfile) localPrimaryProfile.model = model;
    for (const c of clients) sendProviderStatus(c);
    console.log('[ui] Local model switched to:', model);
    return;
  }

  if (parsed.type === 'set_cloud_model') {
    const model = parsed.model as CloudModelId;
    const available = getAvailableCloudModels();
    if (!available.includes(model)) {
      sendJson(connection, { type: 'error', message: `Cloud model '${model}' is not configured.` });
      return;
    }
    activeCloudModel = model;
    for (const c of clients) sendProviderStatus(c);
    console.log('[ui] Cloud model switched to:', model);
    return;
  }

  if (parsed.type === 'refresh_models') {
    void handleRefreshModels(connection);
    return;
  }

  if (parsed.type === 'chat') {
    void handleChat(connection, parsed.text);
    return;
  }

  if (parsed.type === 'stop_chat') {
    handleStopChat(connection);
    return;
  }

  sendJson(connection, { type: 'error', message: 'Unsupported client message.' });
}

function bindSocket(connection: ClientConnection) {
  connection.socket.on('data', chunk => {
    connection.receiveBuffer = Buffer.concat([connection.receiveBuffer, chunk]);

    while (true) {
      let frame: ParsedFrame | null;
      try {
        frame = readFrame(connection.receiveBuffer);
      } catch (error) {
        sendJson(connection, {
          type: 'error',
          message: error instanceof Error ? error.message : 'WebSocket framing error.',
        });
        connection.socket.destroy();
        return;
      }

      if (!frame) return;
      connection.receiveBuffer = connection.receiveBuffer.subarray(frame.bytesConsumed);

      if (!frame.fin) {
        sendJson(connection, {
          type: 'error',
          message: 'Fragmented WebSocket messages are not supported.',
        });
        connection.socket.destroy();
        return;
      }

      if (frame.opcode === 0x8) {
        sendFrame(connection.socket, Buffer.alloc(0), 0x8);
        connection.socket.end();
        return;
      }

      if (frame.opcode === 0x9) {
        sendFrame(connection.socket, frame.payload, 0xA);
        continue;
      }

      if (frame.opcode === 0xA) continue;
      if (frame.opcode !== 0x1) continue;

      handleClientMessage(connection, frame.payload.toString('utf-8'));
    }
  });

  const cleanup = () => {
    clients.delete(connection);
    // Abort any in-flight request so it doesn't become a zombie
    const active = activeRequests.get(connection);
    if (active) {
      active.controller.abort();
      activeRequests.delete(connection);
    }
  };

  connection.socket.on('close', cleanup);
  connection.socket.on('end', cleanup);
  connection.socket.on('error', cleanup);
}

function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = createHash('sha1')
    .update(key + ACCEPT_GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey}\r\n`
    + '\r\n',
  );

  const connection: ClientConnection = {
    socket,
    history: [],
    processing: false,
    receiveBuffer: Buffer.alloc(0),
    providerMode: getDefaultProviderMode(),
    traceBuilder: new TraceBuilder(),
    currentRequestId: undefined,
  };

  clients.add(connection);
  bindSocket(connection);
  sendProviderStatus(connection);
  sendJson(connection, { type: 'memory_mode_status', mode: getMemoryMode() });

  // FIX-H2: Send resume notice if there is an active PLAN.EX + working memory
  (async () => {
    try {
      const activePlan = loadActivePlanEX();
      if (activePlan) {
        const wm = activePlan.project_code ? await loadWorkingMemory(activePlan.project_code) : null;
        const lastStep = wm?.stepLog.at(-1)?.summary ?? null;
        sendJson(connection, {
          type: 'agent_reply',
          text: `Resuming plan: "${activePlan.task_name}"${lastStep ? ` — last step: ${lastStep}` : ''}`,
          intent: 'resume_notice',
        });
      }
    } catch {
      // Resume notice is best-effort
    }
  })().catch(() => {});

  if (Date.now() - startupTime <= STARTUP_ACTIVE_PLAN_WINDOW_MS) {
    const activePlan = loadActivePlanEX();
    if (activePlan) {
      lastPlanSnapshot = planExToSnapshot(activePlan);
      sendJson(connection, {
        type: 'plan_update',
        plan: lastPlanSnapshot,
      });
    }
  } else if (lastPlanSnapshot) {
    sendJson(connection, {
      type: 'plan_update',
      plan: lastPlanSnapshot,
    });
  }

  if (head.length > 0) {
    connection.socket.emit('data', head);
  }
}

function tryOpenBrowser(url: string) {
  const command = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;

  exec(command, error => {
    if (error && process.env.DEBUG_UI === 'true') {
      console.warn('[ui] Failed to open browser automatically:', error.message);
    }
  });
}

function listenOnPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(serveIndex);

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      acceptWebSocket(req, socket, head);
    });

    server.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(error);
        return;
      }
      console.error('[ui] Server failed to start:', error);
      reject(error);
    });

    server.listen(port, UI_HOST, () => {
      const shutdown = () => {
        // FIX-H2: Drain memory agent queue before shutdown
        memoryAgent.drain().catch(() => {}).finally(() => {
          for (const client of clients) {
            try {
              sendFrame(client.socket, Buffer.alloc(0), 0x8);
              client.socket.destroy();
            } catch {
              // Best-effort shutdown.
            }
          }
          server.close(() => {
            clearUiState();
            stopAgent();
            process.exit(0);
          });
        });
      };

      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);

      resolve(port);
    });
  });
}

async function startUiServer() {
  initDatabase();
  transparency.enable();
  startAgent();
  clearUiState();

  try {
    const activePlan = loadActivePlanEX();
    if (activePlan) {
      const milestone = activePlan.milestones?.[activePlan.current_milestone];
      const milestoneName = milestone?.name ?? activePlan.next_action ?? 'pending milestone';
      lastPlanSnapshot = planExToSnapshot(activePlan);
      const statusLine = activePlan.status === 'paused'
        ? `Paused: ${activePlan.abort_reason ?? milestoneName}`
        : `In progress: ${milestoneName}`;
      console.log(`Active execution plan found: "${activePlan.task_name}"\n  ${statusLine}`);
    }
  } catch {
    // Advisory startup check only.
  }

  let currentPort = STARTUP_PORT;
  while (currentPort <= MAX_PORT) {
    try {
      const port = await listenOnPort(currentPort);
      const url = `http://${UI_HOST}:${port}`;
      persistUiState(port);
      console.log(`zaraban UI -> ${url}`);
      console.log(`default model mode -> ${getDefaultProviderMode()} primary (${LLM_CONFIG.model || 'unconfigured'})`);
      if (shouldAutoOpenBrowser()) {
        tryOpenBrowser(url);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      currentPort += 1;
    }
  }

  stopAgent();
  throw new Error(`No available ports in range ${STARTUP_PORT}-${MAX_PORT}`);
}

void startUiServer().catch(error => {
  console.error('[ui] Fatal startup error:', error);
  clearUiState();
  stopAgent();
  process.exit(1);
});
