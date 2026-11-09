import type { AiProvider } from '../providers.ts';
import type { ChatMessage, ChatOptions, ChatResult, ToolDefinition } from '../types.ts';

/** 1x1 transparent PNG: stands in for a screenshot of a client's text. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const PARSE_REQUEST_TOOL: ToolDefinition = {
  name: 'parse_request',
  description: 'Extract the booking request from a client message.',
  parameters: {
    type: 'object',
    properties: {
      client_name: { type: 'string', description: 'Client first name if known' },
      services: { type: 'array', items: { type: 'string' }, description: 'Requested services' },
      date_hint: { type: 'string', description: 'Requested day, verbatim (e.g. "next Friday")' },
      time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] },
    },
    required: ['services', 'date_hint', 'time_of_day'],
    additionalProperties: false,
  },
};

export type ScenarioName = 'text' | 'tool_call' | 'tool_result' | 'error_auth';

export interface ContractScenario {
  name: ScenarioName;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: ChatOptions;
  /** The recorder sends an invalid key to capture a real auth error. */
  invalidKey?: boolean;
  /** Provider-independent expectations every adapter must meet. */
  expect(result: ChatResult): void;
}

type Assert = (condition: boolean, message: string) => void;

const TOOL_CALL_TURN: ChatMessage[] = [
  {
    role: 'system',
    content:
      'You turn salon client texts into structured booking requests. Always call parse_request.',
  },
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Karina texted (screenshot attached): "can I get a balayage + trim next Friday afternoon?"',
      },
      { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 },
    ],
  },
];

export function contractScenarios(assert: Assert): ContractScenario[] {
  return [
    {
      name: 'text',
      messages: [
        { role: 'system', content: 'You are Chairside, a friendly salon assistant. Be brief.' },
        { role: 'user', content: 'Say hi to Karina in five words or fewer.' },
      ],
      tools: [],
      options: { maxOutputTokens: 64, temperature: 0 },
      expect(result) {
        assert(result.type === 'text', 'returns text');
        assert(typeof result.text === 'string' && result.text.length > 0, 'text is non-empty');
        assert(result.toolCalls.length === 0, 'no tool calls');
        assert(result.finishReason === 'stop', 'finishes with stop');
      },
    },
    {
      name: 'tool_call',
      messages: TOOL_CALL_TURN,
      tools: [PARSE_REQUEST_TOOL],
      options: { maxOutputTokens: 256, temperature: 0 },
      expect(result) {
        assert(result.type === 'tool_calls', 'returns tool calls');
        const call = result.toolCalls[0];
        assert(call?.name === 'parse_request', 'calls parse_request');
        assert(typeof call?.id === 'string' && call.id.length > 0, 'tool call has an id');
        const services = call?.arguments.services;
        assert(Array.isArray(services) && services.length > 0, 'arguments are a parsed object');
        assert(result.finishReason === 'tool_calls', 'finishes with tool_calls');
      },
    },
    {
      name: 'tool_result',
      messages: [
        ...TOOL_CALL_TURN,
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_parse_1',
              name: 'parse_request',
              arguments: {
                client_name: 'Karina',
                services: ['balayage', 'trim'],
                date_hint: 'next Friday',
                time_of_day: 'afternoon',
              },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_parse_1',
          name: 'parse_request',
          content: JSON.stringify({ slots: ['Fri 12/18 1:30 PM'] }),
        },
        { role: 'user', content: 'Draft a one-sentence reply offering that slot.' },
      ],
      tools: [PARSE_REQUEST_TOOL],
      options: { maxOutputTokens: 128, temperature: 0 },
      expect(result) {
        assert(result.type === 'text', 'returns text after the tool result');
        assert(result.text !== null && result.text.length > 0, 'reply is non-empty');
      },
    },
    {
      name: 'error_auth',
      messages: [{ role: 'user', content: 'Ping' }],
      tools: [],
      options: { maxOutputTokens: 16 },
      invalidKey: true,
      expect() {
        assert(false, 'an invalid key must throw, not return');
      },
    },
  ];
}

/** Fake keys: used by the recorder for the auth-error scenario and by replay tests. Never valid. */
export const FAKE_KEYS: Record<AiProvider, string> = {
  openai: 'sk-chairside-fake-key-for-contract-tests-0000',
  anthropic: 'sk-ant-chairside-fake-key-for-contract-tests-0000',
  gemini: 'AIzaChairsideFakeKeyForContractTests0000000',
};

export const FIXTURE_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
};

/** On-disk shape of packages/ai/fixtures/<provider>/<scenario>.json */
export interface RecordedFixture {
  provider: AiProvider;
  scenario: ScenarioName;
  model: string;
  source: string;
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}

/** Headers that carry the key; tests assert they are present but fixtures never store them. */
export const AUTH_HEADER: Record<AiProvider, string> = {
  openai: 'authorization',
  anthropic: 'x-api-key',
  gemini: 'x-goog-api-key',
};
