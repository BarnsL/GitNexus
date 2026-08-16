import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../../src/components/SettingsPanel';
import { i18nReady } from '../../src/i18n';
import {
  isLlmSettingsPersistenceEnabled,
  loadSettings,
  saveSettings,
} from '../../src/core/llm/settings-service';
import { DEFAULT_LLM_SETTINGS } from '../../src/core/llm/types';

describe('SettingsPanel custom provider generation settings', () => {
  beforeEach(async () => {
    await i18nReady;
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
          baseUrl: 'http://127.0.0.1:4853/v1',
          model: 'auto',
          temperature: 0.1,
          maxTokens: 8192,
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves custom temperature and max tokens from the provider form', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isOpen onClose={vi.fn()} />);

    const temperature = screen.getByLabelText('Temperature');
    const maxTokens = screen.getByLabelText('Max Tokens');
    await user.clear(temperature);
    await user.type(temperature, '0.45');
    await user.clear(maxTokens);
    await user.type(maxTokens, '1024');
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(loadSettings().customProviders?.[0]).toMatchObject({
      temperature: 0.45,
      maxTokens: 1024,
    });
  });

  it('returns to the configured default provider when deleting the active custom provider', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<SettingsPanel isOpen onClose={vi.fn()} />);

    await user.click(screen.getByTitle('Delete this custom provider'));
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(loadSettings()).toMatchObject({
      activeProvider: DEFAULT_LLM_SETTINGS.activeProvider,
      customProviders: [],
      activeCustomProviderId: undefined,
    });
  });

  it('applies the remembered API key preference only after settings are saved', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Remember API keys on this device' }));
    expect(isLlmSettingsPersistenceEnabled()).toBe(true);
    expect(localStorage.getItem('gitnexus-llm-settings')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(isLlmSettingsPersistenceEnabled()).toBe(false);
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
    expect(loadSettings()).toMatchObject({ activeProvider: 'custom' });
  });
});
