import type { ExportFormat as AdvertisedExportFormat } from '@nix/api-client';

export type ExportFormat = string;
export type FormatDescriptor = AdvertisedExportFormat;

export function preferredFormat(
  formats: readonly FormatDescriptor[],
): FormatDescriptor | undefined {
  return formats.find((format) => format.lossless) ?? formats[0];
}

export function formatFor(
  formats: readonly FormatDescriptor[],
  value: ExportFormat,
): FormatDescriptor | undefined {
  return formats.find((format) => format.format === value);
}

export function formatPreamble(format: FormatDescriptor): string {
  return format.lossless
    ? `${format.label} preserves the native workspace format.`
    : `${format.label} creates a downloadable document.`;
}
