import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSettings,
  saveSettings,
  setActiveProvider,
  updateProviderSettings,
  getActiveProviderConfig,
  isProviderConfigured,
  clearSettings,
  getProviderDisplayName,
  getAvailableModels,
  getProviderCapabilities,
} from '../../src/core/llm/settings-service';
import {
  getMiniMaxModelCapabilities,
  MINIMAX_ANTHROPIC_BASE_URLS,
  MINIMAX_MODEL_IDS,
} from '../../src/core/llm/types';
import { createChatModel } from '../../src/core/llm/agent';

const SETTINGS_STORAGE_KEY = 'gitnexus-llm-settings';
const PERSISTENCE_STORAGE_KEY = 'gitnexus-llm-settings-persistence';

const freeChainSettings = () => ({
  ...loadSettings(),
  activeProvider: 'custom' as const,
  activeCustomProviderId: 'freechain',
  customProviders: [
    {
      id: 'freechain',
      name: 'FreeChain',
      apiCompatibility: 'openai' as const,
      apiKey: 'fc-test-key',
      baseUrl: 'http://127.0.0.1:4853/v1',
      model: 'auto',
    },
  ],
});

beforeEach(() => {
  localStorage.removeItem(PERSISTENCE_STORAGE_KEY);
});

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
    expect(settings.openai).toBeDefined();
    expect(settings.ollama).toBeDefined();
    expect(settings.minimax).toMatchObject({
      model: MINIMAX_MODEL_IDS[0],
      baseUrl: MINIMAX_ANTHROPIC_BASE_URLS.global_en,
      thinkingMode: 'adaptive',
    });
  });

  it('merges stored values with defaults', () => {
    sessionStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'qwen3-coder:30b' },
      }),
    );

    const settings = loadSettings();
    expect(settings.activeProvider).toBe('ollama');
    expect(settings.ollama.model).toBe('qwen3-coder:30b');
    // Should still have other provider defaults
    expect(settings.openai).toBeDefined();
  });

  it('migrates unsupported legacy MiniMax models to the current default', () => {
    sessionStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'minimax',
        minimax: {
          apiKey: 'minimax-test-key',
          model: 'MiniMax-M2.5',
          temperature: 0.1,
        },
      }),
    );

    const settings = loadSettings();
    expect(settings.minimax).toMatchObject({
      model: MINIMAX_MODEL_IDS[0],
      thinkingMode: 'adaptive',
    });

    const model = createChatModel(getActiveProviderConfig()!) as any;
    expect(model.model).toBe(MINIMAX_MODEL_IDS[0]);
    expect(model.thinking).toEqual({ type: 'adaptive' });
  });

  it('returns defaults on corrupted JSON', () => {
    sessionStorage.setItem('gitnexus-llm-settings', 'not-json{{{');
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
  });

  it('loads durable localStorage settings and mirrors them into the session', () => {
    localStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'migrated-model' },
      }),
    );

    const settings = loadSettings();
    expect(settings.ollama.model).toBe('migrated-model');
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
  });

  it('restores a custom provider from durable storage after a new browser session', () => {
    saveSettings(freeChainSettings());
    sessionStorage.clear();

    expect(loadSettings()).toMatchObject({
      activeProvider: 'custom',
      activeCustomProviderId: 'freechain',
      customProviders: [
        {
          id: 'freechain',
          apiKey: 'fc-test-key',
          baseUrl: 'http://127.0.0.1:4853/v1',
          model: 'auto',
        },
      ],
    });
    expect(sessionStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
  });

  it('does not restore a durable provider after an opt-out', () => {
    localStorage.setItem(PERSISTENCE_STORAGE_KEY, 'false');
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(freeChainSettings()));

    expect(loadSettings().customProviders ?? []).toEqual([]);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('promotes a session-only provider record while remembering is enabled', () => {
    sessionStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(freeChainSettings()));

    expect(loadSettings()).toMatchObject({ activeProvider: 'custom' });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
  });
});

