import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface PreviewMetadataResult {
  adjustments?: JsonObject | null;
}

export interface GeneratePreviewInvokePayload {
  [key: string]: unknown;
  request: {
    path: string;
    jsAdjustments: JsonObject;
  };
}

export function generateExplicitPreviewForPath(path: string, adjustments: JsonObject): Promise<Uint8Array> {
  const payload: GeneratePreviewInvokePayload = {
    request: { path, jsAdjustments: adjustments },
  };
  return invoke<Uint8Array>(Invokes.GeneratePreviewForPath, payload);
}
