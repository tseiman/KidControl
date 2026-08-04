const weekdayLabels = {
  de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
};

function scaleFor(maximumSeconds) {
  if (maximumSeconds <= 0) return 3_600;
  const roughStep = maximumSeconds / 4;
  const steps = [300, 900, 1_800, 3_600, 7_200, 14_400, 21_600, 43_200, 86_400];
  const step = steps.find((candidate) => candidate >= roughStep)
    ?? Math.ceil(roughStep / 86_400) * 86_400;
  return Math.max(3_600, Math.ceil(maximumSeconds / step) * step);
}

export function usageChartModel(history, locale) {
  const labels = weekdayLabels[locale] ?? weekdayLabels.en;
  const entries = Array.isArray(history) ? history : [];
  const normalized = entries.map((entry) => ({
    day: String(entry?.day ?? ''),
    seconds: Number.isFinite(entry?.seconds) ? Math.max(0, Math.floor(entry.seconds)) : 0
  }));
  const scaleSeconds = scaleFor(Math.max(0, ...normalized.map((entry) => entry.seconds)));
  return {
    scaleSeconds,
    bars: normalized.map((entry) => {
      const weekday = new Date(`${entry.day}T12:00:00Z`).getUTCDay();
      return {
        ...entry,
        label: labels[weekday] ?? '',
        ratio: Math.min(1, entry.seconds / scaleSeconds)
      };
    })
  };
}
