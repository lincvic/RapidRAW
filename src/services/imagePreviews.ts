import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface GeneratePreviewInvokePayload {
  [key: string]: unknown;
  request: {
    path: string;
    jsAdjustments?: JsonObject;
  };
}

export type PreviewInvoke = (command: string, payload: GeneratePreviewInvokePayload) => Promise<Uint8Array>;

const invokePreview: PreviewInvoke = (command, payload) => invoke<Uint8Array>(command, payload);

export function generateEffectivePreviewForPath(
  path: string,
  invokeFn: PreviewInvoke = invokePreview,
): Promise<Uint8Array> {
  const payload: GeneratePreviewInvokePayload = {
    request: { path },
  };
  return invokeFn(Invokes.GeneratePreviewForPath, payload);
}

export function generateExplicitPreviewForPath(
  path: string,
  adjustments: JsonObject,
  invokeFn: PreviewInvoke = invokePreview,
): Promise<Uint8Array> {
  const payload: GeneratePreviewInvokePayload = {
    request: { path, jsAdjustments: adjustments },
  };
  return invokeFn(Invokes.GeneratePreviewForPath, payload);
}