describe('saveSettings / clearSettings', () => {
  it('persists settings to sessionStorage', () => {
    const settings = loadSettings();
    settings.activeProvider = 'anthropic';
    saveSettings(settings);
    expect(loadSettings().activeProvider).toBe('anthropic');
  });

  it('clearSettings removes settings from both storages', () => {
    saveSettings({ ...loadSettings(), activeProvider: 'anthropic' });
    localStorage.setItem(PERSISTENCE_STORAGE_KEY, 'false');
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    clearSettings();
    expect(sessionStorage.getItem('gitnexus-llm-settings')).toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
    expect(localStorage.getItem(PERSISTENCE_STORAGE_KEY)).toBe('false');
  });
});

describe('setActiveProvider', () => {
  it('changes the active provider and persists', () => {
    setActiveProvider('gemini');
    expect(loadSettings().activeProvider).toBe('gemini');
  });
});

describe('getActiveProviderConfig', () => {
  it('returns null for unconfigured providers requiring API keys', () => {
    setActiveProvider('openai');
    expect(getActiveProviderConfig()).toBeNull();
  });

  it('returns config for ollama without API key', () => {
    setActiveProvider('ollama');
    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('ollama');
  });

  it('returns config for openai when API key is set', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: 'sk-test-123' };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
  });

  it('returns config for deepseek when API key is set', () => {
    const settings = loadSettings();
    settings.activeProvider = 'deepseek';
    settings.deepseek = { ...settings.deepseek, apiKey: 'sk-deepseek-123' };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('deepseek');
  });

  it('returns the regional endpoint and thinking mode for MiniMax', () => {
    const settings = loadSettings();
    settings.activeProvider = 'minimax';
    settings.minimax = {
      ...settings.minimax,
      apiKey: 'minimax-test-key',
      model: MINIMAX_MODEL_IDS[0],
      baseUrl: MINIMAX_ANTHROPIC_BASE_URLS.cn_zh,
      thinkingMode: 'disabled',
    };
    saveSettings(settings);

    expect(getActiveProviderConfig()).toMatchObject({
      provider: 'minimax',
      model: MINIMAX_MODEL_IDS[0],
      baseUrl: MINIMAX_ANTHROPIC_BASE_URLS.cn_zh,
      thinkingMode: 'disabled',
    });
  });

  it('returns null for openrouter with empty API key', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openrouter';
    settings.openrouter = { ...settings.openrouter, apiKey: '  ' };
    saveSettings(settings);

    expect(getActiveProviderConfig()).toBeNull();
  });

  it('rejects a custom provider with a blank base URL before it can reach an SDK default', () => {
    saveSettings({
      ...loadSettings(),
      activeProvider: 'custom',
      activeCustomProviderId: 'freechain',
      customProviders: [
        {
          id: 'freechain',
          name: 'FreeChain',
          apiCompatibility: 'openai',
          apiKey: 'fc-test-key',
          baseUrl: '   ',
          model: 'auto',
        },
      ],
    });

    expect(getActiveProviderConfig()).toBeNull();
  });
});

