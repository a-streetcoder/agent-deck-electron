import type { nativeImage, NativeImage } from "electron";

export function windowsAttentionPng(count: number): Buffer;
export function windowsAttentionDescription(count: number): string;
export function createWindowsAttentionOverlay(
  imageFactory: typeof nativeImage,
  count: number,
): NativeImage;
