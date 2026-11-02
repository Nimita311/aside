const ANIMATION_SPEEDS = new Set([0, 0.5, 1, 2]);

export type DisplayStyle = 'short' | 'medium' | 'long' | 'full';
export type DateFormat = DisplayStyle | 'iso';
export type TimeFormat = 'locale' | '24h' | '12h';
export interface DateTimePreferences {
  timeFormat: TimeFormat;
  dateFormat?: DateFormat;
  timeStyle?: DisplayStyle;
}

const DISPLAY_STYLES = ['short', 'medium', 'long', 'full'] as const;
export function dateFormat(value: string | null): DateFormat {
  return value === 'iso' || DISPLAY_STYLES.includes(value as DisplayStyle) ? value as DateFormat : 'medium';
}
export function timeStyle(value: string | null): DisplayStyle {
  return DISPLAY_STYLES.includes(value as DisplayStyle) ? value as DisplayStyle : 'short';
}
export function timeFormat(value: string | null): TimeFormat {
  return value === '12h' || value === '24h' ? value : 'locale';
}

export function animationSpeed(value: string | null): number {
  const speed = value === null || value.trim() === '' ? 1 : Number(value);
  return ANIMATION_SPEEDS.has(speed) ? speed : 1;
}