describe('custom provider settings', () => {
  it('persists updates to the selected custom provider without storing the selector as provider data', () => {
    saveSettings({
      ...loadSettings(),
      activeProvider: 'custom',
      activeCustomProviderId: 'freechain',
      customProviders: [
        {
          id: 'freechain',
          name: 'FreeChain',
          apiCompatibility: 'openai',
          apiKey: 'fc-original-key',
          baseUrl: 'http://127.0.0.1:4853/v1',
          model: 'auto',
        },
      ],
    });

    const updated = updateProviderSettings('custom', {
      customProviderId: 'freechain',
      apiKey: 'fc-updated-key',
      temperature: 0.45,
      maxTokens: 1024,
    });

    expect(updated.customProviders?.[0]).toMatchObject({
      apiKey: 'fc-updated-key',
      temperature: 0.45,
      maxTokens: 1024,
    });
    expect(updated.customProviders?.[0]).not.toHaveProperty('customProviderId');
    expect(loadSettings().customProviders?.[0]).toMatchObject({
      apiKey: 'fc-updated-key',
      temperature: 0.45,
      maxTokens: 1024,
    });
  });

  it.each(['openai', 'anthropic'] as const)(
    'throws before creating a %s-compatible chat client with a blank base URL',
    (apiCompatibility) => {
      expect(() =>
        createChatModel({
          provider: 'custom',
          customProviderId: 'freechain',
          apiCompatibility,
          apiKey: 'fc-test-key',
          baseUrl: '  ',
          model: 'auto',
        }),
      ).toThrow('Custom provider base URL is required');
    },
  );

  it('updates the active custom provider when no provider selector is supplied', () => {
    saveSettings({
      ...loadSettings(),
      activeProvider: 'custom',
      activeCustomProviderId: 'freechain',
      customProviders: [
        {
          id: 'freechain',
          name: 'FreeChain',
          apiCompatibility: 'openai',
          apiKey: 'fc-original-key',
          baseUrl: 'http://127.0.0.1:4853/v1',
          model: 'auto',
        },
        {
          id: 'other',
          name: 'Other Provider',
          apiCompatibility: 'openai',
          apiKey: 'other-original-key',
          baseUrl: 'http://127.0.0.1:9000/v1',
          model: 'other',
        },
      ],
    });

    const updated = updateProviderSettings('custom', { apiKey: 'fc-updated-key' });

    expect(updated.customProviders).toMatchObject([
      { id: 'freechain', apiKey: 'fc-updated-key' },
      { id: 'other', apiKey: 'other-original-key' },
    ]);
  });
});

describe('isProviderConfigured', () => {
  it('returns false when provider requires API key and none is set', () => {
    // Manually build a clean openai config with no API key
    saveSettings({
      ...loadSettings(),
      activeProvider: 'openai',
      openai: { apiKey: '', model: 'gpt-4o', temperature: 0.1 },
    });
    expect(isProviderConfigured()).toBe(false);
  });

  it('returns true for ollama (no key required)', () => {
    setActiveProvider('ollama');
    expect(isProviderConfigured()).toBe(true);
  });
});

describe('getProviderDisplayName', () => {
  it('returns human-readable names', () => {
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
    expect(getProviderDisplayName('azure-openai')).toBe('Azure OpenAI');
    expect(getProviderDisplayName('gemini')).toBe('Google Gemini');
    expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
    expect(getProviderDisplayName('ollama')).toBe('Ollama (Local)');
    expect(getProviderDisplayName('openrouter')).toBe('OpenRouter');
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek');
  });
});

describe('getAvailableModels', () => {
  it('returns models for known providers', () => {
    expect(getAvailableModels('openai').length).toBeGreaterThan(0);
    expect(getAvailableModels('ollama').length).toBeGreaterThan(0);
    expect(getAvailableModels('anthropic')).toContain('claude-sonnet-4-20250514');
    expect(getAvailableModels('deepseek')).toContain('deepseek-v4-flash');
    expect(getAvailableModels('minimax')).toEqual([...MINIMAX_MODEL_IDS]);
  });

  it('describes MiniMax model input and thinking capabilities', () => {
    expect(getMiniMaxModelCapabilities(MINIMAX_MODEL_IDS[0])).toEqual({
      contextWindow: 1_000_000,
      inputModalities: ['text', 'image', 'video'],
      thinkingModes: ['adaptive', 'disabled'],
    });
    expect(getMiniMaxModelCapabilities(MINIMAX_MODEL_IDS[1])).toEqual({
      contextWindow: 204_800,
      inputModalities: ['text'],
      thinkingModes: ['always_on'],
    });
  });

  it('returns empty array for unknown provider', () => {
    expect(getAvailableModels('unknown' as any)).toEqual([]);
  });
});

describe('getProviderCapabilities', () => {
  it('enables transcript replay only for providers that require it', () => {
    expect(getProviderCapabilities('deepseek').preserveAssistantTranscript).toBe(true);
    expect(getProviderCapabilities('openai').preserveAssistantTranscript).toBe(false);
    expect(getProviderCapabilities('anthropic').preserveAssistantTranscript).toBe(false);
  });
});
