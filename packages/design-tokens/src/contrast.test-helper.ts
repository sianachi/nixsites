/** WCAG contrast ratio of two 6-digit hex colours. */
export function contrast(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const [red = 0, green = 0, blue = 0] = [1, 3, 5]
      .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [low = 0, high = 0] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}
