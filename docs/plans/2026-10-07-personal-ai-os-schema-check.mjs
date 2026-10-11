// Contract checks for design DDL only. Uses two isolated in-memory databases.
// Does not start Core/Node or read the user's runtime data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const core = new DatabaseSync(':memory:');
const node = new DatabaseSync(':memory:');
for (const [db, suffix] of [[core, 'core'], [node, 'node']]) {
  db.exec(readFileSync(new URL(`2026-10-07-personal-ai-os-${suffix}-schema.sql`, import.meta.url), 'utf8'));
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
}

const h = (letter) => letter.repeat(64);
function insert(db, table, row) {
  const fields = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
}
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const envelope = (row) => JSON.stringify({
  v: 1, tool_name: row.tool_name, tool_version: row.tool_version,
  target_kind: row.target_kind, target_id: row.target_id, arguments: JSON.parse(row.arguments_json),
});
const add = (table, row) => {
  if (table === 'tool_calls') {
    const canonical = envelope(row);
    row = { ...row, canonical_envelope: canonical, argument_hash: digest(canonical) };
  }
  return insert(core, table, row);
};
const nadd = (table, row) => insert(node, table, row);
const scope = { workspace_id: 'ws', owner_user_id: 'u1' };
const conversation = { ...scope, conversation_id: 'conv', bot_id: 'bot' };
const task = {
  id: 'task', ...conversation, initiated_by_session_id: 'session', authorized_session_id: 'session',
  objective: 'Summarize a synthetic document', status: 'running', max_model_calls: 10,
  max_tool_calls: 10, token_budget: 10000, deadline_at: 100000, created_at: 1000,
};
const run = {
  id: 'run', task_id: 'task', ...conversation, runtime_session_id: 'runtime', run_no: 1,
  worker_instance_id: 'worker', model_connection_id: 'model', model_connection_version: 1,
  model_id: 'fixture-model', status: 'active', started_at: 1000,
};
const call = {
  id: 'call', task_id: 'task', run_id: 'run', ...conversation, runtime_session_id: 'runtime',
  assistant_entry_id: 'entry', provider_tool_call_id: 'sdk-call', tool_name: 'document.extract_text',
  tool_version: '1', target_kind: 'device', target_id: 'device', arguments_json: '{"path":"fixture.pdf"}',
  argument_hash: h('a'), status: 'executing', created_at: 1000,
};
call.canonical_envelope = envelope(call);
call.argument_hash = digest(call.canonical_envelope);
const deviceCall = {
  id: 'call', ...scope, bot_id: 'bot', device_id: 'device', grant_id: 'grant', local_grant_id: 'local',
  grant_version: 1, local_policy_version: 1, status: 'running', delivery_count: 1,
  lease_seq: 1, lease_issued_at: 1000, lease_expires_at: 31000, deadline_at: 100000, created_at: 1000,
};
const approval = {
  id: 'approval', tool_call_id: 'call', ...scope, argument_hash: call.argument_hash, bot_policy_version: 1,
  device_grant_id: 'grant', grant_version: 1, local_policy_version: 1,
  status: 'consumed', decided_by_session_id: 'session', decided_at: 1050, consumed_at: 1100,
  created_at: 1000, expires_at: 20000,
};

