/**
 * UI stop button logic tests.
 * Tests the state machine for send/stop/stopping transitions
 * without requiring a browser environment.
 */
import { describe, it, expect } from 'vitest';

// Mirror the state machine from index.html as pure functions for testability.

interface UIState {
  connected: boolean;
  processing: boolean;
  stopping: boolean;
  inputValue: string;
}

interface ButtonState {
  text: string;
  disabled: boolean;
  mode: 'send' | 'stop';
  className: string;
  inputDisabled: boolean;
}

function syncComposer(state: UIState): ButtonState {
  if (state.stopping) {
    return {
      text: 'Stopping…',
      disabled: true,
      mode: 'stop',
      className: 'btn btn-stop',
      inputDisabled: true,
    };
  }
  if (state.processing) {
    return {
      text: '■ Stop',
      disabled: false,
      mode: 'stop',
      className: 'btn btn-stop',
      inputDisabled: true,
    };
  }
  return {
    text: 'Send',
    disabled: !state.connected || !state.inputValue.trim(),
    mode: 'send',
    className: 'btn btn-primary',
    inputDisabled: !state.connected,
  };
}

/** Returns messages that would be sent over the WS */
function handleSubmit(state: UIState): { type: string } | null {
  if (state.stopping) return null;
  if (state.processing) {
    return { type: 'stop_chat' };
  }
  if (!state.connected || !state.inputValue.trim()) return null;
  return { type: 'chat' };
}

function handleStopAck(state: UIState, payload: { stopped: boolean }): UIState {
  if (!payload.stopped) {
    return { ...state, stopping: false };
  }
  // stopped=true: stay in stopping until agent_reply
  return state;
}

function handleAgentReply(state: UIState): UIState {
  return { ...state, processing: false, stopping: false };
}

describe('UI stop button state machine', () => {
  it('idle state: button shows Send', () => {
    const btn = syncComposer({ connected: true, processing: false, stopping: false, inputValue: 'hello' });
    expect(btn.text).toBe('Send');
    expect(btn.mode).toBe('send');
    expect(btn.className).toContain('btn-primary');
    expect(btn.disabled).toBe(false);
  });

  it('processing state: button shows ■ Stop with btn-stop class', () => {
    const btn = syncComposer({ connected: true, processing: true, stopping: false, inputValue: '' });
    expect(btn.text).toBe('■ Stop');
    expect(btn.mode).toBe('stop');
    expect(btn.className).toContain('btn-stop');
    expect(btn.disabled).toBe(false);
    expect(btn.inputDisabled).toBe(true);
  });

  it('stopping state: button shows Stopping… and is disabled', () => {
    const btn = syncComposer({ connected: true, processing: true, stopping: true, inputValue: '' });
    expect(btn.text).toBe('Stopping…');
    expect(btn.disabled).toBe(true);
  });

  it('clicking stop button sends stop_chat', () => {
    const state: UIState = { connected: true, processing: true, stopping: false, inputValue: '' };
    const msg = handleSubmit(state);
    expect(msg).toEqual({ type: 'stop_chat' });
  });

  it('stop_ack { stopped: true } keeps Stopping… state until agent_reply arrives', () => {
    let state: UIState = { connected: true, processing: true, stopping: true, inputValue: '' };
    state = handleStopAck(state, { stopped: true });
    expect(state.stopping).toBe(true);
    // still stopping until agent_reply
    const btn = syncComposer(state);
    expect(btn.text).toBe('Stopping…');

    state = handleAgentReply(state);
    const btn2 = syncComposer(state);
    expect(btn2.text).toBe('Send');
  });

  it('agent_reply with intent=aborted returns button to Send', () => {
    const state = handleAgentReply({
      connected: true,
      processing: true,
      stopping: true,
      inputValue: '',
    });
    expect(state.processing).toBe(false);
    expect(state.stopping).toBe(false);
    const btn = syncComposer(state);
    expect(btn.text).toBe('Send');
  });

  it('stop_ack { stopped: false } clears stopping state immediately', () => {
    let state: UIState = { connected: true, processing: true, stopping: true, inputValue: '' };
    state = handleStopAck(state, { stopped: false });
    expect(state.stopping).toBe(false);
    // processing stays true since nothing actually stopped
    const btn = syncComposer(state);
    expect(btn.text).toBe('■ Stop');
  });
});
