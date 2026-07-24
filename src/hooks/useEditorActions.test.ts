import { describe, expect, it, vi } from 'vitest';
import { routeResetForSelection } from './useEditorActions';

describe('whole-image reset routing', () => {
  it('reports a loading selected target without invoking any reset path', async () => {
    const resetSelected = vi.fn();
    const resetWithoutSelected = vi.fn();

    await expect(
      routeResetForSelection(
        { isReady: false, path: '/fixtures/loading.RAF' },
        ['/fixtures/loading.RAF'],
        resetSelected,
        resetWithoutSelected,
      ),
    ).rejects.toMatchObject({
      name: 'ResetTargetLoadingError',
      message: expect.stringContaining('loading'),
    });

    expect(resetSelected).not.toHaveBeenCalled();
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });

  it('routes a ready selected target through the authoritative reset callback', async () => {
    const resetSelected = vi.fn(async () => undefined);
    const resetWithoutSelected = vi.fn();

    const ran = await routeResetForSelection(
      { isReady: true, path: '/fixtures/ready.RAF' },
      ['/fixtures/ready.RAF', '/fixtures/other.RAF'],
      resetSelected,
      resetWithoutSelected,
    );

    expect(ran).toBe(true);
    expect(resetSelected).toHaveBeenCalledWith('/fixtures/ready.RAF');
    expect(resetWithoutSelected).not.toHaveBeenCalled();
  });
});
