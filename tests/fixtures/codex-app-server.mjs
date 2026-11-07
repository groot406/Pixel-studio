// In-process protocol fixture: no network, account access, or model generation.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const behavior = process.argv[2];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params: { threadId: 'test-thread', ...params } });
let instructions = '';
let threadModel;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') reply({});
  if (message.method === 'account/read') reply({ account: { type: behavior === 'apikey' ? 'apiKey' : 'chatgpt', planType: 'test' } });
  if (message.method === 'model/list') reply({ data: behavior === 'modern-models' ? [
    { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true },
    { model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra' },
    { model: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
    { model: 'internal-model', displayName: 'Internal', hidden: true },
  ] : [{ model: 'test-model', displayName: 'Test model', isDefault: true }] });
  if (message.method === 'thread/start') {
    instructions = message.params.baseInstructions;
    threadModel = message.params.model;
    reply({ thread: { id: 'test-thread' } });
  }
  if (message.method === 'turn/start') {
    reply({ turn: { id: 'test-turn' } });
    notify('turn/started', { turn: { id: 'test-turn' } });
    if (behavior === 'wait') return;
    if (behavior === 'tool') {
      send({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
      return;
    }
    const text = behavior === 'images' ? JSON.stringify(message.params.input.map(item=>item.type==='localImage'?{type:item.type,png:readFileSync(item.path).subarray(0,8).toString('hex')}:item)) : behavior === 'modern-models'
      ? JSON.stringify({ model: threadModel })
      : `${instructions}\n${message.params.input[0].text}`;
    notify('item/agentMessage/delta', { itemId: 'answer', delta: text });
    notify('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } });
    notify('turn/completed', { turn: { status: 'completed' } });
  }
});
