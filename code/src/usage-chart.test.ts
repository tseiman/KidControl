import { describe, expect, it } from 'vitest';
import { selectedUsageEntry, usageChartModel } from '../public/usage-chart.js';

const history = [
  { day: '2026-07-25', seconds: 0 },
  { day: '2026-07-26', seconds: 900 },
  { day: '2026-07-27', seconds: 1_800 },
  { day: '2026-07-28', seconds: 2_700 },
  { day: '2026-07-29', seconds: 3_600 },
  { day: '2026-07-30', seconds: 4_500 },
  { day: '2026-07-31', seconds: 1_200 }
];

describe('seven-day usage chart model', () => {
  it('localizes weekdays and keeps the current day as the last bar', () => {
    const german = usageChartModel(history, 'de');
    const english = usageChartModel(history, 'en');

    expect(german.bars.map((bar) => bar.label)).toEqual(['Sa', 'So', 'Mo', 'Di', 'Mi', 'Do', 'Fr']);
    expect(english.bars.map((bar) => bar.label)).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(german.bars.at(-1)?.day).toBe('2026-07-31');
  });

  it('derives a useful hour scale from the maximum and preserves proportional bars', () => {
    const model = usageChartModel(history, 'de');

    expect(model.scaleSeconds).toBe(5_400);
    expect(model.bars[5]?.ratio).toBeCloseTo(4_500 / 5_400);
    expect(model.bars[0]?.ratio).toBe(0);
  });

  it('uses a one-hour reference for an all-zero week', () => {
    const model = usageChartModel(history.map((entry) => ({ ...entry, seconds: 0 })), 'en');

    expect(model.scaleSeconds).toBe(3_600);
    expect(model.bars.every((bar) => bar.ratio === 0)).toBe(true);
  });

  it('preserves an available selected day and otherwise selects the current last day', () => {
    const bars = usageChartModel(history, 'de').bars;

    expect(selectedUsageEntry(bars, '2026-07-28')?.day).toBe('2026-07-28');
    expect(selectedUsageEntry(bars, 'missing')?.day).toBe('2026-07-31');
    expect(selectedUsageEntry([], '2026-07-28')).toBeUndefined();
  });
});