add('schema_migrations', { version: 1, checksum: 'fixture-only', applied_at: 1000 });
for (const id of ['u1', 'u2']) add('users', { id, display_name: id, status: 'active', created_at: 1000 });
add('workspaces', { id: 'ws', core_id: 'core', owner_user_id: 'u1', name: 'Fixture', status: 'active', created_at: 1000 });
for (const user_id of ['u1', 'u2']) add('memberships', { workspace_id: 'ws', user_id, status: 'active', created_at: 1000 });
const identity = { id: 'identity', user_id: 'u1', protocol: 'oidc', issuer: 'https://id.example.org', subject: 'subject', status: 'active', created_at: 1000 };
add('external_identities', identity);
add('user_sessions', { id: 'session', workspace_id: 'ws', user_id: 'u1', token_hash: h('b'), protocol: 'local', revocation_mode: 'local', created_at: 1000, expires_at: 100000 });
add('login_transactions', { id: 'login', provider_id: 'fixture', protocol: 'native-v1', client_binding_hash: h('b'), nonce_hash: h('c'), status: 'pending', created_at: 1000, expires_at: 10000 });
add('model_connections', { id: 'model', ...scope, display_name: 'Fixture', provider_id: 'fixture', endpoint: 'https://api.example.org', credential_ref: 'vault:fixture', default_model: 'fixture-model', status: 'active', created_at: 1000 });
add('bots', { id: 'bot', ...scope, name: 'Assistant', instructions: 'Fixture only', model_connection_id: 'model', status: 'active', created_at: 1000 });
add('bots', { id: 'bot2', ...scope, name: 'Second', instructions: 'Fixture only', status: 'active', created_at: 1000 });
add('conversations', { id: 'conv', ...scope, bot_id: 'bot', title: 'Fixture', status: 'open', created_at: 1000 });
add('bot_policies', { bot_id: 'bot', ...scope, policy_json: '{}', approval_mode: 'ask' });
add('runtime_sessions', { id: 'runtime', ...conversation, storage_key: 'runtime/fixture', sdk_version: 'fixture', format_version: '1', status: 'active', created_at: 1000 });
add('tasks', task);
add('task_runs', run);
add('model_invocations', { id: 'invocation', run_id: 'run', request_key: 'request', purpose: 'answer', status: 'succeeded', input_tokens: 10, output_tokens: 20, usage_known: 1, created_at: 1000, finished_at: 1100 });
add('artifacts', { id: 'artifact', ...scope, task_id: 'task', storage_key: 'artifacts/fixture', content_hash: h('d'), bytes: 123, media_type: 'text/plain', provenance_json: '{}', created_at: 1000 });
add('tool_calls', call);
add('devices', { id: 'device', ...scope, name: 'Fixture Node', platform: 'windows', protocol_version: '1.0', status: 'bound', capabilities_json: '[]', created_at: 1000 });
add('device_credentials', { id: 'credential', device_id: 'device', family_id: 'family', generation: 1, access_hash: h('e'), refresh_hash: h('f'), status: 'active', issued_at: 1000, access_expires_at: 10000, refresh_idle_expires_at: 20000, family_expires_at: 30000 });
add('device_enrollments', { id: 'enrollment', poll_secret_hash: h('1'), verification_code_hash: h('2'), registration_json: '{}', status: 'consumed', ...scope, approved_by_session_id: 'session', device_id: 'device', created_at: 1000, expires_at: 10000 });
add('device_local_grants', { device_id: 'device', local_grant_id: 'local', ...scope, policy_version: 1, scope_json: '{}', status: 'active', reported_at: 1000 });
const grant = { id: 'grant', ...scope, bot_id: 'bot', device_id: 'device', local_grant_id: 'local', local_policy_version: 1, scope_json: '{}', status: 'active', created_at: 1000, expires_at: 100000 };
add('device_grants', grant);
add('approvals', approval);
add('device_calls', deviceCall);
// A completed independent tool result exercises the recovery projection FKs.
add('tool_calls', { ...call, id: 'complete-call', provider_tool_call_id: 'complete-sdk', tool_name: 'memory.write', target_kind: 'memory', target_id: 'memory', arguments_json: '{"expected_version":0,"content":"fixture"}', status: 'succeeded', result_json: '{}', result_hash: h('3') });
add('runtime_deliveries', { runtime_session_id: 'runtime', tool_call_id: 'complete-call', ...scope, conversation_id: 'conv', result_hash: h('3'), status: 'pending', created_at: 1100 });
add('memory_documents', { id: 'memory', ...scope, scope: 'bot', bot_id: 'bot', title: 'Fixture', storage_key: 'memory/fixture/hash', content_hash: h('4'), source_json: '{}', status: 'active', created_at: 1000, updated_at: 1000 });
const memoryReceipt = { tool_call_id: 'complete-call', ...scope, bot_id: 'bot', memory_document_id: 'memory', expected_version: 0, committed_version: 1, content_hash: h('4'), storage_key: 'memory/fixture/hash', result_hash: h('3'), committed_at: 1100 };
add('memory_write_receipts', memoryReceipt);
const input = { id: 'input', ...conversation, task_id: 'task', sender_session_id: 'session', client_message_id: 'client-message', input_seq: 1, input_kind: 'start', content_json: '{"text":"Fixture"}', request_hash: h('6'), status: 'accepted', created_at: 1000 };
add('conversation_inputs', input);
core.exec("UPDATE conversations SET next_input_seq=2 WHERE id='conv'");
add('runtime_input_deliveries', { input_id: 'input', ...conversation, runtime_session_id: 'runtime', channel: 'prompt', status: 'pending', created_at: 1100 });
const reconciliation = { id: 'reconciliation', tool_call_id: 'call', ...scope, argument_hash: call.argument_hash, decision_key: 'review-1', expected_call_version: 1, source: 'owner_attestation', outcome: 'inconclusive', evidence_json: '{"note":"Device remains offline"}', reviewed_by_session_id: 'session', created_at: 1200 };
add('call_reconciliations', reconciliation);
add('command_receipts', { workspace_id: 'ws', actor_user_id: 'u1', command_type: 'StartTask', idempotency_key: 'key', request_hash: h('5'), result_json: '{"task_id":"task"}', created_at: 1000 });
add('outbox_events', { id: 'event', workspace_id: 'ws', event_type: 'ToolResultAccepted', aggregate_id: 'complete-call', aggregate_version: 1, payload_json: '{}', status: 'pending', available_at: 1100, created_at: 1100 });
add('audit_records', { id: 'audit', workspace_id: 'ws', actor_user_id: 'u1', action: 'ApproveTool', entity_type: 'ToolCall', entity_id: 'call', details_json: '{}', created_at: 1000 });

