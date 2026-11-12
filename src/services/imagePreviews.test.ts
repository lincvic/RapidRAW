import { describe, expect, it, vi } from 'vitest';
import { generateEffectivePreviewForPath, generateExplicitPreviewForPath } from './imagePreviews';

const tauriInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(new Uint8Array()));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

type PreviewInvoke = (command: string, payload: Record<string, unknown>) => Promise<Uint8Array>;

describe('image preview requests', () => {
  it('omits adjustments when the backend owns effective preview defaults', async () => {
    const path = '/photos/camera-defaults.raf';
    const effectiveInvoke = vi.fn<PreviewInvoke>().mockResolvedValue(new Uint8Array());

    await generateEffectivePreviewForPath(path, effectiveInvoke);

    expect(effectiveInvoke).toHaveBeenCalledWith('generate_preview_for_path', { request: { path } });
    expect(effectiveInvoke.mock.calls[0][1]).not.toHaveProperty('request.jsAdjustments');
  });

  it('includes caller-owned temporary adjustments in an explicit request', async () => {
    const path = '/photos/temporary.raf';
    const temporaryAdjustments = {
      exposure: 0.75,
      contrast: 1.2,
    };
    const explicitInvoke = vi.fn<PreviewInvoke>().mockResolvedValue(new Uint8Array());

    await generateExplicitPreviewForPath(path, temporaryAdjustments, explicitInvoke);

    expect(explicitInvoke).toHaveBeenCalledWith('generate_preview_for_path', {
      request: { path, jsAdjustments: temporaryAdjustments },
    });
  });

  it('keeps an explicit empty object, as the tethering ghost overlay uses, distinct from backend-owned defaults', async () => {
    const path = '/captures/DSCF0001.RAF';
    const explicitInvoke = vi.fn<PreviewInvoke>().mockResolvedValue(new Uint8Array());

    await generateExplicitPreviewForPath(path, {}, explicitInvoke);

    expect(explicitInvoke).toHaveBeenCalledWith('generate_preview_for_path', { request: { path, jsAdjustments: {} } });
    expect(explicitInvoke.mock.calls[0][1]).toHaveProperty('request.jsAdjustments');
  });

  it('sends the default Tauri invoke the same nested request shape', async () => {
    const path = '/photos/default-invoke.raf';

    await generateEffectivePreviewForPath(path);

    expect(tauriInvoke).toHaveBeenCalledWith('generate_preview_for_path', { request: { path } });
  });
});
