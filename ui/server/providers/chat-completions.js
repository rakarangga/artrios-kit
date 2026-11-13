// Transport for OpenAI-compatible endpoints. One wire format behind one interface: the agent loop never sees wire
// details, and another format (Anthropic Messages, Codex Responses) is added as another object with these same four functions.
// History is kept in OpenAI message format.
export const chatCompletions = {
  path: '/chat/completions',

  convertMessages: (messages) => messages,

  convertTools: (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),

  buildKwargs: ({ model, messages, tools }) => ({ model, messages, ...(tools.length ? { tools } : {}) }),

  // -> { text, toolCalls: [{ id, name, args, argsError }], finishReason, usage }
  normalizeResponse(json) {
    const choice = json?.choices?.[0];
    if (!choice) throw new Error(json?.error?.message ?? 'the provider returned no choices');
    const msg = choice.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((c, i) => {
      const raw = c.function?.arguments ?? '{}';
      let args = {};
      let argsError = null;
      if (typeof raw === 'object' && raw !== null) args = raw; // some gateways send parsed JSON
      else {
        try { args = JSON.parse(raw || '{}'); } catch { argsError = 'the arguments are not valid JSON'; }
      }
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? '', args, argsError };
    });
    return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls, finishReason: choice.finish_reason ?? null, usage: json.usage ?? null };
  },
};