nadd('node_bindings', { id: 'binding', core_id: 'core', device_id: 'device', owner_user_id: 'u1', core_origin: 'https://core.example.org', credential_ref: 'os:fixture', status: 'active', created_at: 1000 });
nadd('local_grants', { binding_id: 'binding', id: 'local', policy_version: 1, scope_json: '{}', root_mapping_ref: 'roots:fixture', status: 'active', updated_at: 1000 });
const nodeCall = { binding_id: 'binding', call_id: 'call', local_grant_id: 'local', local_policy_version: 1, capability: 'document.extract_text', arguments_json: call.arguments_json, canonical_envelope: call.canonical_envelope, argument_hash: call.argument_hash, status: 'running', lease_seq: 1, lease_expires_at: 31000, deadline_at: 100000, received_at: 1000 };
nadd('node_calls', nodeCall);

let checks = 0;
function check(db, name, fn) {
  db.exec('SAVEPOINT fixture_case');
  try { fn(); checks++; console.log(`ok ${checks} - ${name}`); }
  finally { db.exec('ROLLBACK TO fixture_case; RELEASE fixture_case'); }
}
function rejects(db, name, fn, pattern = /constraint|immutable|append-only/i) {
  check(db, name, () => assert.throws(fn, pattern));
}

rejects(core, 'one workspace per Core', () => add('workspaces', { id: 'ws2', core_id: 'core2', owner_user_id: 'u2', name: 'Other', status: 'active', created_at: 1000 }));
rejects(core, 'external identity cannot bind another user', () => add('external_identities', { ...identity, id: 'identity2', user_id: 'u2' }));
rejects(core, 'external identity owner is immutable', () => core.exec("UPDATE external_identities SET user_id='u2' WHERE id='identity'"));
const oidcLogin = { id: 'oidc-login', provider_id: 'fixture', protocol: 'oidc', client_binding_hash: h('b'), nonce_hash: h('d'), state_hash: h('e'), secret_ref: 'vault:verifier', status: 'pending', created_at: 1000, expires_at: 10000 };
for (const status of ['consumed', 'denied', 'expired']) {
  check(core, `OIDC ${status} releases verifier in the same transaction`, () => {
    add('login_transactions', oidcLogin);
    core.prepare('UPDATE login_transactions SET status=?, consumed_at=?, secret_ref=NULL WHERE id=?')
      .run(status, status === 'consumed' ? 1200 : null, oidcLogin.id);
    assert.equal(core.prepare('SELECT secret_ref FROM login_transactions WHERE id=?').get(oidcLogin.id).secret_ref, null);
  });
}
rejects(core, 'pending OIDC still requires a verifier', () => add('login_transactions', { ...oidcLogin, secret_ref: null }));
rejects(core, 'completed login must not retain a verifier reference', () => add('login_transactions', { ...oidcLogin, status: 'expired' }));
rejects(core, 'session protocol must match external identity', () => add('user_sessions', {
  id: 'mismatched-session', workspace_id: 'ws', user_id: 'u1', token_hash: h('9'),
  protocol: 'native-v1', external_identity_id: 'identity', upstream_session_ref: 'vault:fixture',
  revocation_mode: 'native_status', created_at: 1000, expires_at: 10000,
}));
check(core, 'protocol namespace distinguishes identities', () => add('external_identities', { ...identity, id: 'native', protocol: 'native-v1' }));
check(core, 'revoked identity retains unique key', () => {
  core.exec("UPDATE external_identities SET status='revoked', revoked_at=1200 WHERE id='identity'");
  assert.throws(() => add('external_identities', { ...identity, id: 'replacement', user_id: 'u2' }), /UNIQUE constraint/);
});
rejects(core, 'cross owner Bot reference rejected', () => add('conversations', { id: 'bad-conv', workspace_id: 'ws', owner_user_id: 'u2', bot_id: 'bot', title: 'Invalid', status: 'open', created_at: 1000 }));
rejects(core, 'missing workspace rejected', () => add('memberships', { workspace_id: 'absent', user_id: 'u1', status: 'active', created_at: 1000 }));
rejects(core, 'one unfinished Task per Conversation', () => add('tasks', { ...task, id: 'task2' }));
check(core, 'terminal Task releases slot at schema level', () => {
  // Domain guards must additionally ensure all external work has settled.
  core.exec("UPDATE tasks SET status='cancelled', ended_at=1200 WHERE id='task'");
  add('tasks', { ...task, id: 'task2', status: 'queued' });
});
rejects(core, 'terminal Task requires completion timestamp', () => core.exec("UPDATE tasks SET status='succeeded' WHERE id='task'"));
rejects(core, 'one active Run per Conversation', () => add('task_runs', { ...run, id: 'run2', run_no: 2 }));
check(core, 'interrupted Run releases execution slot', () => {
  core.exec("UPDATE task_runs SET status='interrupted', ended_at=1200 WHERE id='run'");
  add('task_runs', { ...run, id: 'run2', run_no: 2 });
});
rejects(core, 'one active runtime binding', () => add('runtime_sessions', { id: 'runtime2', ...conversation, storage_key: 'runtime/other', sdk_version: 'fixture', format_version: '1', status: 'active', created_at: 1000 }));
rejects(core, 'replayed SDK tool source is unique', () => add('tool_calls', { ...call, id: 'replay' }));
rejects(core, 'tool parameters cannot mutate after creation', () => core.exec("UPDATE tool_calls SET arguments_json='{}' WHERE id='call'"));
rejects(core, 'invalid state rejected', () => core.exec("UPDATE tasks SET status='invented' WHERE id='task'"));
rejects(core, 'approval cannot reference another argument digest', () => add('approvals', { ...approval, id: 'bad-approval', argument_hash: h('9') }));
check(core, 'only one live approval per call', () => {
  const pending = { ...approval, id: 'pending', status: 'pending', decided_by_session_id: null, decided_at: null, consumed_at: null };
  add('approvals', pending);
  assert.throws(() => add('approvals', { ...pending, id: 'pending2' }), /UNIQUE constraint/);
});
rejects(core, 'consumption requires a decision', () => add('approvals', { ...approval, id: 'bad-consume', decided_by_session_id: null }));
check(core, 'compare and swap consumes only once', () => {
  const pending = { ...approval, id: 'approved', status: 'approved', consumed_at: null };
  add('approvals', pending);
  const consume = core.prepare("UPDATE approvals SET status='consumed', consumed_at=1200, version=version+1 WHERE id='approved' AND version=1 AND status='approved'");
  assert.equal(consume.run().changes, 1);
  assert.equal(consume.run().changes, 0);
});
rejects(core, 'duplicate DeviceCall is not another execution', () => add('device_calls', deviceCall));
rejects(core, 'device lease cannot exceed 30 seconds', () => core.exec("UPDATE device_calls SET lease_expires_at=31001 WHERE id='call'"));
check(core, 'unknown device execution occupies slot until reconciled', () => {
  core.exec("UPDATE device_calls SET status='unknown' WHERE id='call'");
  add('tool_calls', { ...call, id: 'call2', provider_tool_call_id: 'sdk2' });
  assert.throws(() => add('device_calls', { ...deviceCall, id: 'call2' }), /UNIQUE constraint/);
  core.exec("UPDATE device_calls SET status='succeeded', result_json='{}', result_hash='" + h('7') + "', received_at=1200 WHERE id='call'");
  add('device_calls', { ...deviceCall, id: 'call2' });
});
check(core, 'grant for another Bot cannot authorize this call', () => {
  add('device_grants', { ...grant, id: 'grant2', bot_id: 'bot2' });
  add('tool_calls', { ...call, id: 'call2', provider_tool_call_id: 'sdk2' });
  assert.throws(() => add('device_calls', { ...deviceCall, id: 'call2', grant_id: 'grant2', status: 'queued' }), /FOREIGN KEY constraint/);
});
rejects(core, 'result projection is unique', () => add('runtime_deliveries', { runtime_session_id: 'runtime', tool_call_id: 'complete-call', ...scope, conversation_id: 'conv', result_hash: h('3'), status: 'pending', created_at: 1200 }));
rejects(core, 'workspace memory cannot retain a private Bot binding', () => core.exec("UPDATE memory_documents SET scope='workspace' WHERE id='memory'"));
rejects(core, 'known model usage cannot omit tokens', () => add('model_invocations', { id: 'bad-usage', run_id: 'run', request_key: 'request2', purpose: 'answer', status: 'succeeded', usage_known: 1, created_at: 1200 }));
rejects(core, 'JSON syntax validated', () => core.exec("UPDATE bot_policies SET policy_json='not json' WHERE bot_id='bot'"));
rejects(core, 'idempotency key not reused', () => add('command_receipts', { workspace_id: 'ws', actor_user_id: 'u1', command_type: 'StartTask', idempotency_key: 'key', request_hash: h('8'), result_json: '{}', created_at: 1200 }));
rejects(core, 'audit entries cannot be rewritten', () => core.exec("UPDATE audit_records SET action='Other' WHERE id='audit'"));
rejects(core, 'referenced Bot cannot be hard deleted', () => core.exec("DELETE FROM bots WHERE id='bot'"));
rejects(core, 'waiting Run needs a persisted release deadline', () => core.exec("UPDATE task_runs SET status='waiting' WHERE id='run'"));
check(core, '60 second worker release deadline can be stored', () => core.exec("UPDATE task_runs SET status='waiting', wait_started_at=1000, release_after_at=61000 WHERE id='run'"));
rejects(core, 'internal model request requires a classified detail', () => add('model_invocations', { id: 'internal', run_id: 'run', request_key: 'internal-request', purpose: 'runtime_internal', status: 'prepared', created_at: 1200 }));
check(core, 'classified internal model request is recorded', () => add('model_invocations', { id: 'internal', run_id: 'run', request_key: 'internal-request', purpose: 'runtime_internal', purpose_detail: 'fixture-known-operation', status: 'prepared', created_at: 1200 }));
rejects(core, 'client message retry cannot create a second input', () => add('conversation_inputs', { ...input, id: 'input2', input_seq: 2 }));
rejects(core, 'conversation input sequence is unique', () => add('conversation_inputs', { ...input, id: 'input2', client_message_id: 'new-client-message' }));
rejects(core, 'accepted message content cannot mutate', () => core.exec("UPDATE conversation_inputs SET content_json='{}' WHERE id='input'"));
rejects(core, 'input must retain task owner', () => add('conversation_inputs', { ...input, id: 'input2', owner_user_id: 'u2', client_message_id: 'new-client-message', input_seq: 2 }));
rejects(core, 'input delivery requires a source message', () => add('runtime_input_deliveries', { input_id: 'missing', ...conversation, runtime_session_id: 'runtime', channel: 'steer', status: 'pending', created_at: 1100 }));
rejects(core, 'consumed input requires runtime persistence evidence', () => core.exec("UPDATE runtime_input_deliveries SET status='consumed', consumed_at=1200 WHERE input_id='input'"));
check(core, 'applied input is distinct from consumed input', () => {
  core.exec("UPDATE runtime_input_deliveries SET status='applied', runtime_entry_id='user-entry', applied_at=1100 WHERE input_id='input'");
  assert.equal(core.prepare("SELECT consumed_at FROM runtime_input_deliveries WHERE input_id='input'").get().consumed_at, null);
  core.exec("UPDATE runtime_input_deliveries SET status='consumed', consumed_at=1200 WHERE input_id='input'");
});
rejects(core, 'memory write call commits once', () => add('memory_write_receipts', memoryReceipt));
rejects(core, 'memory write receipt cannot be rewritten', () => core.exec("UPDATE memory_write_receipts SET committed_version=2 WHERE tool_call_id='complete-call'"));
check(core, 'memory pointer and write receipt can roll back atomically', () => {
  core.exec('SAVEPOINT memory_write');
  core.exec("UPDATE memory_documents SET version=2, storage_key='memory/new' WHERE id='memory' AND version=1");
  assert.throws(() => add('memory_write_receipts', memoryReceipt), /UNIQUE constraint/);
  core.exec('ROLLBACK TO memory_write; RELEASE memory_write');
  assert.equal(core.prepare("SELECT version FROM memory_documents WHERE id='memory'").get().version, 1);
});
rejects(core, 'manual reconciliation requires an authenticated reviewer', () => add('call_reconciliations', { ...reconciliation, id: 'review2', decision_key: 'review-2', reviewed_by_session_id: null }));
rejects(core, 'reconciliation command is idempotently keyed', () => add('call_reconciliations', { ...reconciliation, id: 'review2' }));
rejects(core, 'reconciliation cannot substitute argument identity', () => add('call_reconciliations', { ...reconciliation, id: 'review2', decision_key: 'review-2', argument_hash: h('9') }));
rejects(core, 'reconciliation evidence cannot be rewritten', () => core.exec("UPDATE call_reconciliations SET outcome='confirmed_succeeded' WHERE id='reconciliation'"));
rejects(core, 'Core envelope is immutable', () => core.exec("UPDATE tool_calls SET canonical_envelope='{}' WHERE id='call'"));

