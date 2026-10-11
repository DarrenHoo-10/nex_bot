// Fixture ledger only: the product must persist this identity in its Core transaction.
export interface ToolSource {
  runtimeSessionId: string;
  assistantEntryId: string;
  providerToolCallId: string;
}

export interface BrokerReceipt {
  callId: string;
  argumentsJson: string;
}

export interface BrokerState {
  count: number;
  calls: Record<string, BrokerReceipt>;
  executes: number;
}

export function sourceKey(source: ToolSource): string {
  return JSON.stringify([source.runtimeSessionId, source.assistantEntryId, source.providerToolCallId]);
}

export function recordBrokerCall(state: BrokerState, source: ToolSource, params: { label: string }): { callId: string; deduped: boolean } {
  const key = sourceKey(source);
  const argumentsJson = JSON.stringify({ label: params.label });
  const existing = state.calls[key];
  if (existing) {
    if (existing.argumentsJson !== argumentsJson) throw new Error("tool source reused with different arguments");
    return { callId: existing.callId, deduped: true };
  }
  const callId = `core-call-${++state.count}`;
  state.calls[key] = { callId, argumentsJson };
  return { callId, deduped: false };
}
