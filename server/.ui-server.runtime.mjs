import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { processMessage, startAgent, stopAgent } from '../core/agent.js';
import { initDatabase } from '../core/memory/mod.js';
import { loadActivePlanEX } from '../core/memory/plan-ex.js';
import { transparency } from '../core/transparency.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_HTML_PATH = path.resolve(__dirname, '../public/index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
const STARTUP_PORT = 3000;
const MAX_PORT = 3009;
const STARTUP_ACTIVE_PLAN_WINDOW_MS = 5000;
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();
const startupTime = Date.now();
let lastPlanSnapshot = null;
function writeResponse(res, statusCode, body, contentType) {
    res.writeHead(statusCode, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}
function serveIndex(req, res) {
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
        if (req.method === 'GET')
            res.end(INDEX_HTML);
        else
            res.end();
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
function sendFrame(socket, payload, opcode = 0x1) {
    if (socket.destroyed)
        return;
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
    let header;
    if (body.length < 126) {
        header = Buffer.alloc(2);
        header[1] = body.length;
    }
    else if (body.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(body.length, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(body.length, 6);
    }
    header[0] = 0x80 | opcode;
    socket.write(Buffer.concat([header, body]));
}
function sendJson(connection, message) {
    try {
        sendFrame(connection.socket, JSON.stringify(message));
    }
    catch {
        // Connection may be closing. Ignore UI transport errors.
    }
}
function readFrame(buffer) {
    if (buffer.length < 2)
        return null;
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    let offset = 2;
    let payloadLength = secondByte & 0x7f;
    if (payloadLength === 126) {
        if (buffer.length < offset + 2)
            return null;
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
    }
    else if (payloadLength === 127) {
        if (buffer.length < offset + 8)
            return null;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        if (high !== 0)
            throw new Error('Large websocket frames are not supported');
        payloadLength = low;
        offset += 8;
    }
    const masked = (secondByte & 0x80) !== 0;
    let mask = null;
    if (masked) {
        if (buffer.length < offset + 4)
            return null;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
    }
    if (buffer.length < offset + payloadLength)
        return null;
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
function getPlanMilestones(plan) {
    if (plan.milestones && plan.milestones.length > 0)
        return plan.milestones;
    return [{
            id: 'milestone_1',
            goalIds: (plan.goals ?? []).map(goal => goal.id),
            title: 'Complete task',
            description: plan.goal,
            completionCriteria: plan.steps.at(-1)?.description ?? plan.goal,
            steps: plan.steps,
        }];
}
function createStepSnapshot(step) {
    return {
        id: step.id,
        description: step.description,
        skill: step.skill,
        status: 'pending',
    };
}
function taskPlanToSnapshot(plan) {
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
function planExToSnapshot(planEx) {
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
function updateStepSnapshot(plan, stepId, status, elapsed) {
    if (!plan)
        return;
    for (const milestone of plan.milestones) {
        const step = milestone.steps.find(item => item.id === stepId);
        if (!step)
            continue;
        step.status = status;
        if (typeof elapsed === 'number')
            step.elapsedMs = elapsed;
        return;
    }
}
function updateMilestoneSnapshot(plan, milestoneId, status) {
    if (!plan)
        return;
    const milestone = plan.milestones.find(item => item.id === milestoneId);
    if (milestone)
        milestone.status = status;
}
function handleTransparencyEvent(connection, event) {
    const ts = Date.now();
    sendJson(connection, {
        type: 'transparency',
        event: event.type,
        payload: event.data,
        ts,
    });
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
    }
}
async function handleChat(connection, text) {
    if (connection.processing) {
        sendJson(connection, {
            type: 'error',
            message: 'The agent is already processing a message.',
        });
        return;
    }
    const trimmed = text.trim();
    if (!trimmed)
        return;
    connection.processing = true;
    const unsubscribe = transparency.on(event => handleTransparencyEvent(connection, event));
    try {
        const reply = await processMessage(trimmed, connection.history);
        connection.history.push({ role: 'user', content: trimmed });
        connection.history.push({ role: 'assistant', content: reply.reply });
        if (connection.history.length > 12)
            connection.history.splice(0, 2);
        sendJson(connection, {
            type: 'agent_reply',
            text: reply.reply,
            intent: reply.intent,
        });
    }
    catch (error) {
        sendJson(connection, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        unsubscribe();
        connection.processing = false;
    }
}
function handleClientMessage(connection, raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        sendJson(connection, { type: 'error', message: 'Invalid client message.' });
        return;
    }
    if (parsed.type === 'ping') {
        sendJson(connection, { type: 'pong' });
        return;
    }
    if (parsed.type === 'chat') {
        void handleChat(connection, parsed.text);
        return;
    }
    sendJson(connection, { type: 'error', message: 'Unsupported client message.' });
}
function bindSocket(connection) {
    connection.socket.on('data', chunk => {
        connection.receiveBuffer = Buffer.concat([connection.receiveBuffer, chunk]);
        while (true) {
            let frame;
            try {
                frame = readFrame(connection.receiveBuffer);
            }
            catch (error) {
                sendJson(connection, {
                    type: 'error',
                    message: error instanceof Error ? error.message : 'WebSocket framing error.',
                });
                connection.socket.destroy();
                return;
            }
            if (!frame)
                return;
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
            if (frame.opcode === 0xA)
                continue;
            if (frame.opcode !== 0x1)
                continue;
            handleClientMessage(connection, frame.payload.toString('utf-8'));
        }
    });
    const cleanup = () => {
        clients.delete(connection);
    };
    connection.socket.on('close', cleanup);
    connection.socket.on('end', cleanup);
    connection.socket.on('error', cleanup);
}
function acceptWebSocket(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }
    const acceptKey = createHash('sha1')
        .update(key + ACCEPT_GUID)
        .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${acceptKey}\r\n`
        + '\r\n');
    const connection = {
        socket,
        history: [],
        processing: false,
        receiveBuffer: Buffer.alloc(0),
    };
    clients.add(connection);
    bindSocket(connection);
    if (Date.now() - startupTime <= STARTUP_ACTIVE_PLAN_WINDOW_MS) {
        const activePlan = loadActivePlanEX();
        if (activePlan) {
            lastPlanSnapshot = planExToSnapshot(activePlan);
            sendJson(connection, {
                type: 'plan_update',
                plan: lastPlanSnapshot,
            });
        }
    }
    else if (lastPlanSnapshot) {
        sendJson(connection, {
            type: 'plan_update',
            plan: lastPlanSnapshot,
        });
    }
    if (head.length > 0) {
        connection.socket.emit('data', head);
    }
}
function tryOpenBrowser(url) {
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
function listenOnPort(port) {
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
            if (error.code === 'EADDRINUSE') {
                reject(error);
                return;
            }
            console.error('[ui] Server failed to start:', error);
            reject(error);
        });
        server.listen(port, '127.0.0.1', () => {
            const shutdown = () => {
                for (const client of clients) {
                    try {
                        sendFrame(client.socket, Buffer.alloc(0), 0x8);
                        client.socket.destroy();
                    }
                    catch {
                        // Best-effort shutdown.
                    }
                }
                server.close(() => {
                    stopAgent();
                    process.exit(0);
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
    try {
        const activePlan = loadActivePlanEX();
        if (activePlan) {
            const milestone = activePlan.milestones?.[activePlan.current_milestone];
            const milestoneName = milestone?.name ?? activePlan.next_action ?? 'pending milestone';
            lastPlanSnapshot = planExToSnapshot(activePlan);
            console.log(`Active execution plan found: "${activePlan.task_name}"\n  Next: ${milestoneName}`);
        }
    }
    catch {
        // Advisory startup check only.
    }
    let currentPort = STARTUP_PORT;
    while (currentPort <= MAX_PORT) {
        try {
            const port = await listenOnPort(currentPort);
            const url = `http://localhost:${port}`;
            console.log(`zaraban UI -> ${url}`);
            tryOpenBrowser(url);
            return;
        }
        catch (error) {
            if (error.code !== 'EADDRINUSE')
                throw error;
            currentPort += 1;
        }
    }
    stopAgent();
    throw new Error(`No available ports in range ${STARTUP_PORT}-${MAX_PORT}`);
}
void startUiServer().catch(error => {
    console.error('[ui] Fatal startup error:', error);
    stopAgent();
    process.exit(1);
});
