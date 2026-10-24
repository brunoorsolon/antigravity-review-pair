import { ManagedSession } from './managed-session.mjs';

/** Shared durable-inbox transport plus this repository's native serial boundary. */
export function createAntigravityAdapter({ reference, child, client, inbox = client?.inbox,
  experimentalManaged = false, onDiagnostic = () => {} }) {
  if (!reference?.AdapterRuntime || !reference?.InputScheduler || !reference?.createTools || !inbox || inbox.identity?.client_type !== 'antigravity-cli' || typeof experimentalManaged !== 'boolean') throw new Error('invalid_adapter_configuration');
  const session = new ManagedSession(child, { ownedProcess: true });
  let registered = false, nativeId, stopped = false, stopPromise;
  const verify = () => !stopped && session.state !== 'closed' && Boolean(nativeId) && session.nativeSessionId === nativeId;
  const runtime = new reference.AdapterRuntime({ client, inbox, verifySession: verify, isAlive: verify, onDiagnostic });
  const scheduler = new reference.InputScheduler({ inbox,
    withExclusiveInputLease: callback => registered && experimentalManaged ? session.withExclusiveInputLease(callback) : callback({ safe: false }),
    submit: input => session.submit(input),
  });
  const stop = () => {
    stopped = true; registered = false;
    return stopPromise ??= runtime.stop({ closeSession: true });
  };
  session.once('unavailable', () => { void stop(); });
  const tools = reference.createTools({ client, inbox, observeMetadata: () => ({ model: session.model }) });
  return {
    session, runtime, scheduler, tools,
    async start(metadata) {
      if (registered || stopped || session.state !== 'idle') throw new Error('native_session_not_ready');
      nativeId = session.nativeSessionId;
      try {
        const result = await runtime.start({ ...metadata, model: session.model });
        if (!verify()) { await runtime.stop({ closeSession: true }); throw new Error('native_session_closed'); }
        registered = true; return result;
      } catch (error) { await stop(); throw error; }
    },
    async runNext() { return scheduler.runNext(); },
    async close() { session.close(); await stop(); },
  };
}