rejects(node, 'one active Node binding', () => nadd('node_bindings', { id: 'binding2', core_id: 'core2', device_id: 'device2', owner_user_id: 'u1', core_origin: 'https://other.example.org', status: 'active', created_at: 1000 }));
rejects(node, 'duplicate Node call cannot be inserted', () => nadd('node_calls', nodeCall));
rejects(node, 'Node call argument hash immutable', () => node.prepare("UPDATE node_calls SET argument_hash=? WHERE call_id='call'").run(h('9')));
rejects(node, 'Node local grant must exist', () => nadd('node_calls', { ...nodeCall, call_id: 'bad-call', local_grant_id: 'missing', status: 'cancelled', finished_at: 1200 }));
check(node, 'Node unknown blocks a second execution', () => {
  node.exec("UPDATE node_calls SET status='unknown' WHERE call_id='call'");
  assert.throws(() => nadd('node_calls', { ...nodeCall, call_id: 'call2' }), /UNIQUE constraint/);
});
rejects(node, 'Node success requires persistent result evidence', () => node.exec("UPDATE node_calls SET status='succeeded', finished_at=1200 WHERE call_id='call'"));
rejects(node, 'Node uses received rather than delivered state', () => node.exec("UPDATE node_calls SET status='delivered' WHERE call_id='call'"));
rejects(node, 'Node original envelope cannot be rewritten', () => node.exec("UPDATE node_calls SET canonical_envelope='{}' WHERE call_id='call'"));
check(node, 'original UTF-8 envelope survives storage with matching digest', () => {
  const raw = JSON.stringify({ v: 1, tool_name: 'document.extract_text', tool_version: '1', target_kind: 'device', target_id: 'device', arguments: { path: '论文.pdf', pages: [1, 2] } }, null, 2);
  nadd('node_calls', { ...nodeCall, call_id: 'unicode-call', canonical_envelope: raw, arguments_json: JSON.stringify(JSON.parse(raw).arguments), argument_hash: digest(raw), status: 'cancelled', finished_at: 1200 });
  const persisted = node.prepare("SELECT canonical_envelope, argument_hash FROM node_calls WHERE call_id='unicode-call'").get();
  assert.equal(persisted.canonical_envelope, raw);
  assert.equal(digest(persisted.canonical_envelope), persisted.argument_hash);
  assert.notEqual(digest(JSON.stringify(JSON.parse(persisted.canonical_envelope))), persisted.argument_hash);
});

for (const [db, name] of [[core, 'Core'], [node, 'Node']]) {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(`${name}: foreign keys and integrity ok`);
  db.close();
}
console.log(`${checks} design contract checks passed. Domain/SDK/network behavior is not exercised.`);
