import { EventEmitter } from 'node:events';

export const CAPABILITY = Object.freeze({
  client_type: 'antigravity-cli',
  implementation_mode: 'managed_serial',
  certified_mode: 'unsupported',
  tested_cli_version: null,
  existing_tui_mode: 'unsupported',
  evidence: 'Synthetic stream protocol tests only; no installed Antigravity CLI was exercised.',
});

/** Fixed supported arguments, never a shell or permission-policy override. */
export function streamArguments({ model } = {}) {
  if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model))) {
    throw new Error('invalid_model: supply a documented model identifier; no process was started.');
  }
  return ['--input-format', 'stream-json', '--output-format', 'stream-json', ...(model ? ['--model', model] : [])];
}

export class LocalBoundaryError extends Error {
  constructor(code, { uncertain = false } = {}) {
    super(`${code}: automatic input is paused; inspect the local session before retrying.`);
    this.name = 'LocalBoundaryError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

/**
 * One adapter-owned process, one input writer. Never attach this class to a TUI,
 * reused transcript process, terminal, or shared stdin. Lifecycle belongs to the
 * caller that created the process. Stderr is deliberately not parsed as protocol
 * and never answered. A SUCCESS result establishes a turn boundary, not permission
 * success or proof that any requested tool/action executed.
 */
export class ManagedSession extends EventEmitter {
  #child; #state = 'starting'; #sessionId = null; #model = null;
  #decoder = new TextDecoder('utf-8', { fatal: true }); #buffer = ''; #pending = null;
  #draft = false; #humanHold = false; #manualPause = false; #turn = 0; #lease = null;

  constructor(child, { ownedProcess = false, maxFrameBytes = 1024 * 1024 } = {}) {
    super();
    if (!ownedProcess || !child?.stdin?.write || !child?.stdout?.on || !child?.on) {
      throw new Error('exclusive_process_required: create a dedicated piped CLI process; existing TUI attachment is unsupported.');
    }
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 8 * 1024 * 1024) {
      throw new Error('invalid_frame_limit: use a finite byte limit from 1024 through 8388608.');
    }
    this.#child = child;
    child.stdout.on('data', chunk => {
      if (this.#state === 'closed') return;
      try { this.#buffer += this.#decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true }); }
      catch { this.#fail('invalid_utf8'); return; }
      while (this.#buffer.includes('\n')) {
        const index = this.#buffer.indexOf('\n');
        const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) { this.#fail('frame_too_large'); return; }
        if (line.trim()) this.#parse(line);
      }
      if (Buffer.byteLength(this.#buffer) > maxFrameBytes) this.#fail('frame_too_large');
    });
    child.stdout.on('end', () => {
      try { if (this.#buffer.trim() || this.#decoder.decode()) this.#fail('incomplete_stream'); }
      catch { this.#fail('invalid_utf8'); }
      this.#fail('stream_closed');
    });
    child.stdin.on?.('error', () => this.#fail('input_stream_failed'));
    child.on('error', () => this.#fail('process_failed'));
    child.on('exit', () => this.#fail('process_exited'));
  }

  get nativeSessionId() { return this.#sessionId; }
  get model() { return this.#model ? { provider: null, id: this.#model, source: 'observed' } : { provider: null, id: null, source: 'unknown' }; }
  get state() { return this.#state; }
  get canAcceptAgentInput() { return this.#state === 'idle' && !this.#draft && !this.#humanHold && !this.#manualPause && !this.#lease; }

  /** Only local trusted UI/controller calls these; never expose them as agent tools. */
  setHumanDraft(present) { if (typeof present !== 'boolean') throw new TypeError('draft must be boolean'); this.#draft = present; }
  holdForHuman() { this.#humanHold = true; }
  releaseHumanHold() { this.#humanHold = false; }
  pauseAfterHumanAbort() { this.#manualPause = true; }
  resumeByOperator() { if (this.#state === 'closed') throw new LocalBoundaryError('closed_session'); this.#manualPause = false; }

  /** Hold the one writer across intent persistence, submission, and receipt persistence. */
  async withExclusiveInputLease(callback) {
    if (!this.canAcceptAgentInput) return callback({ safe: false });
    const token = Symbol('owned-input'); this.#lease = token;
    try { return await callback({ safe: true, token }); }
    finally { if (this.#lease === token) this.#lease = null; }
  }

  /** InputScheduler supplies the shared model-visible provenance, never raw body text. */
  submit({ model_input, lease }) {
    if (!lease?.safe || !this.#lease || lease.token !== this.#lease || this.#state !== 'idle' || this.#draft || this.#humanHold || this.#manualPause) {
      return { accepted: false, definitely_not_accepted: true };
    }
    return this.#submit(model_input);
  }

  /** Human input uses the same arbiter. It cannot interrupt a running turn. */
  submitHuman(text) {
    if (this.#state !== 'idle' || this.#humanHold || this.#lease) throw new LocalBoundaryError('unsafe_human_boundary');
    this.#draft = false; this.#manualPause = false;
    return this.#submit(text);
  }

  /** Graceful close only; no abort/kill/terminal-input mechanism. */
  close() { this.#manualPause = true; this.#fail('session_closed'); this.#child.stdin.end(); }

  #submit(text) {
    if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 128 * 1024) {
      throw new LocalBoundaryError('invalid_prompt');
    }
    // The reservation is synchronous, before any async write: there is no idle-check
    // to prompt-write race among callers using this one exclusive arbiter.
    this.#state = 'busy';
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      try {
        this.#child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n', error => {
          if (error) this.#fail('input_write_failed');
        });
      } catch { this.#fail('input_write_failed'); }
    });
  }

  #parse(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { this.#fail('invalid_stream_json'); return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { this.#fail('invalid_stream_frame'); return; }
    if (frame.event === 'init') {
      if (this.#state !== 'starting' || typeof frame.conversation_id !== 'string' || !frame.conversation_id || frame.conversation_id.length > 256 || !frame.conversation_id.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(frame.conversation_id) || !frame.init || frame.init.permission_mode !== 'request-review') {
        this.#fail('unexpected_init_or_permission_policy'); return;
      }
      this.#sessionId = frame.conversation_id;
      const model = frame.init.model;
      if (model !== undefined && (typeof model !== 'string' || !model || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(model))) { this.#fail('invalid_model_metadata'); return; }
      this.#model = model ?? null; this.#state = 'idle'; this.emit('ready'); return;
    }
    if (frame.event === 'step_update') {
      if (this.#state !== 'busy' || frame.step_update?.conversation_id !== this.#sessionId || !['ACTIVE', 'DONE'].includes(frame.step_update?.state)) this.#fail('unexpected_step');
      // Raw tool content is not interpreted, logged, or forwarded as status.
      return;
    }
    if (frame.event === 'result') {
      const result = frame.result;
      if (this.#state !== 'busy' || !this.#pending || result?.conversation_id !== this.#sessionId || !Number.isSafeInteger(result.num_turns) || result.num_turns <= this.#turn) { this.#fail('unexpected_result'); return; }
      if (result.status !== 'SUCCESS') { this.#fail('native_turn_failed'); return; }
      const pending = this.#pending; this.#pending = null; this.#turn = result.num_turns; this.#state = 'idle';
      pending.resolve({ accepted: true, receipt_id: `${this.#sessionId}:${this.#turn}`, action_success: 'unknown' });
      this.emit('response', { response: typeof result.response === 'string' ? result.response : '', action_success: 'unknown' });
      this.emit('settled'); return;
    }
    // Unknown output means we cannot infer safe scheduling under an unpinned CLI.
    this.#fail('unsupported_stream_event');
  }

  #fail(code) {
    if (this.#state === 'closed') return;
    const pending = this.#pending; this.#pending = null; this.#state = 'closed';
    pending?.reject(new LocalBoundaryError(code, { uncertain: true }));
    this.emit('unavailable', { code, uncertain: Boolean(pending) });
  }
}
