/** Signals that an editor image load was superseded or cancelled and must leave the editor untouched. */
export class EditorImageLoadCancelledError extends Error {
  constructor() {
    super('Editor image load was cancelled');
    this.name = 'EditorImageLoadCancelledError';
  }
}
